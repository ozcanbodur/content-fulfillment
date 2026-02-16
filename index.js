const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("OK"));

function withTimeout(promise, ms, label = "FLOW_TIMEOUT") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

const WAIT = 10000; // min 10 sn (qty artır/azalt sonrası bekleme)

async function sleep(page, ms) {
  await page.waitForTimeout(ms);
}

function normalizeUom(u) {
  return String(u || "").trim().toUpperCase();
}

async function login(page, username, password) {
  await page.goto("https://www.mybidfood.com.tr/", { waitUntil: "domcontentloaded" });

  const pass = page.locator('input[type="password"]').first();
  const user = page.locator('input[type="text"], input[type="email"]').first();

  const hasLoginForm = await pass.isVisible().catch(() => false);

  if (hasLoginForm) {
    await user.fill(username);
    await pass.fill(password);
    await pass.press("Enter").catch(() => {});
  }

  await page.waitForTimeout(1500);

  const passStillVisible = await pass.isVisible().catch(() => false);
  const currentUrl = page.url();

  const logoutLike = page.locator('text=/çıkış|logout|sign out/i');
  const hasLogout = (await logoutLike.count().catch(() => 0)) > 0;

  const errorLike = page.locator('text=/hatalı|yanlış|error|invalid/i');
  const hasError = (await errorLike.count().catch(() => 0)) > 0;

  const loggedIn = (!passStillVisible && hasLoginForm) || hasLogout;

  return { hasLoginForm, passStillVisible, hasLogout, hasError, currentUrl, loggedIn };
}

async function gotoProductSearch(page, productCode) {
  const productUrl = `https://www.mybidfood.com.tr/#/products/search/?searchTerm=${encodeURIComponent(
    productCode
  )}&category=All&page=1&useUrlParams=true`;

  await page.goto(productUrl, { waitUntil: "domcontentloaded" });

  // SPA render + ürün listesi için min bekleme
  await sleep(page, 1500);

  // ürün tbody görünene kadar bekle
  const rowSel = `#product-list-${productCode}`;
  await page.waitForSelector(rowSel, { timeout: 60000 }).catch(() => null);

  return productUrl;
}

async function addOneItem(page, item) {
  const productCode = String(item.productCode || "").trim();
  const uomWanted = normalizeUom(item.uom);
  const qtyWanted = Math.max(1, parseInt(item.qty ?? 1, 10) || 1);

  if (!productCode) return { ok: false, error: "productCode zorunlu" };
  if (!uomWanted) return { ok: false, productCode, error: "uom zorunlu (ADET/KOLİ...)" };

  const productUrl = await gotoProductSearch(page, productCode);

  const row = page.locator(`#product-list-${productCode}`).first();
  if ((await row.count()) === 0) {
    return { ok: false, status: 404, productCode, uom: uomWanted, error: `Ürün bloğu yok: ${productCode}`, productUrl };
  }

  // UOM listesi (debug/response için)
  const availableUoms = await row.evaluate((tbody) => {
    const out = [];
    const trs = Array.from(tbody.querySelectorAll("tr"));
    for (const tr of trs) {
      const typeEl = tr.querySelector(".UOM .type");
      const u = (typeEl?.textContent || "").trim().toUpperCase();
      if (u) out.push(u);
    }
    return Array.from(new Set(out));
  });

  if (!availableUoms.includes(uomWanted)) {
    return {
      ok: false,
      status: 404,
      productCode,
      uom: uomWanted,
      error: `UOM bulunamadı: ${uomWanted}`,
      availableUoms,
      productUrl,
    };
  }

  // İstenen UOM satırının TR scope’u
  const scopeHandle = await row.evaluateHandle((tbody, uomUpper) => {
    const typeEls = Array.from(tbody.querySelectorAll(".UOM .type"));
    const match = typeEls.find((el) => (el.textContent || "").trim().toUpperCase() === uomUpper);
    if (!match) return null;
    return match.closest("tr");
  }, uomWanted);

  const scopeEl = scopeHandle.asElement();
  if (!scopeEl) {
    return { ok: false, status: 404, productCode, uom: uomWanted, error: `UOM scope bulunamadı: ${uomWanted}`, availableUoms, productUrl };
  }

  // scope içinde querySelector helper
  const q = async (selector) => {
    const h = await scopeHandle.evaluateHandle((root, sel) => root.querySelector(sel), selector);
    return h.asElement();
  };

  const getInput = () => q('input[data-cy="click-input-qty"]');
  const getPlus  = () => q('button[data-cy="click-increase-qtyprice"]');
  const getMinus = () => q('button[data-cy="click-decrease-qtyprice"]');
  const getAdd   = () => q('button[data-cy="click-set-add-stateprice"]');

  const readQty = async () => {
    const inp = await getInput();
    if (!inp) return null;
    const v = await inp.evaluate((n) => parseInt(n.value || "0", 10));
    return Number.isFinite(v) ? v : null;
  };

  // 1) önce "Ekle" ile qty alanını açtır
  const addBtn = await getAdd();
  if (!addBtn) {
    return { ok: false, status: 500, productCode, uom: uomWanted, error: "Add/Ekle butonu yok", availableUoms, productUrl };
  }

  await addBtn.click({ force: true });
  await sleep(page, WAIT);

  // input görünür değilse biraz daha bekle
  let cur = await readQty();
  if (cur === null) {
    await sleep(page, WAIT);
    cur = await readQty();
  }

  // 2) 1'e indir (garanti başlangıç)
  let safety = 40;
  while (safety-- > 0) {
    const now = await readQty();
    if (now === null || now <= 1) break;
    const minus = await getMinus();
    if (!minus) break;
    await minus.click({ force: true });
    await sleep(page, WAIT);
  }

  // 3) hedefe çık (hedef olunca DUR)
  let guard = 160;
  while (guard-- > 0) {
    const now = await readQty();

    if (now === qtyWanted) break;

    if (now === null) {
      // input kaybolduysa tekrar "Ekle" tıkla
      await addBtn.click({ force: true }).catch(() => {});
      await sleep(page, WAIT);
      continue;
    }

    if (now < qtyWanted) {
      const plus = await getPlus();
      if (!plus) return { ok: false, status: 500, productCode, uom: uomWanted, error: "Plus yok", availableUoms, productUrl };
      await plus.click({ force: true });
      await sleep(page, WAIT);
      continue;
    }

    // now > qtyWanted
    const minus = await getMinus();
    if (!minus) return { ok: false, status: 500, productCode, uom: uomWanted, error: "Minus yok", availableUoms, productUrl };
    await minus.click({ force: true });
    await sleep(page, WAIT);
  }

  const finalQty = await readQty();

  return {
    ok: finalQty === qtyWanted,
    productCode,
    uom: uomWanted,
    requestedQty: qtyWanted,
    finalQty,
    productUrl,
    note: "Akış: login -> search -> UOM satırı seçildi -> Ekle ile qty alanı açıldı -> +/- ile hedef qty'ye gelince durdu.",
  };
}

/**
 * ✅ Checkout / Delivery adımı:
 * - https://www.mybidfood.com.tr/#/checkout/delivery 'e gider
 * - 10sn bekler
 * - orderreference input'a ORDER_REF yazar
 * - delivery-date-dropdown'dan DELIVERY_DATE_TEXT içeren tarihi seçer
 */
async function completeCheckoutDelivery(page, { orderRef, deliveryDateText }) {
  const DELIVERY_URL = "https://www.mybidfood.com.tr/#/checkout/delivery";
  const ORDER_REF = String(orderRef || "").trim();
  const DELIVERY_DATE_TEXT = String(deliveryDateText || "").trim();

  if (!ORDER_REF) return { ok: false, error: "orderRef zorunlu (örn: 39-1221429)" };
  if (!DELIVERY_DATE_TEXT) return { ok: false, error: "deliveryDateText zorunlu (örn: 21 Şubat 2026)" };

  await page.goto(DELIVERY_URL, { waitUntil: "domcontentloaded" });

  // Angular sayfanın oturması için 10sn
  await sleep(page, 10000);

  // 1) Sipariş referansı
  const ref = page.locator('input[name="orderreference"]').first();
  await ref.waitFor({ state: "visible", timeout: 60000 });

  await ref.click({ force: true });
  // fill() Angular input eventlerini tetikler, en stabil yöntem
  await ref.fill(ORDER_REF);
  // blur/commit
  await page.keyboard.press("Tab").catch(() => {});
  await sleep(page, 300);

  // 2) Dropdown aç ve tarih seç
  const ddBtn = page.locator('[data-cy="delivery-date-dropdown"]').first();
  await ddBtn.waitFor({ state: "visible", timeout: 60000 });

  await ddBtn.click({ force: true });
  await sleep(page, 400);

  const menu = page.locator('ul[data-cy="delivery-date-menu"]').first();
  await menu.waitFor({ state: "visible", timeout: 60000 });

  const hitLi = menu.locator("li", { hasText: DELIVERY_DATE_TEXT }).first();

  if ((await hitLi.count()) === 0) {
    // debug için mevcut seçenekler
    const options = await menu.locator("li").allTextContents().catch(() => []);
    return {
      ok: false,
      status: 404,
      error: `Tarih bulunamadı: ${DELIVERY_DATE_TEXT}`,
      availableDates: options.map((t) => (t || "").trim()).filter(Boolean),
      url: DELIVERY_URL,
    };
  }

  await hitLi.scrollIntoViewIfNeeded().catch(() => {});
  await hitLi.click({ force: true });
  await sleep(page, 600);

  // doğrulama amaçlı buton text
  const afterText = (await ddBtn.innerText().catch(() => "")).trim();

  return {
    ok: true,
    url: DELIVERY_URL,
    orderRef: ORDER_REF,
    deliveryDateText: DELIVERY_DATE_TEXT,
    dropdownTextAfter: afterText,
    note: "Akış: checkout/delivery -> 10sn bekle -> Sipariş Referansı yaz -> Sevk Tarihi seç.",
  };
}

// ✅ LOGIN TEST
app.post("/login-test", async (req, res) => {
  const { username, password } = req.body || {};

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(20000);

  try {
    const result = await withTimeout(login(page, username, password), 25000);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// ✅ TEK ÜRÜN: add-to-cart (+ opsiyonel checkout/delivery)
app.post("/add-to-cart", async (req, res) => {
  const { username, password, productCode, uom, qty, orderRef, deliveryDateText } = req.body || {};

  if (!username || !password) return res.status(400).json({ ok: false, error: "username/password zorunlu" });
  if (!productCode || !uom) return res.status(400).json({ ok: false, error: "productCode/uom zorunlu" });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  try {
    const loginResult = await withTimeout(login(page, username, password), 60000);
    if (!loginResult.loggedIn) return res.status(401).json({ ok: false, step: "login", ...loginResult });

    const itemResult = await withTimeout(
      addOneItem(page, { productCode, uom, qty }),
      180000,
      "ADD_TO_CART_TIMEOUT"
    );

    let checkoutResult = null;
    if (orderRef && deliveryDateText) {
      checkoutResult = await withTimeout(
        completeCheckoutDelivery(page, { orderRef, deliveryDateText }),
        180000,
        "CHECKOUT_DELIVERY_TIMEOUT"
      );
    }

    return res.json({
      ok: itemResult.ok && (!checkoutResult || checkoutResult.ok),
      item: itemResult,
      checkout: checkoutResult,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// ✅ ÇOKLU ÜRÜN: batch (+ opsiyonel checkout/delivery)
app.post("/add-to-cart-batch", async (req, res) => {
  const { username, password, items, stopOnError = true, orderRef, deliveryDateText } = req.body || {};

  if (!username || !password) return res.status(400).json({ ok: false, error: "username/password zorunlu" });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ ok: false, error: "items[] zorunlu" });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  try {
    const loginResult = await withTimeout(login(page, username, password), 60000);
    if (!loginResult.loggedIn) return res.status(401).json({ ok: false, step: "login", ...loginResult });

    const results = [];
    for (const it of items) {
      const r = await withTimeout(addOneItem(page, it), 180000, "ITEM_TIMEOUT");
      results.push(r);

      if (!r.ok && stopOnError) break;

      // ürünler arası kısa nefes (SPA stabilize)
      await sleep(page, 1500);
    }

    const summary = {
      total: items.length,
      done: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };

    let checkoutResult = null;
    if (orderRef && deliveryDateText) {
      checkoutResult = await withTimeout(
        completeCheckoutDelivery(page, { orderRef, deliveryDateText }),
        180000,
        "CHECKOUT_DELIVERY_TIMEOUT"
      );
    }

    const overallOk =
      (summary.failed === 0 || !stopOnError) && (!checkoutResult || checkoutResult.ok);

    return res.json({
      ok: overallOk,
      summary,
      results,
      checkout: checkoutResult,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
