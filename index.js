import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// -------------------- utils --------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowTs() {
  return Date.now();
}

function cleanStr(s) {
  return (s || "").toString().trim();
}

function normalizeTr(s) {
  return cleanStr(s)
    .toLowerCase()
    .replaceAll("İ", "i")
    .replaceAll("I", "i")
    .replaceAll("ı", "i")
    .replaceAll("Ş", "s")
    .replaceAll("ş", "s")
    .replaceAll("Ğ", "g")
    .replaceAll("ğ", "g")
    .replaceAll("Ü", "u")
    .replaceAll("ü", "u")
    .replaceAll("Ö", "o")
    .replaceAll("ö", "o")
    .replaceAll("Ç", "c")
    .replaceAll("ç", "c");
}

// -------------------- job store --------------------
const jobs = new Map();

function createJob() {
  const jobId = Math.random().toString(16).slice(2, 18);
  const job = {
    ok: true,
    jobId,
    status: "running",
    createdAt: nowTs(),
    updatedAt: nowTs(),
    result: null,
  };
  jobs.set(jobId, job);
  return job;
}

function setJobResult(jobId, result, status = "done") {
  const job = jobs.get(jobId);
  if (!job) return;
  job.result = result;
  job.status = status;
  job.updatedAt = nowTs();
}

// -------------------- selectors/helpers for product qty --------------------
async function waitForAngularReady(page, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ready = await page.evaluate(() => {
      // basic: document ready + angular root exists
      const rs = document.readyState;
      const appRoot = document.querySelector('[ng-app], [data-ng-app], [ng-controller], [data-ng-controller], [ui-view], [data-ui-view]');
      return rs === "complete" && !!appRoot;
    }).catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function login(page, username, password) {
  // NOTE: login ekranı zaten session yoksa çıkar; aksi halde login atlanabilir.
  await page.goto("https://www.mybidfood.com.tr/#/login", { waitUntil: "domcontentloaded" });
  await waitForAngularReady(page, 20000);

  // Login form varsa doldur
  const userSel = 'input[name="username"], input[type="text"][ng-model*="user"]';
  const passSel = 'input[name="password"], input[type="password"][ng-model*="pass"]';

  const userInp = page.locator(userSel).first();
  const passInp = page.locator(passSel).first();

  const hasLogin = await userInp.isVisible().catch(() => false);

  if (hasLogin) {
    await userInp.fill(username);
    await passInp.fill(password);

    // submit
    const btn = page.locator('button[type="submit"], button[data-cy="click-login"]').first();
    await btn.click().catch(() => {});
    // login sonrası landing
    await page.waitForTimeout(2000);
  }

  // Session oluştu mu? Menü/başlık görünsün
  await page.waitForTimeout(2000);
  return true;
}

async function gotoSearch(page, productCode) {
  const url = `https://www.mybidfood.com.tr/#/products/search/?searchTerm=${encodeURIComponent(productCode)}&category=All&page=1&useUrlParams=true`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForAngularReady(page, 20000);

  // Ürün listesi gelene kadar biraz bekle (Angular + fiyat çağrıları)
  await page.waitForTimeout(4000);
  return url;
}

async function findUomRowHandle(page, productCode, uom) {
  // Ürün bloğu
  const rowSel = `#product-list-${productCode}`;
  await page.waitForSelector(rowSel, { timeout: 20000 });
  const row = page.locator(rowSel).first();

  // UOM satırları arasında hedefi bul
  // DOM: .UOM .type içinde "ADET" / "KOLİ" yazıyor
  const target = normalizeTr(uom);

  // row içinde tüm UOM type elementleri
  const typeEls = row.locator(".UOM .type");
  const count = await typeEls.count();

  let hitIndex = -1;
  for (let i = 0; i < count; i++) {
    const txt = normalizeTr(await typeEls.nth(i).innerText().catch(() => ""));
    if (txt === target) {
      hitIndex = i;
      break;
    }
  }

  if (hitIndex === -1) {
    // mevcut uomları listele
    const uoms = [];
    for (let i = 0; i < count; i++) uoms.push((await typeEls.nth(i).innerText().catch(() => "")).trim());
    return { ok: false, status: 404, error: `UOM bulunamadı: ${uom}`, availableUoms: uoms };
  }

  // type elementin en yakın tr'si
  const tr = typeEls.nth(hitIndex).locator("xpath=ancestor::tr[1]");
  return { ok: true, tr };
}

async function ensureQtyControlsOpen(page, tr) {
  // Add (Ekle) butonu varsa bir kere tıkla ki +/- ve input çıksın
  // Bazı ekranlarda add butonu data-cy="click-add-to-cart" olabilir
  const addBtn = tr.locator('button:has-text("Ekle"), button[data-cy*="add"], button[data-cy*="click-add"]');
  const hasAdd = await addBtn.first().isVisible().catch(() => false);

  // input görünmüyorsa add'e tıkla
  const qtyInput = tr.locator('input[data-cy="click-input-qty"]');
  const inputVisible = await qtyInput.first().isVisible().catch(() => false);

  if (!inputVisible && hasAdd) {
    await addBtn.first().click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  // input görünür olana kadar bekle
  await qtyInput.first().waitFor({ state: "visible", timeout: 20000 });
  return true;
}

async function readQty(tr) {
  const inp = tr.locator('input[data-cy="click-input-qty"]').first();
  const v = await inp.inputValue().catch(() => "");
  const n = parseInt((v || "0").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

async function clickPlus(tr) {
  const plus = tr.locator('button[data-cy="click-increase-qtyprice"], button[data-cy*="increase"]').first();
  await plus.click();
}

async function clickMinus(tr) {
  const minus = tr.locator('button[data-cy="click-decrease-qtyprice"], button[data-cy*="decrease"]').first();
  await minus.click();
}

async function setQtyOnRow(page, tr, targetQty) {
  await ensureQtyControlsOpen(page, tr);

  // güvenli başlangıç: 1'e indir
  let safety = 40;
  while (safety-- > 0) {
    const cur = await readQty(tr);
    if (cur === null || cur <= 1) break;
    await clickMinus(tr).catch(() => {});
    await page.waitForTimeout(1200);
  }

  // hedefe çık / in
  let guard = 120;
  while (guard-- > 0) {
    const cur = await readQty(tr);
    if (cur === targetQty) return { ok: true, finalQty: cur };

    if (cur === null) return { ok: false, error: "Qty input okunamadı" };

    if (cur < targetQty) {
      await clickPlus(tr).catch(() => {});
      await page.waitForTimeout(1200);
      continue;
    }

    if (cur > targetQty) {
      await clickMinus(tr).catch(() => {});
      await page.waitForTimeout(1200);
      continue;
    }
  }

  return { ok: false, error: "Hedefe ulaşılamadı", finalQty: await readQty(tr) };
}

async function addOneItem(page, productCode, uom, qty) {
  const productUrl = await gotoSearch(page, productCode);

  // Ürün bloğu var mı?
  const rowSel = `#product-list-${productCode}`;
  const exists = await page.locator(rowSel).first().isVisible().catch(() => false);
  if (!exists) {
    return { ok: false, status: 404, productCode, uom, error: `Ürün bloğu yok: ${productCode}`, productUrl };
  }

  const rowRes = await findUomRowHandle(page, productCode, uom);
  if (!rowRes.ok) {
    return { ...rowRes, productCode, uom, productUrl };
  }

  const setRes = await setQtyOnRow(page, rowRes.tr, qty);
  if (!setRes.ok) {
    return { ok: false, status: 500, productCode, uom, requestedQty: qty, productUrl, ...setRes };
  }

  return {
    ok: true,
    productCode,
    uom,
    requestedQty: qty,
    finalQty: setRes.finalQty,
    productUrl,
    note: "Akış: login -> search -> UOM satırı seçildi -> Ekle ile qty alanı açıldı -> +/- ile hedef qty'ye gelince durdu.",
  };
}

// -------------------- checkout / delivery / submit --------------------
async function gotoDelivery(page) {
  const deliveryUrl = "https://www.mybidfood.com.tr/#/checkout/delivery";
  await page.goto(deliveryUrl, { waitUntil: "domcontentloaded" });
  await waitForAngularReady(page, 20000);
  // Angular'ın oturması için
  await page.waitForTimeout(10000);
  return deliveryUrl;
}

async function setOrderReference(page, orderRef) {
  const ref = page.locator('input[name="orderreference"]').first();
  await ref.waitFor({ state: "visible", timeout: 30000 });

  // gerçek input akışı (Angular ng-model trigger)
  await ref.click().catch(() => {});
  await page.waitForTimeout(150);

  // select all + clear
  await page.keyboard.down("Control").catch(() => {});
  await page.keyboard.press("KeyA").catch(() => {});
  await page.keyboard.up("Control").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.waitForTimeout(80);

  await ref.type(orderRef, { delay: 20 });
  await ref.dispatchEvent("change").catch(() => {});
  await ref.dispatchEvent("blur").catch(() => {});
  await page.waitForTimeout(300);

  const v = await ref.inputValue().catch(() => "");
  return { ok: normalizeTr(v) === normalizeTr(orderRef), value: v };
}

async function selectDeliveryDate(page, deliveryDateText) {
  const btn = page.locator('[data-cy="delivery-date-dropdown"]').first();
  await btn.waitFor({ state: "visible", timeout: 30000 });

  await btn.click().catch(() => {});
  await page.waitForTimeout(500);

  const menu = page.locator('ul[data-cy="delivery-date-menu"]').first();
  await menu.waitFor({ state: "visible", timeout: 30000 });

  // li tıkla (ng-click li’de)
  const lis = menu.locator("li");
  const cnt = await lis.count();

  let hit = -1;
  const target = cleanStr(deliveryDateText);
  for (let i = 0; i < cnt; i++) {
    const t = cleanStr(await lis.nth(i).innerText().catch(() => ""));
    if (t.includes(target)) {
      hit = i;
      break;
    }
  }

  if (hit === -1) {
    const opts = [];
    for (let i = 0; i < cnt; i++) opts.push(cleanStr(await lis.nth(i).innerText().catch(() => "")));
    return { ok: false, error: `tarih bulunamadı: ${deliveryDateText}`, options: opts };
  }

  await lis.nth(hit).scrollIntoViewIfNeeded().catch(() => {});
  await lis.nth(hit).click().catch(() => {});
  await page.waitForTimeout(700);

  // dropdown text güncellendi mi?
  const after = cleanStr(await btn.innerText().catch(() => ""));
  const ok = after.includes(target);
  return { ok, afterText: after };
}

async function clickSubmit(page) {
  // Not: Bu buton <div> olduğu için Playwright'ın "disabled" algısı yok.
  // Ayrıca bazı viewport'larda canlı destek/overlay üstüne binebiliyor.
  // Bu yüzden:
  //  - görünür + tıklanabilir olana kadar bekle
  //  - scrollIntoView
  //  - mümkünse normal click, olmazsa DOM event zinciriyle (page.evaluate) tıkla
  const sel = 'div[data-cy^="click-submit-order"]';
  const btn = page.locator(sel).first();

  await btn.waitFor({ state: "visible", timeout: 60000 });

  // "disabled" class'ı varsa (ng-disabled) kalkana kadar bekle
  const start = Date.now();
  while (Date.now() - start < 60000) {
    const isDisabled = await btn.evaluate((el) => {
      const cls = (el.className || "").toLowerCase();
      // ng-disabled div’de genelde 'disabled' class'ı bırakıyor
      return cls.includes("disabled") || el.getAttribute("aria-disabled") === "true";
    }).catch(() => false);

    if (!isDisabled) break;
    await page.waitForTimeout(250);
  }

  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(250);

  try {
    await btn.click({ timeout: 5000 });
    return { ok: true, note: "submit clicked (playwright)" };
  } catch (e) {
    // fallback: DOM event zinciri
    const ok = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.scrollIntoView({ block: "center", inline: "center" });

      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // element üstünde başka bir şey var mı kontrol et
      const top = document.elementFromPoint(cx, cy);
      // Eğer üstte başka bir overlay varsa yine de click dene (Angular click handler elementte)
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    }, sel).catch(() => false);

    return { ok, note: ok ? "submit clicked (evaluate fallback)" : `submit click failed: ${String(e)}` };
  }
}

async function waitForConfirmation(page) {
  // URL route değişimi
  try {
    await page.waitForURL(/#\/checkout\/confirmation/, { timeout: 120000 });
    return { ok: true, confirmationUrl: page.url() };
  } catch (e) {
    // ignore
  }

  const url = page.url();

  // fallback: sayfa içinde confirmation'a özgü bir ipucu ara
  // (metinler ortam / dil / tema ile değişebiliyor; birkaç ihtimali birlikte deniyoruz)
  const hint = page.locator('text=/Order Confirmation|Sipariş Onayı|Siparişiniz|Teşekkürler|Onay|Başarı|Siparişiniz alınmıştır/i').first();
  const hasHint = await hint.isVisible().catch(() => false);
  return { ok: hasHint, confirmationUrl: url };
}

async function runCheckout(page, { orderRef, deliveryDateText, submit }) {
  const out = {
    ok: true,
    deliveryUrl: "https://www.mybidfood.com.tr/#/checkout/delivery",
    orderRef,
    deliveryDateText,
    submit: !!submit,
    orderRefSet: false,
    deliveryDateSelected: false,
    submitted: false,
    confirmationUrl: null,
  };

  try {
    await gotoDelivery(page);

    // 1) order ref
    const refRes = await setOrderReference(page, orderRef);
    out.orderRefSet = !!refRes.ok;

    // 2) date
    const dateRes = await selectDeliveryDate(page, deliveryDateText);
    out.deliveryDateSelected = !!dateRes.ok;

    if (!submit) {
      out.ok = true;
      out.confirmationUrl = page.url();
      return out;
    }

    // 3) submit
    const submitRes = await clickSubmit(page);
    out.submitClick = submitRes;

    await page.waitForTimeout(2000);
    const conf = await waitForConfirmation(page);
    out.submitted = !!conf.ok;
    out.confirmationUrl = conf.confirmationUrl;

    if (!out.submitted) {
      out.ok = false;
      out.status = 500;
      out.error = "Submit sonrası confirmation görülmedi";
      return out;
    }

    out.ok = true;
    return out;
  } catch (e) {
    out.ok = false;
    out.status = 500;
    out.error = String(e);
    out.confirmationUrl = page.url().catch ? null : page.url();
    return out;
  }
}

// -------------------- endpoints --------------------
app.get("/", (req, res) => res.json({ ok: true, service: "content-fulfillment" }));

app.get("/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job bulunamadı" });
  res.json(job);
});

app.post("/add-to-cart", async (req, res) => {
  const { username, password, productCode, uom, qty } = req.body || {};
  if (!username || !password || !productCode || !uom || !qty) {
    return res.status(400).json({ ok: false, error: "username, password, productCode, uom, qty zorunlu" });
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();

  try {
    await login(page, username, password);
    const result = await addOneItem(page, productCode, uom, qty);
    await browser.close();

    res.json({
      ok: result.ok,
      productCode,
      uom,
      requestedQty: qty,
      finalQty: result.finalQty ?? null,
      productUrl: result.productUrl,
      note: result.note,
      error: result.ok ? undefined : result.error,
      status: result.status,
      availableUoms: result.availableUoms,
    });
  } catch (e) {
    await browser.close().catch(() => {});
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/add-to-cart-batch", async (req, res) => {
  const { username, password, items, stopOnError = true, checkout } = req.body || {};
  if (!username || !password || !Array.isArray(items) || items.length < 1) {
    return res.status(400).json({ ok: false, error: "username, password, items[] zorunlu" });
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();

  const results = [];
  let done = 0;
  let failed = 0;

  try {
    await login(page, username, password);

    for (const it of items) {
      const productCode = it.productCode;
      const uom = it.uom;
      const qty = it.qty;

      const r = await addOneItem(page, productCode, uom, qty);
      results.push(r);

      if (r.ok) done++;
      else {
        failed++;
        if (stopOnError) break;
      }
    }

    let checkoutResult = null;
    if (checkout && checkout.submit) {
      const orderRef = cleanStr(checkout.orderRef || "AUTO");
      const deliveryDateText = cleanStr(checkout.deliveryDateText || "");
      if (!deliveryDateText) {
        checkoutResult = { ok: false, status: 400, error: "checkout.deliveryDateText zorunlu", orderRef, deliveryDateText };
      } else {
        checkoutResult = await runCheckout(page, { orderRef, deliveryDateText, submit: true });
      }
    }

    await browser.close();

    const ok = failed === 0 && (!checkoutResult || checkoutResult.ok);

    res.json({
      ok,
      summary: { total: items.length, done, failed },
      results,
      checkoutResult,
    });
  } catch (e) {
    await browser.close().catch(() => {});
    res.status(500).json({ ok: false, error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ server listening on :${PORT}`));
