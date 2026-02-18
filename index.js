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

const WAIT_STEP_MS = 10000; // min 10 sn (senin kuralın)
const BASE_URL = "https://www.mybidfood.com.tr";

async function sleep(page, ms) {
  await page.waitForTimeout(ms);
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

/**
 * Ürün search sayfasında ilgili productCode satırını bulur,
 * uom satırını seçer (ADET/KOLİ),
 * önce Ekle ile qty alanını açar,
 * sonra +/- ile hedef qty'ye gelince DURUR.
 */
async function addOneItem(page, item) {
  const { productCode, uom, qty } = item || {};
  const requestedQty = Number(qty ?? 1);

  if (!productCode || !uom) {
    return { ok: false, status: 400, productCode, uom, error: "productCode ve uom zorunlu" };
  }
  if (!Number.isFinite(requestedQty) || requestedQty < 1) {
    return { ok: false, status: 400, productCode, showUom: uom, error: "qty >= 1 olmalı" };
  }

  const productUrl = `${BASE_URL}/#/products/search/?searchTerm=${encodeURIComponent(
    productCode
  )}&category=All&page=1&useUrlParams=true`;

  await page.goto(productUrl, { waitUntil: "domcontentloaded" });
  await sleep(page, 2000);
  // SPA bazen geç çiziyor
  await sleep(page, WAIT_STEP_MS);

  const row = page.locator(`#product-list-${productCode}`).first();
  if ((await row.count()) === 0) {
    return { ok: false, status: 404, productCode, uom, error: `Ürün bloğu yok: ${productCode}`, productUrl };
  }

  // UOM satırını (tr) net yakala: row içinde .UOM .type == uom
  const uomUpper = String(uom).trim().toUpperCase();
  const uomType = row.locator(".UOM .type").filter({
    hasText: uomUpper,
  }).first();

  if ((await uomType.count()) === 0) {
    // mevcut UOM listesi dönelim
    const availableUoms = await row.locator(".UOM .type").allTextContents().catch(() => []);
    return {
      ok: false,
      status: 404,
      productCode,
      uom,
      error: `UOM bulunamadı: ${uomUpper}`,
      availableUoms: availableUoms.map((x) => (x || "").trim()).filter(Boolean),
      productUrl,
    };
  }

  // uomType'ın bulunduğu tr
  const scope = uomType.locator("xpath=ancestor::tr[1]").first();

  const addBtn = scope.locator('button[data-cy="click-set-add-stateprice"]').first();
  const plusBtn = scope.locator('button[data-cy="click-increase-qtyprice"]').first();
  const minusBtn = scope.locator('button[data-cy="click-decrease-qtyprice"]').first();
  const qtyInput = scope.locator('input[data-cy="click-input-qty"]').first();

  // Önce "Ekle" ile qty alanını aç
  if ((await addBtn.count()) > 0) {
    // buton görünmezse force ile scroll + click
    await addBtn.scrollIntoViewIfNeeded().catch(() => {});
    await addBtn.click({ force: true }).catch(() => {});
    await sleep(page, 500);
    await sleep(page, WAIT_STEP_MS);
  }

  // qty input görünür olana kadar bekle (ama hidden kalabiliyor; bu yüzden visible yerine attached + enabled check)
  await qtyInput.waitFor({ state: "attached", timeout: 60000 }).catch(() => {});

  const readQty = async () => {
    const v = await qtyInput.inputValue().catch(() => "");
    const n = parseInt(String(v || "0"), 10);
    return Number.isFinite(n) ? n : null;
  };

  // Güvenli başlangıç: 1'e indir
  let safety = 40;
  while (safety-- > 0) {
    const cur = await readQty();
    if (cur === null || cur <= 1) break;
    if ((await minusBtn.count()) === 0) break;
    await minusBtn.click({ force: true }).catch(() => {});
    await sleep(page, WAIT_STEP_MS);
  }

  // hedefe çık: hedefe gelince DUR
  let guard = 80;
  while (guard-- > 0) {
    const cur = await readQty();
    if (cur === requestedQty) break;
    if (cur === null) {
      return { ok: false, status: 500, productCode, uom: uomUpper, error: "Qty input okunamadı", productUrl };
    }
    if (cur < requestedQty) {
      if ((await plusBtn.count()) === 0) {
        return { ok: false, status: 500, productCode, uom: uomUpper, error: "Plus yok", productUrl };
      }
      await plusBtn.click({ force: true }).catch(() => {});
      await sleep(page, WAIT_STEP_MS);
      continue;
    }
    // cur > requestedQty ise azalt
    if ((await minusBtn.count()) === 0) {
      return { ok: false, status: 500, productCode, uom: uomUpper, error: "Minus yok", productUrl };
    }
    await minusBtn.click({ force: true }).catch(() => {});
    await sleep(page, WAIT_STEP_MS);
  }

  const finalQty = await readQty();

  if (finalQty !== requestedQty) {
    return {
      ok: false,
      status: 500,
      productCode,
      uom: uomUpper,
      requestedQty,
      finalQty,
      productUrl,
      error: "Hedef qty'ye ulaşılamadı",
    };
  }

  return {
    ok: true,
    productCode,
    uom: uomUpper,
    requestedQty,
    finalQty,
    productUrl,
    note: "Akış: login -> search -> UOM satırı seçildi -> Ekle ile qty alanı açıldı -> +/- ile hedef qty'ye gelince durdu.",
  };
}

/**
 * Sepet sonrası: checkout/delivery sayfasına gider,
 * order ref yazar, teslim tarihini seçer, submit tıklar,
 * confirmation ekranını görünce submitted=true döner.
 */
async function checkoutDelivery(page, params) {
  const {
    orderRef,
    deliveryDateText,
    submit = true,
    waitBefore = 10000,
  } = params || {};

  const deliveryUrl = `${BASE_URL}/#/checkout/delivery`;

  const result = {
    ok: true,
    deliveryUrl,
    orderRef: orderRef ?? null,
    deliveryDateText: deliveryDateText ?? null,
    submit: !!submit,
    orderRefSet: false,
    deliveryDateSelected: false,
    submitted: false,
    confirmationUrl: null,
  };

  // Delivery sayfasına git
  await page.goto(deliveryUrl, { waitUntil: "domcontentloaded" });
  await sleep(page, waitBefore);

  // Submit butonunun scope'unu bul - buradan account ve tüm model erişimi yapacağız
  const scopeReady = await page.evaluate(() => {
    try {
      const btn = document.querySelector('[data-cy="click-submit-orderaccount-submit"]');
      if (!btn) return false;
      const scope = angular.element(btn).scope();
      return !!scope;
    } catch(e) { return false; }
  }).catch(() => false);

  console.log('Angular scope hazır:', scopeReady);

  // 1) orderRef ve deliveryDate'i Angular scope'a direkt yaz
  const setResult = await page.evaluate((params) => {
    try {
      const { orderRef, deliveryDateText } = params;

      // Submit butonunun scope'undan başla, submitOrder olan scope'u bul
      const btn = document.querySelector('[data-cy="click-submit-orderaccount-submit"]');
      if (!btn) return { error: 'btn not found' };

      let scope = angular.element(btn).scope();
      let targetScope = scope;
      let depth = 0;
      while (targetScope && depth < 15) {
        if (targetScope.account && targetScope.account.Header) break;
        targetScope = targetScope.$parent;
        depth++;
      }

      if (!targetScope || !targetScope.account) return { error: 'account scope bulunamadı' };

      const account = targetScope.account;
      const before = {
        ReferenceNumber: account.Header.ReferenceNumber,
        DeliveryDate: account.Header.DeliveryDate,
      };

      // 1a) orderRef'i Angular model'e direkt yaz
      if (orderRef) {
        account.Header.ReferenceNumber = orderRef;
      }

      // 1b) deliveryDate - dropdown'dan eşleşen option'ı bul ve set et
      let dateSet = false;
      let availableDates = [];
      let selectedDateValue = null;

      if (deliveryDateText && targetScope.deliveryDates) {
        availableDates = targetScope.deliveryDates.map(d => ({
          text: d.DeliveryDateDisplay || d.DisplayDate || d.Text || JSON.stringify(d),
          value: d,
        }));

        const wanted = String(deliveryDateText).trim();
        const match = targetScope.deliveryDates.find(d => {
          const txt = (d.DeliveryDateDisplay || d.DisplayDate || d.Text || '');
          return txt.includes(wanted) || wanted.includes(txt.trim()) || txt.trim().includes(wanted.split(' ')[0]);
        });

        if (match) {
          // Angular'ın selectDeliveryDate veya benzeri fonksiyonu varsa çağır
          if (typeof targetScope.selectDeliveryDate === 'function') {
            targetScope.selectDeliveryDate(match);
            dateSet = true;
            selectedDateValue = match.DeliveryDateDisplay || match.DisplayDate;
          } else if (typeof targetScope.setDeliveryDate === 'function') {
            targetScope.setDeliveryDate(match);
            dateSet = true;
            selectedDateValue = match.DeliveryDateDisplay || match.DisplayDate;
          } else {
            // Direkt model'e yaz
            account.Header.DeliveryDate = match.DeliveryDate || match.Value || match;
            dateSet = true;
            selectedDateValue = match.DeliveryDateDisplay || match.DisplayDate;
          }
        }
      }

      // $apply ile Angular'ı güncelle
      targetScope.$apply();

      return {
        ok: true,
        before,
        after: {
          ReferenceNumber: account.Header.ReferenceNumber,
          DeliveryDate: account.Header.DeliveryDate,
        },
        dateSet,
        availableDates: availableDates.slice(0, 10).map(d => d.text),
        selectedDateValue,
        deliveryDatesCount: targetScope.deliveryDates ? targetScope.deliveryDates.length : 0,
      };
    } catch(e) {
      return { error: e.message, stack: e.stack };
    }
  }, { orderRef, deliveryDateText }).catch(e => ({ error: String(e) }));

  console.log('Angular scope set result:', JSON.stringify(setResult));
  result.scopeSetResult = setResult;

  if (setResult && setResult.ok) {
    result.orderRefSet = !!orderRef;
    await sleep(page, 1000);
  }

  // 2) Tarih dropdown'dan seçilmediyse DOM ile dene (fallback)
  if (deliveryDateText && (!setResult?.dateSet)) {
    console.log('Scope ile tarih set edilemedi, DOM ile deneniyor...');
    const btn = page.locator('[data-cy="delivery-date-dropdown"]').first();
    await btn.waitFor({ state: "attached", timeout: 30000 }).catch(() => {});
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click().catch(() => {});
    await sleep(page, 1000);

    const menu = page.locator('ul[data-cy="delivery-date-menu"]').first();
    await menu.waitFor({ state: "attached", timeout: 30000 }).catch(() => {});

    const allOptions = await menu.locator("li").allTextContents().catch(() => []);
    const wanted = String(deliveryDateText).trim();

    let hitLi = menu.locator("li").filter({ hasText: wanted }).first();
    if ((await hitLi.count()) === 0) {
      const dayMatch = wanted.match(/(\d+)/);
      if (dayMatch) hitLi = menu.locator("li").filter({ hasText: dayMatch[1] }).first();
    }

    if ((await hitLi.count()) === 0) {
      return {
        ok: false, status: 404,
        error: `Tarih bulunamadı: ${wanted}`,
        availableDates: allOptions.map(x => (x || "").trim()).filter(Boolean),
        ...result,
      };
    }

    const selectedText = await hitLi.textContent().catch(() => "");
    await hitLi.scrollIntoViewIfNeeded().catch(() => {});
    await hitLi.click().catch(() => {});
    await sleep(page, 1000);

    result.deliveryDateSelected = true;
    result.selectedDateText = selectedText;
  } else if (setResult?.dateSet) {
    result.deliveryDateSelected = true;
    result.selectedDateText = setResult.selectedDateValue;
  }

  // Angular'ı son kez sync et
  await page.evaluate(() => {
    try {
      angular.element(document.body).scope().$apply();
    } catch(e) {}
  }).catch(() => {});

  await sleep(page, 2000);

  // 3) Gönder - Gerçek DOM click ile Angular event pipeline'ını tetikle
  if (submit) {
    const submitBtn = page.locator('[data-cy="click-submit-orderaccount-submit"]').first();
    await submitBtn.waitFor({ state: "attached", timeout: 60000 });

    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});

    // Buton disabled ise enabled olana kadar bekle (max 30 sn)
    let btnEnabled = false;
    for (let i = 0; i < 30; i++) {
      const isDisabled = await submitBtn.isDisabled().catch(() => true);
      if (!isDisabled) { btnEnabled = true; break; }
      console.log(`Submit butonu disabled, bekleniyor... (${i + 1}/30)`);
      await sleep(page, 1000);
    }

    if (!btnEnabled) {
      const errorTexts = await page.locator('text=/hata|error|başarısız|geçersiz|uyarı/i').allTextContents().catch(() => []);
      return {
        ok: false,
        status: 500,
        error: "Submit butonu 30 saniye sonra hâlâ disabled",
        errorTexts: errorTexts.filter(Boolean),
        ...result,
      };
    }

    // Angular'ın kendi event pipeline'ını tetiklemek için native Playwright click
    await submitBtn.click();
    console.log('✅ Submit butonuna tıklandı (native click)');
    await sleep(page, 3000);

    // Confirmation bekle (max 90 sn)
    let confirmationReached = false;
    for (let i = 0; i < 30; i++) {
      const currentUrl = page.url();
      console.log(`Check ${i + 1}/30: ${currentUrl}`);

      if (currentUrl.includes('/checkout/confirmation')) {
        confirmationReached = true;
        break;
      }

      await sleep(page, 3000);
    }

    if (confirmationReached) {
      result.submitted = true;
      result.confirmationUrl = page.url();
      result.submitMethod = 'native-click';
      await page.screenshot({ path: '/tmp/after-submit-success.png', fullPage: true }).catch(() => {});
    } else {
      result.submitted = false;
      result.confirmationUrl = page.url();
      await page.screenshot({ path: '/tmp/after-submit-failed.png', fullPage: true }).catch(() => {});

      const errorTexts = await page.locator('text=/hata|error|başarısız|geçersiz|uyarı/i').allTextContents().catch(() => []);

      return {
        ok: false,
        status: 500,
        error: "Submit sonrası confirmation görülmedi",
        currentUrl: page.url(),
        submitMethod: 'native-click',
        errorTexts: errorTexts.filter(Boolean),
        ...result,
      };
    }
  }

  return result;
}

// ✅ SADECE LOGIN TEST
app.post("/login-test", async (req, res) => {
  const { username, password } = req.body || {};

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  try {
    const result = await withTimeout(login(page, username, password), 60000);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// ✅ TEK ÜRÜN + (opsiyonel) checkout
app.post("/add-to-cart", async (req, res) => {
  const { username, password, productCode, uom, qty, checkout } = req.body || {};

  if (!username || !password) return res.status(400).json({ ok: false, error: "username/password zorunlu" });

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
      "ITEM_TIMEOUT"
    );

    let checkoutResult = null;
    if (checkout && itemResult.ok) {
      checkoutResult = await withTimeout(checkoutDelivery(page, checkout), 180000, "CHECKOUT_TIMEOUT");
    }

    return res.json({
      ok: itemResult.ok && (!checkout || (checkoutResult && checkoutResult.ok)),
      ...itemResult,
      checkoutResult,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// ✅ ÇOKLU ÜRÜN: batch + (opsiyonel) checkout
app.post("/add-to-cart-batch", async (req, res) => {
  const { username, password, items, stopOnError = true, checkout } = req.body || {};

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
    if (checkout && (summary.failed === 0 || !stopOnError)) {
      checkoutResult = await withTimeout(checkoutDelivery(page, checkout), 240000, "CHECKOUT_TIMEOUT");
    }

    return res.json({
      ok: (summary.failed === 0 || !stopOnError) && (!checkout || (checkoutResult && checkoutResult.ok)),
      summary,
      results,
      checkoutResult,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// 🔍 DEBUG: Checkout/delivery sayfasının tam DOM yapısını döker
app.post("/debug-checkout-page", async (req, res) => {
  const { username, password, productCode, uom, qty, waitBefore = 10000 } = req.body || {};

  if (!username || !password) return res.status(400).json({ ok: false, error: "username/password zorunlu" });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  try {
    // Login
    const loginResult = await withTimeout(login(page, username, password), 60000);
    if (!loginResult.loggedIn) return res.status(401).json({ ok: false, step: "login", ...loginResult });

    // Ürün ekle (sepet dolu olsun ki checkout sayfası gerçek halini göstersin)
    if (productCode) {
      await withTimeout(addOneItem(page, { productCode, uom, qty }), 180000, "ITEM_TIMEOUT");
    }

    // Delivery sayfasına git
    const deliveryUrl = `${BASE_URL}/#/checkout/delivery`;
    await page.goto(deliveryUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(waitBefore);

    // Tam HTML
    const fullHtml = await page.content();

    // Submit butonunun durumu
    const submitBtnState = await page.evaluate(() => {
      const btn = document.querySelector('[data-cy="click-submit-orderaccount-submit"]');
      if (!btn) return { found: false };
      return {
        found: true,
        disabled: btn.disabled,
        className: btn.className,
        outerHTML: btn.outerHTML,
        ngDisabled: btn.getAttribute('ng-disabled'),
        ngClick: btn.getAttribute('ng-click'),
      };
    }).catch(e => ({ error: String(e) }));

    // Tüm input/select elementleri ve değerleri
    const inputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input, select, textarea')).map(el => ({
        tag: el.tagName,
        type: el.type,
        name: el.name,
        id: el.id,
        value: el.value,
        disabled: el.disabled,
        ngModel: el.getAttribute('ng-model'),
        dataCy: el.getAttribute('data-cy'),
        placeholder: el.placeholder,
      }));
    }).catch(e => ({ error: String(e) }));

    // Hata mesajları varsa
    const errorMessages = await page.locator('text=/hata|error|uyarı|warning/i').allTextContents().catch(() => []);

    // Angular scope - submit'i etkileyen kritik değerler
    const angularScope = await page.evaluate(() => {
      try {
        const btn = document.querySelector('[data-cy="click-submit-orderaccount-submit"]');
        if (!btn) return { error: 'btn not found' };
        
        // Submit butonunun scope'unu bul
        let scope = angular.element(btn).scope();
        
        // Scope'ta submitOrder'ı bul (parent'lara çık)
        let targetScope = scope;
        let depth = 0;
        while (targetScope && depth < 15) {
          if (typeof targetScope.submitOrder === 'function' || 
              typeof targetScope.checkMinOrderSubmit === 'function') break;
          targetScope = targetScope.$parent;
          depth++;
        }

        if (!targetScope) return { error: 'scope with submitOrder not found' };

        // Kritik değerleri oku
        const result = {
          submitDisabled: targetScope.submitDisabled,
          hasRestrictedDeliveryItems: targetScope.hasRestrictedDeliveryItems,
          approvalNeeded: targetScope.approvalNeeded,
          canTradeOnline: targetScope.canTradeOnline,
          canAllowCredit: targetScope.canAllowCredit,
          isApproverShadowSession: targetScope.isApproverShadowSession,
          checkMinOrderSubmitResult: null,
          checkRestrictedProductResult: null,
        };

        // Fonksiyonları çağır
        try { result.checkMinOrderSubmitResult = targetScope.checkMinOrderSubmit(); } catch(e) { result.checkMinOrderSubmitResult = 'ERROR: ' + e.message; }
        try { 
          const account = targetScope.account || (targetScope.accounts && targetScope.accounts[0]);
          result.checkRestrictedProductResult = targetScope.checkRestrictedProduct(account); 
          result.account = {
            ReferenceNumber: account && account.Header && account.Header.ReferenceNumber,
            DeliveryDate: account && account.Header && account.Header.DeliveryDate,
            HasItems: account && account.Entries && account.Entries.length,
          };
        } catch(e) { result.checkRestrictedProductResult = 'ERROR: ' + e.message; }

        return result;
      } catch(e) {
        return { error: e.message };
      }
    }).catch(e => ({ error: String(e) }));

    return res.json({
      ok: true,
      currentUrl: page.url(),
      submitBtnState,
      angularScope,
      inputs,
      errorMessages: errorMessages.filter(Boolean),
      fullHtml,
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
