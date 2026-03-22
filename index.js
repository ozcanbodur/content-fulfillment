const express = require("express");
const { chromium } = require("playwright");
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

app.get("/", (req, res) => res.send("OK"));

// =========================
// KULLANICI HAVUZU (POOL)
// Şifreler Railway Variables'tan okunur, koda yazılmaz.
// =========================
const USER_POOLS = {
  AVRUPA: [
    { username: process.env.AVRUPA1_USERNAME, password: process.env.AVRUPA1_PASSWORD },
    { username: process.env.AVRUPA2_USERNAME, password: process.env.AVRUPA2_PASSWORD },
  ],
  ASYA: [
    { username: process.env.ASYA1_USERNAME, password: process.env.ASYA1_PASSWORD },
    { username: process.env.ASYA2_USERNAME, password: process.env.ASYA2_PASSWORD },
  ],
};

// Kullanıcı kilit durumu: username -> true (meşgul) / false (boş)
const userBusy = {};
for (const pool of Object.values(USER_POOLS)) {
  for (const u of pool) {
    if (u.username) userBusy[u.username] = false;
  }
}

// Bölge bazlı bekleme kuyruğu
const waitQueues = { AVRUPA: [], ASYA: [] };

/**
 * Bölge için boşta bir kullanıcı varsa hemen döner.
 * Yoksa boşalana kadar bekler (max 10 dakika).
 */
function acquireUser(region) {
  const pool = USER_POOLS[region];
  if (!pool) return Promise.reject(new Error(`Bilinmeyen bölge: ${region}`));

  const free = pool.find((u) => u.username && !userBusy[u.username]);
  if (free) {
    userBusy[free.username] = true;
    console.log(`[POOL] ${region}: ${free.username} alındı (anlık)`);
    return Promise.resolve(free);
  }

  console.log(`[POOL] ${region}: tüm kullanıcılar meşgul, kuyrukta bekleniyor...`);
  return new Promise((resolve, reject) => {
    waitQueues[region].push({ resolve, reject });
  });
}

/**
 * İş bittikten sonra kullanıcıyı serbest bırak.
 * Kuyrukta bekleyen varsa ona devret.
 */
function releaseUser(region, username) {
  const queue = waitQueues[region];
  if (queue && queue.length > 0) {
    const waiter = queue.shift();
    const cred = USER_POOLS[region].find((u) => u.username === username);
    console.log(`[POOL] ${region}: ${username} → kuyruktan bekleyene devredildi`);
    waiter.resolve(cred);
  } else {
    userBusy[username] = false;
    console.log(`[POOL] ${region}: ${username} serbest bırakıldı`);
  }
}

// =========================
// ADRES -> BÖLGE HARİTASI
// =========================
const ADDRESS_REGION = {
  // === AVRUPA ===
  "ÖZDİLEK AVM":          "AVRUPA",
  "WELLDONE NİŞANTAŞI":   "AVRUPA",
  "WELLDONE TÜNEL":        "AVRUPA",
  "WELLDONE ZORLU":        "AVRUPA",
  "MALL OF İSTANBUL":      "AVRUPA",
  "MARMARA FORUM":         "AVRUPA",
  "AKBATI":                "AVRUPA",
  "AKMERKEZ":              "AVRUPA",
  "ASTORIA":               "AVRUPA",
  "ATAKÖY A PLUS":         "AVRUPA",
  "BEBEK":                 "AVRUPA",
  "BEYOĞLU":               "AVRUPA",
  "CAPACITY":              "AVRUPA",
  "ETILER":                "AVRUPA",
  "FLORYA":                "AVRUPA",
  "FORUM ISTABUL":         "AVRUPA",
  "FORUM İSTANBUL":        "AVRUPA",
  "KIRINTI BEBEK":         "AVRUPA",
  "KIRINTI BEYLİKDÜZÜ":   "AVRUPA",
  "KIRINTI NİŞANTAŞI":    "AVRUPA",
  "KIRINTI TEMAWORD":      "AVRUPA",
  "KIRINTI TEMA":          "AVRUPA",
  "ORTAKÖY":               "AVRUPA",
  "TRUMP TOWERS":          "AVRUPA",
  "TÜNEL":                 "AVRUPA",
  "TEMAWORD":              "AVRUPA",
  "WELLDONE KANYON":       "AVRUPA",
  "NİŞANTAŞI":             "AVRUPA",
  "MİDPOİNT  BEYOĞLU":    "AVRUPA",

  // === ASYA ===
  "SUADİYE MİDPOİNT":     "ASYA",
  "KIRINTI HILLTOWN 153":  "ASYA",
  "KIRINTI ERENKÖY":       "ASYA",
  "METROPOL":              "ASYA",
  "WELLDONE AKASYA":       "ASYA",
  "MALTEPE PARK":          "ASYA",
  "MERKEZ OFİS":           "ASYA",
  "Caddebostan":           "ASYA",
  "FENERBAHÇE":            "ASYA",
  "ERENKÖY":               "ASYA",
  "WATER GARDEN":          "ASYA",
  "PALLADIUM":             "ASYA",
  "RÖNESANS PİAZZA":       "ASYA",
  "AKASYA AVM":            "ASYA",
  "BUYAKA":                "ASYA",
  "İSTMARİNA":             "ASYA",
  "WELLDONE SUADİYE":      "ASYA",
  "HİLLTOWN -183":         "ASYA",
};

function getRegionForAddress(address) {
  if (!address) return null;
  if (ADDRESS_REGION[address]) return ADDRESS_REGION[address];
  const upper = address.toUpperCase();
  for (const [key, region] of Object.entries(ADDRESS_REGION)) {
    if (key.toUpperCase() === upper) return region;
  }
  return null;
}

// =========================
// HELPERS
// =========================
function withTimeout(promise, ms, label = "FLOW_TIMEOUT") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

const WAIT_STEP_MS = 10000;
const BASE_URL = "https://www.mybidfood.com.tr";

async function sleep(page, ms) {
  await page.waitForTimeout(ms);
}

async function setQtyByTyping(qtyInput, requestedQty) {
  await qtyInput.scrollIntoViewIfNeeded().catch(() => {});
  await qtyInput.click({ force: true }).catch(() => {});
  await qtyInput.fill(String(requestedQty)).catch(() => {});
  await qtyInput.evaluate((el) => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    try {
      const s = window.angular?.element(el)?.scope?.();
      if (s) s.$apply?.();
    } catch (e) {}
  }).catch(() => {});
}

async function login(page, username, password) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
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

async function clearCartAfterLogin(page, { timeoutMs = 30000, username = "?" } = {}) {
  const log = (...a) => console.log(`[CLEAR_CART][${username}]`, ...a);
  log("Başlıyor...");
  const cartIcon = page.locator('[data-cy="top-menu_click-check-out-state"]').first();
  log("Sepet ikonu bekleniyor...");
  const cartIconFound = await cartIcon.waitFor({ state: "attached", timeout: 30000 }).then(() => true).catch(() => false);
  log(`Sepet ikonu bulundu: ${cartIconFound} | URL: ${page.url()}`);
  if (!cartIconFound) return { ok: true, cleared: false, reason: "cart_icon_not_found" };
  await cartIcon.click().catch(() => {});
  log("Sepet ikonuna tıklandı, bekleniyor...");
  await sleep(page, 1200);
  const clearBtn = page.locator('[data-cy="click-clear-cart"], a[ng-click="clearCart()"]').first();
  const hasClear = (await clearBtn.count().catch(() => 0)) > 0;
  log(`Sepeti Sil butonu var mı: ${hasClear}`);
  if (!hasClear) {
    log("Sepeti Sil butonu yok. Devam.");
    return { ok: true, cleared: false, reason: "clear_button_not_found" };
  }
  await clearBtn.click().catch(() => {});
  log("Sepeti Sil butonuna tıklandı, modal bekleniyor...");
  await sleep(page, 3000);
  const okBtn = page.locator('button.btn-primary:has-text("Tamam"), [data-cy="modal-ok"]').first();
  const hasOk = await okBtn.waitFor({ state: "visible", timeout: timeoutMs }).then(() => true).catch(() => false);
  log(`Modal OK butonu bulundu: ${hasOk}`);
  if (!hasOk) {
    const screenshotBase64 = await page.screenshot({ fullPage: false }).then((b) => b.toString("base64")).catch(() => null);
    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => "");
    log(`Modal OK butonu gelmedi. URL: ${currentUrl} | Title: ${pageTitle}`);
    return { ok: true, cleared: false, reason: "modal_ok_not_found", screenshotBase64, currentUrl, pageTitle };
  }
  await okBtn.click().catch(() => {});
  await sleep(page, 1200);
  log("Sepet temizlendi.");
  return { ok: true, cleared: true };
}

async function addOneItem(page, item) {
  const { productCode, uom, qty } = item || {};
  const requestedQty = Number(qty ?? 1);
  if (!productCode || !uom) return { ok: false, status: 400, productCode, uom, error: "productCode ve uom zorunlu" };
  if (!Number.isFinite(requestedQty) || requestedQty < 1) return { ok: false, status: 400, productCode, error: "qty >= 1 olmalı" };

  const currentPageUrl = page.url();
  const userPathMatch = currentPageUrl.match(/mybidfood\.com\.tr(\/u\/[^/#]+)/);
  const userBasePath = userPathMatch ? userPathMatch[1] : '';
  const productUrl = `${BASE_URL}${userBasePath}/#/products/search/?searchTerm=${encodeURIComponent(productCode)}&category=All&page=1&useUrlParams=true`;

  await page.goto(productUrl, { waitUntil: "domcontentloaded" });
  await sleep(page, 2000);
  await sleep(page, WAIT_STEP_MS);

  const row = page.locator(`#product-list-${productCode}`).first();
  if ((await row.count()) === 0) return { ok: false, status: 404, productCode, uom, error: `Ürün bloğu yok: ${productCode}`, productUrl };

  const uomUpper = String(uom).trim().toUpperCase();
  const uomType = row.locator(".UOM .type").filter({ hasText: uomUpper }).first();
  if ((await uomType.count()) === 0) {
    const availableUoms = await row.locator(".UOM .type").allTextContents().catch(() => []);
    return { ok: false, status: 404, productCode, uom, error: `UOM bulunamadı: ${uomUpper}`, availableUoms: availableUoms.map((x) => (x || "").trim()).filter(Boolean), productUrl };
  }

  const scope = uomType.locator("xpath=ancestor::tr[1]").first();
  const addBtn   = scope.locator('button[data-cy="click-set-add-stateprice"]').first();
  const plusBtn  = scope.locator('button[data-cy="click-increase-qtyprice"]').first();
  const minusBtn = scope.locator('button[data-cy="click-decrease-qtyprice"]').first();
  const qtyInput = scope.locator('input[data-cy="click-input-qty"]').first();

  if ((await addBtn.count()) > 0) {
    await addBtn.scrollIntoViewIfNeeded().catch(() => {});
    await addBtn.click({ force: true }).catch(() => {});
    await sleep(page, 500);
    await sleep(page, WAIT_STEP_MS);
  }

  await qtyInput.waitFor({ state: "attached", timeout: 60000 }).catch(() => {});

  const readQty = async () => {
    const v = await qtyInput.inputValue().catch(() => "");
    const n = parseInt(String(v || "0"), 10);
    return Number.isFinite(n) ? n : null;
  };

  // Hızlı yöntem: direkt yaz
  await setQtyByTyping(qtyInput, requestedQty);
  await sleep(page, 2500);
  const finalQtyFast = await readQty();
  if (finalQtyFast === requestedQty) {
    return { ok: true, productCode, uom: uomUpper, requestedQty, finalQty: finalQtyFast, productUrl, note: "qty input'a yazıldı." };
  }

  // Fallback: +/- ile ayarla
  let safety = 40;
  while (safety-- > 0) {
    const cur = await readQty();
    if (cur === null || cur <= 1) break;
    if ((await minusBtn.count()) === 0) break;
    await minusBtn.click({ force: true }).catch(() => {});
    await sleep(page, WAIT_STEP_MS);
  }

  let guard = 80;
  while (guard-- > 0) {
    const cur = await readQty();
    if (cur === requestedQty) break;
    if (cur === null) return { ok: false, status: 500, productCode, uom: uomUpper, error: "Qty input okunamadı", productUrl };
    if (cur < requestedQty) {
      if ((await plusBtn.count()) === 0) return { ok: false, status: 500, productCode, uom: uomUpper, error: "Plus yok", productUrl };
      await plusBtn.click({ force: true }).catch(() => {});
      await sleep(page, WAIT_STEP_MS);
      continue;
    }
    if ((await minusBtn.count()) === 0) return { ok: false, status: 500, productCode, uom: uomUpper, error: "Minus yok", productUrl };
    await minusBtn.click({ force: true }).catch(() => {});
    await sleep(page, WAIT_STEP_MS);
  }

  const finalQty = await readQty();
  if (finalQty !== requestedQty) return { ok: false, status: 500, productCode, uom: uomUpper, requestedQty, finalQty, productUrl, error: "Hedef qty'ye ulaşılamadı" };
  return { ok: true, productCode, uom: uomUpper, requestedQty, finalQty, productUrl, note: "+/- ile hedef qty'ye ulaşıldı." };
}

async function scrapeConfirmationPage(page) {
  await page.waitForTimeout(1500);
  return await page.evaluate(() => {
    const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    const orderInfo = {};
    document.querySelectorAll(".header-block .checkout-field-row").forEach((row) => {
      const label = text(row.querySelector(".col-xs-3"))?.replace(":", "");
      const value = text(row.querySelector(".col-xs-9"));
      if (label) orderInfo[label] = value || "";
    });
    const accounts = [];
    document.querySelectorAll('.account-wrap[ng-repeat="account in accounts"]').forEach((accountEl) => {
      const title = text(accountEl.querySelector("h3.title"));
      const parts = title.split(" - ").map((s) => s.trim()).filter(Boolean);
      const accountTitle = parts[0] || title;
      const accountCodeFromTitle = parts[1] || "";
      const header = accountEl.querySelector(".account-header");
      const accountDetails = {};
      if (header) {
        header.querySelectorAll(".checkout-field-row").forEach((row) => {
          const label = text(row.querySelector(".col-xs-3"))?.replace(":", "");
          const valueCol = row.querySelector(".col-xs-9");
          if (!label || !valueCol) return;
          accountDetails[label] = label.toLowerCase().includes("sevk adresi")
            ? Array.from(valueCol.querySelectorAll(".ng-binding")).map(text).filter(Boolean)
            : text(valueCol);
        });
      }
      const orders = [];
      accountEl.querySelectorAll('[ng-repeat="referenceGroup in account.Orders"]').forEach((groupEl) => {
        const deliveryDate = text(groupEl.querySelector(".bold-date"));
        const items = [];
        groupEl.querySelectorAll('tbody tr[ng-repeat="item in referenceGroup.OrderItems"]').forEach((itemEl) => {
          const tds = itemEl.querySelectorAll("td");
          if (tds.length < 3) return;
          const productCell = itemEl.querySelector("td.product") || tds[0];
          const productText = text(productCell);
          const codeMatch = productText.match(/\[([A-Z0-9]+)\]/i);
          const brandMatch = productText.match(/\(([^)]+)\)/);
          const descEl = productCell.querySelector(".p-description");
          const sizeUnitCell = tds[1];
          const rightTds = Array.from(itemEl.querySelectorAll("td.text-right"));
          const priceTds = rightTds.slice(1);
          items.push({
            description: descEl ? text(descEl) : productText.replace(/\([^)]+\)/, "").replace(/\[[^\]]+\]/, "").trim(),
            brand: brandMatch ? brandMatch[1].trim() : "",
            productCode: codeMatch ? codeMatch[1].trim() : "",
            size: text(sizeUnitCell.querySelector('[ng-if="item.Product.PackSize"]')).replace(/\/\s*$/, "").trim(),
            uom: text(sizeUnitCell.querySelector('[ng-if="item.UOMDesc"]')),
            qty: text(tds[2].querySelector(".ng-binding")) || text(tds[2]) || "",
            unitPrice: text(priceTds[0]) || "",
            subTotal: text(priceTds[1]) || "",
            tax: text(priceTds[2]) || "",
            total: text(priceTds[3]) || "",
          });
        });
        orders.push({ deliveryDate, items });
      });
      accounts.push({ accountTitle, accountCode: accountDetails["Hesap Kodu"] || accountCodeFromTitle || "", accountDetails, orders });
    });
    const summary = {};
    document.querySelectorAll(".checkout-summary .checkout-field-row").forEach((row) => {
      const label = text(row.querySelector(".col-xs-6:first-child"));
      const value = text(row.querySelector(".col-xs-6:last-child"));
      if (label) summary[label] = value || "";
    });
    return { orderInfo, accounts, summary };
  }).catch((e) => ({ error: String(e) }));
}

async function checkoutDelivery(page, params) {
  const { orderRef, deliveryDateText, deliveryAddress, submit = true, waitBefore = 5000 } = params || {};
  const result = {
    ok: true,
    orderRef: orderRef ?? null,
    deliveryDateText: deliveryDateText ?? null,
    deliveryAddress: deliveryAddress ?? null,
    submit: !!submit,
    orderRefSet: false,
    deliveryAddressSelected: false,
    deliveryDateSelected: false,
    submitted: false,
    confirmationUrl: null,
  };

  // ADIM 1: Sepet ikonu
  console.log("ADIM 1: Sepet ikonuna tıklanıyor...");
  const cartIcon = page.locator('[data-cy="top-menu_click-check-out-state"]').first();
  await cartIcon.waitFor({ state: "attached", timeout: 30000 });
  await cartIcon.click();
  await sleep(page, 2000);

  // ADIM 2: Siparişi Tamamla
  console.log("ADIM 2: Siparişi Tamamla...");
  const checkoutBtn = page.locator('[data-cy="click-checkout-landing"]').first();
  await checkoutBtn.waitFor({ state: "attached", timeout: 30000 });
  await checkoutBtn.click();
  await sleep(page, waitBefore);

  // ADIM 2.5: Stok uyarısı
  const validationBtn = page.locator('[data-cy="checkout-validation-continue-btn"]').first();
  const hasValidation = await validationBtn.waitFor({ state: "attached", timeout: 5000 }).then(() => true).catch(() => false);
  if (hasValidation) {
    const isDisabled = await validationBtn.isDisabled().catch(() => true);
    if (!isDisabled) { await validationBtn.click(); await sleep(page, 3000); }
    else return { ok: false, status: 409, error: "OutOfStock veya unavailable ürün var", ...result };
  }

  // ADIM 3: OrderRef
  if (orderRef && String(orderRef).trim().length > 0) {
    console.log("ADIM 3: OrderRef yazılıyor...", orderRef);
    const refInput = page.locator('[data-cy="headerOrderRef"]').first();
    await refInput.waitFor({ state: "attached", timeout: 30000 });
    await refInput.scrollIntoViewIfNeeded().catch(() => {});
    await refInput.click();
    await sleep(page, 200);
    await refInput.selectText().catch(() => {});
    await refInput.fill(String(orderRef));
    await refInput.evaluate((el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      try { const s = angular.element(el).scope(); if (s) s.$apply(); } catch (e) {}
    });
    await sleep(page, 500);
    result.orderRefSet = true;
  }

  // ADIM 4: Devam
  console.log("ADIM 4: Devam butonuna tıklanıyor...");
  const continueBtn = page.locator('[data-cy="continue-button"]').first();
  await continueBtn.waitFor({ state: "attached", timeout: 30000 });
  await continueBtn.scrollIntoViewIfNeeded().catch(() => {});
  await continueBtn.click();
  await sleep(page, waitBefore);

  // ADIM 5: Sevk adresi
  if (deliveryAddress && String(deliveryAddress).trim().length > 0) {
    console.log("ADIM 5: Sevk adresi seçiliyor...", deliveryAddress);
    const wanted = String(deliveryAddress).trim().toUpperCase();
    const addressToggle = page.locator("button.wrap-address").first();
    await addressToggle.waitFor({ state: "attached", timeout: 30000 });
    await addressToggle.scrollIntoViewIfNeeded().catch(() => {});
    await addressToggle.click();
    await sleep(page, 1000);
    const addressLinks = page.locator('a[data-cy="click-switch-addressaccount-address"]');
    const allAddresses = await addressLinks.allTextContents().catch(() => []);
    let hitLink = addressLinks.filter({ hasText: new RegExp(wanted, "i") }).first();
    if ((await hitLink.count()) === 0) {
      for (const word of wanted.split(/[\s\-]+/).filter((w) => w.length > 3)) {
        hitLink = addressLinks.filter({ hasText: new RegExp(word, "i") }).first();
        if ((await hitLink.count()) > 0) { console.log(`Kısmi eşleşme: "${word}"`); break; }
      }
    }
    if ((await hitLink.count()) === 0) {
      return { ok: false, status: 404, error: `Adres bulunamadı: ${wanted}`, availableAddresses: allAddresses.map((x) => (x || "").trim()).filter(Boolean), ...result };
    }
    result.selectedAddress = (await hitLink.textContent().catch(() => "")).trim();
    await hitLink.scrollIntoViewIfNeeded().catch(() => {});
    await hitLink.click();
    await sleep(page, 2000);
    result.deliveryAddressSelected = true;
    console.log("✅ Adres seçildi:", result.selectedAddress);
  }

  // ADIM 6: Tarih
  if (deliveryDateText && String(deliveryDateText).trim().length > 0) {
    console.log("ADIM 6: Tarih seçiliyor...", deliveryDateText);
    const wanted = String(deliveryDateText).trim();
    const dropdownBtn = page.locator('[data-cy="delivery-date-dropdown"]').first();
    await dropdownBtn.waitFor({ state: "attached", timeout: 30000 });
    await dropdownBtn.scrollIntoViewIfNeeded().catch(() => {});
    await dropdownBtn.click();
    await sleep(page, 1000);
    const menu = page.locator('ul[data-cy="delivery-date-menu"]').first();
    await menu.waitFor({ state: "attached", timeout: 30000 });
    const allOptions = (await menu.locator("li").allTextContents().catch(() => [])).map((x) => (x || "").trim()).filter(Boolean);

    const turkishMonths = { "Ocak":0,"\u015eubat":1,"Mart":2,"Nisan":3,"May\u0131s":4,"Haziran":5,"Temmuz":6,"A\u011fustos":7,"Eyl\u00fcl":8,"Ekim":9,"Kas\u0131m":10,"Aral\u0131k":11 };
    const monthNames = ["Ocak","\u015eubat","Mart","Nisan","May\u0131s","Haziran","Temmuz","A\u011fustos","Eyl\u00fcl","Ekim","Kas\u0131m","Aral\u0131k"];

    const findInMenu = async (t) => {
      let li = menu.locator('[data-cy="click-set-dateparentindex-account-date"]').filter({ hasText: t }).first();
      if ((await li.count()) > 0) return li;
      li = menu.locator("li").filter({ hasText: t }).first();
      if ((await li.count()) > 0) return li;
      const d = t.match(/(\d+)/);
      if (d) { li = menu.locator("li").filter({ hasText: d[1] }).first(); if ((await li.count()) > 0) return li; }
      return null;
    };

    const parseDate = (t) => {
      const tr = t.match(/(\d+)\s+(Ocak|\u015eubat|Mart|Nisan|May\u0131s|Haziran|Temmuz|A\u011fustos|Eyl\u00fcl|Ekim|Kas\u0131m|Aral\u0131k)/i);
      if (tr) return new Date(new Date().getFullYear(), turkishMonths[tr[2]], parseInt(tr[1]));
      const d = t.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      if (d) return new Date(+d[3], +d[2]-1, +d[1]);
      return null;
    };

    let hitLi = await findInMenu(wanted);
    if (!hitLi) {
      const pd = parseDate(wanted);
      if (pd) {
        pd.setDate(pd.getDate() + 1);
        const nd = `${pd.getDate()} ${monthNames[pd.getMonth()]}`;
        console.log(`Tarih bulunamadı, ertesi gün deneniyor: "${nd}"`);
        hitLi = await findInMenu(nd);
        if (hitLi) { result.autoDateFallback = true; result.autoDateRequested = wanted; result.autoDateNextDay = nd; }
      }
    }
    if (!hitLi) {
      if (allOptions.length > 0) {
        // En yakın tarihi bul
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let closestOption = allOptions[0];
        let closestDiff = Infinity;
        for (const opt of allOptions) {
          const d = parseDate(opt);
          if (d) {
            const diff = Math.abs(d - today);
            if (diff < closestDiff) { closestDiff = diff; closestOption = opt; }
          }
        }
        hitLi = menu.locator("li").filter({ hasText: closestOption }).first();
        result.autoDateFallback = true; result.autoDateRequested = wanted; result.autoDateSelected = closestOption;
        console.log(`En yakın tarihe düşüldü: "${closestOption}"`);
      }
      if (!hitLi || (await hitLi.count()) === 0) {
        return { ok: false, status: 404, error: `Tarih bulunamadı: ${wanted}`, availableDates: allOptions, ...result };
      }
    }
    const anchor = hitLi.locator("a").first();
    const clickTarget = (await anchor.count()) > 0 ? anchor : hitLi;
    result.selectedDateText = ((await hitLi.textContent().catch(() => "")) || "").trim();
    await clickTarget.scrollIntoViewIfNeeded().catch(() => {});
    await clickTarget.click();
    await sleep(page, 2000);
    result.deliveryDateSelected = true;
    console.log("✅ Tarih seçildi:", result.selectedDateText);
  }

  // ADIM 7: Gönder
  if (submit) {
    console.log("ADIM 7: Gönder butonuna tıklanıyor...");
    const submitBtn = page.locator('[data-cy="click-submit-orderaccount-submit"]').first();
    await submitBtn.waitFor({ state: "attached", timeout: 60000 });
    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
    for (let i = 0; i < 15; i++) {
      if (!(await submitBtn.isDisabled().catch(() => true))) break;
      console.log(`Submit butonu disabled, bekleniyor... (${i + 1}/15)`);
      await sleep(page, 1000);
    }
    result.screenshotBase64 = await page.screenshot({ fullPage: false }).then((b) => b.toString("base64")).catch(() => null);
    result.preSubmitState = await page.evaluate(() => {
      try {
        const btn = document.querySelector('[data-cy="click-submit-orderaccount-submit"]');
        let s = angular.element(btn).scope(); let depth = 0;
        while (s && depth < 15) { if (s.account && s.account.Header) break; s = s.$parent; depth++; }
        const h = s && s.account && s.account.Header;
        return { ReferenceNumber: h && h.ReferenceNumber, submitDisabled: s && s.submitDisabled, url: window.location.href };
      } catch (e) { return { error: e.message }; }
    }).catch((e) => ({ error: String(e) }));

    await submitBtn.click();
    console.log("✅ Gönder butonuna tıklandı");
    await sleep(page, 3000);

    let confirmationReached = false;
    for (let i = 0; i < 30; i++) {
      if (page.url().includes("/checkout/confirmation")) { confirmationReached = true; break; }
      await sleep(page, 3000);
    }

    if (confirmationReached) {
      result.submitted = true;
      result.confirmationUrl = page.url();
      await page.waitForSelector(".checkout-block", { timeout: 60000 }).catch(() => {});
      await page.waitForSelector('.account-wrap[ng-repeat="account in accounts"]', { timeout: 60000 }).catch(() => {});
      console.log("ADIM 8: Confirmation sayfası scrape ediliyor...");
      result.confirmationData = await scrapeConfirmationPage(page);
    } else {
      const errorTexts = await page.locator("text=/hata|error|başarısız|geçersiz|uyarı/i").allTextContents().catch(() => []);
      const failScreenshot = await page.screenshot({ fullPage: false }).then((b) => b.toString("base64")).catch(() => null);
      return { ok: false, status: 500, error: "Submit sonrası confirmation görülmedi", currentUrl: page.url(), errorTexts: errorTexts.filter(Boolean), failScreenshot, ...result };
    }
  }

  return result;
}

// =========================
// CORE BATCH LOGIC
// =========================
async function runBatch({ username, password, items, stopOnError, checkout }) {
  console.log(`[BROWSER] ${username} → chromium`);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);
  try {
    const loginResult = await withTimeout(login(page, username, password), 60000);
    if (!loginResult.loggedIn) return { ok: false, step: "login", ...loginResult };

    await clearCartAfterLogin(page, { username }); // timeout yok — eski davranış

    const results = [];
    for (const it of items) {
      const r = await withTimeout(addOneItem(page, it), 300000, "ITEM_TIMEOUT"); // 5 dk (önceki: 3 dk — yetersizdi)
      results.push(r);
      if (!r.ok && stopOnError) break;
      await sleep(page, 1500);
    }

    const summary = {
      total: items.length,
      done: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };

    let checkoutResult = null;
    if (checkout && (summary.failed === 0 || !stopOnError)) {
      checkoutResult = await withTimeout(checkoutDelivery(page, checkout), 240000, "CHECKOUT_TIMEOUT");
    }

    return {
      ok: (summary.failed === 0 || !stopOnError) && (!checkout || (checkoutResult && checkoutResult.ok)),
      summary, results, checkoutResult,
    };
  } finally {
    await browser.close();
  }
}

// =========================
// ROUTES
// =========================

// ✅ LOGIN TEST
app.post("/login-test", async (req, res) => {
  const { username, password } = req.body || {};
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000); page.setDefaultNavigationTimeout(60000);
  try {
    const result = await withTimeout(login(page, username, password), 60000);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// ✅ ÇOKLU ÜRÜN BATCH — HAVUZ SİSTEMİ
// n8n'den username/password göndermene GEREK YOK.
// Sadece checkout.deliveryAddress üzerinden bölge otomatik seçilir.
app.post("/add-to-cart-batch", async (req, res) => {
  const { items, stopOnError = true, checkout } = req.body || {};
  let { username, password } = req.body || {};

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ ok: false, error: "items[] zorunlu" });

  let region = null;
  let acquiredUser = null;

  if (!username || !password) {
    // Adres üzerinden bölge bul, havuzdan kullanıcı al
    const deliveryAddress = checkout?.deliveryAddress;
    region = getRegionForAddress(deliveryAddress);
    if (!region) {
      return res.status(400).json({
        ok: false,
        error: `Adres için bölge bulunamadı: "${deliveryAddress}". ADDRESS_REGION tablosunu kontrol edin.`,
      });
    }
    console.log(`[POOL] Adres: "${deliveryAddress}" → Bölge: ${region}`);
    // Boşta kullanıcı yoksa max 10 dakika bekler
    acquiredUser = await withTimeout(acquireUser(region), 600000, "POOL_ACQUIRE_TIMEOUT");
    username = acquiredUser.username;
    password = acquiredUser.password;
  } else {
    console.log(`[POOL] Manuel kullanıcı: ${username}`);
  }

  console.log(`[BATCH] Başlıyor: ${username} | ${items.length} ürün`);

  try {
    const result = await withTimeout(
      runBatch({ username, password, items, stopOnError, checkout }),
      900000, // 15 dakika (önceki: 5 dk — yetersizdi)
      "BATCH_TIMEOUT"
    );
    result.usedUsername = username;
    result.region = region;
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e), usedUsername: username });
  } finally {
    if (region && acquiredUser) releaseUser(region, username);
  }
});

// ✅ TEK ÜRÜN
app.post("/add-to-cart", async (req, res) => {
  const { username, password, productCode, uom, qty, checkout } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: "username/password zorunlu" });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000); page.setDefaultNavigationTimeout(60000);
  try {
    const loginResult = await withTimeout(login(page, username, password), 60000);
    if (!loginResult.loggedIn) return res.status(401).json({ ok: false, step: "login", ...loginResult });
    await clearCartAfterLogin(page, { username }); // timeout yok — eski davranış
    const itemResult = await withTimeout(addOneItem(page, { productCode, uom, qty }), 180000, "ITEM_TIMEOUT");
    let checkoutResult = null;
    if (checkout && itemResult.ok) checkoutResult = await withTimeout(checkoutDelivery(page, checkout), 180000, "CHECKOUT_TIMEOUT");
    return res.json({
      ok: itemResult.ok && (!checkout || (checkoutResult && checkoutResult.ok)),
      summary: { total: 1, done: itemResult.ok ? 1 : 0, failed: itemResult.ok ? 0 : 1 },
      results: [itemResult], checkoutResult,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// 🔍 DEBUG
app.post("/debug-checkout-page", async (req, res) => {
  const { username, password, productCode, uom, qty, waitBefore = 10000 } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: "username/password zorunlu" });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000); page.setDefaultNavigationTimeout(60000);
  try {
    const loginResult = await withTimeout(login(page, username, password), 60000);
    if (!loginResult.loggedIn) return res.status(401).json({ ok: false, step: "login", ...loginResult });
    if (productCode) await withTimeout(addOneItem(page, { productCode, uom, qty }), 180000, "ITEM_TIMEOUT");
    await page.goto(`${BASE_URL}/#/checkout/delivery`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(waitBefore);
    const fullHtml = await page.content();
    const submitBtnState = await page.evaluate(() => {
      const btn = document.querySelector('[data-cy="click-submit-orderaccount-submit"]');
      if (!btn) return { found: false };
      return { found: true, disabled: btn.disabled, className: btn.className, outerHTML: btn.outerHTML };
    }).catch((e) => ({ error: String(e) }));
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input,select,textarea")).map((el) => ({
        tag: el.tagName, type: el.type, name: el.name, id: el.id,
        value: el.value, disabled: el.disabled, dataCy: el.getAttribute("data-cy"),
      }))
    ).catch((e) => ({ error: String(e) }));
    const errorMessages = await page.locator("text=/hata|error|uyarı|warning/i").allTextContents().catch(() => []);
    return res.json({ ok: true, currentUrl: page.url(), submitBtnState, inputs, errorMessages: errorMessages.filter(Boolean), fullHtml });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// 📊 POOL STATUS — hangi kullanıcı meşgul, kaç istek bekliyor
app.get("/pool-status", (req, res) => {
  const status = {};
  for (const [region, pool] of Object.entries(USER_POOLS)) {
    status[region] = {
      users: pool.map((u) => ({ username: u.username, busy: userBusy[u.username] ?? false })),
      waitingCount: waitQueues[region]?.length ?? 0,
    };
  }
  res.json(status);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
