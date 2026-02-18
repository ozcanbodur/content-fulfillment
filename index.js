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

  // Mevcut URL'den kullanıcıya özgü base path'i al (örn: /u/13185)
  const currentPageUrl = page.url();
  const userPathMatch2 = currentPageUrl.match(/mybidfood\.com\.tr(\/u\/[^/#]+)/);
  const userBasePath2 = userPathMatch2 ? userPathMatch2[1] : '';
  const productUrl = `${BASE_URL}${userBasePath2}/#/products/search/?searchTerm=${encodeURIComponent(
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
 * Tam akış: Sepet ikonu → Siparişi Tamamla → Sipariş Detayları (ref yaz, Devam) →
 * Sipariş Sevk Detayları (tarih seç, Gönder) → Confirmation
 */
async function checkoutDelivery(page, params) {
  const {
    orderRef,
    deliveryDateText,
    submit = true,
    waitBefore = 5000,
  } = params || {};

  const result = {
    ok: true,
    orderRef: orderRef ?? null,
    deliveryDateText: deliveryDateText ?? null,
    submit: !!submit,
    orderRefSet: false,
    deliveryDateSelected: false,
    submitted: false,
    confirmationUrl: null,
  };

  // ADIM 1: Sepet ikonuna tıkla - yan panel açılır
  console.log('ADIM 1: Sepet ikonuna tıklanıyor...');
  const cartIcon = page.locator('[data-cy="top-menu_click-check-out-state"]').first();
  await cartIcon.waitFor({ state: 'attached', timeout: 30000 });
  await cartIcon.click();
  await sleep(page, 2000);

  // ADIM 2: "Siparişi Tamamla" butonuna tıkla
  console.log('ADIM 2: Siparişi Tamamla tıklanıyor...');
  const checkoutBtn = page.locator('[data-cy="click-checkout-landing"]').first();
  await checkoutBtn.waitFor({ state: 'attached', timeout: 30000 });
  await checkoutBtn.click();
  await sleep(page, waitBefore);
  console.log('Sipariş Detayları sayfası:', page.url());

  // ADIM 3: Sipariş Detayları sayfası - orderRef yaz
  if (orderRef && String(orderRef).trim().length > 0) {
    console.log('ADIM 3: OrderRef yazılıyor...', orderRef);
    const refInput = page.locator('[data-cy="headerOrderRef"]').first();
    await refInput.waitFor({ state: 'attached', timeout: 30000 });
    await refInput.scrollIntoViewIfNeeded().catch(() => {});
    await refInput.click();
    await sleep(page, 200);

    // Mevcut değeri temizle ve yaz
    await refInput.selectText().catch(() => {});
    await refInput.fill(String(orderRef));

    // Angular ng-model tetikle
    await refInput.evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      try {
        const s = angular.element(el).scope();
        if (s) s.$apply();
      } catch(e) {}
    });

    await sleep(page, 500);
    result.orderRefSet = true;
  }

  // ADIM 4: "Devam" butonuna tıkla
  console.log('ADIM 4: Devam butonuna tıklanıyor...');
  const continueBtn = page.locator('[data-cy="continue-button"]').first();
  await continueBtn.waitFor({ state: 'attached', timeout: 30000 });
  await continueBtn.scrollIntoViewIfNeeded().catch(() => {});
  await continueBtn.click();
  await sleep(page, waitBefore);
  console.log('Sevk Detayları sayfası:', page.url());

  // ADIM 5: Tarih seç
  if (deliveryDateText && String(deliveryDateText).trim().length > 0) {
    console.log('ADIM 5: Tarih seçiliyor...', deliveryDateText);
    const wanted = String(deliveryDateText).trim();

    const dropdownBtn = page.locator('[data-cy="delivery-date-dropdown"]').first();
    await dropdownBtn.waitFor({ state: 'attached', timeout: 30000 });
    await dropdownBtn.scrollIntoViewIfNeeded().catch(() => {});
    await dropdownBtn.click();
    await sleep(page, 1000);

    const menu = page.locator('ul[data-cy="delivery-date-menu"]').first();
    await menu.waitFor({ state: 'attached', timeout: 30000 });
    const allOptions = await menu.locator('li').allTextContents().catch(() => []);

    // recording'deki data-cy ile önce dene, sonra text ile
    let hitLi = menu.locator('[data-cy="click-set-dateparentindex-account-date"]')
      .filter({ hasText: wanted }).first();

    if ((await hitLi.count()) === 0)
      hitLi = menu.locator('li').filter({ hasText: wanted }).first();

    if ((await hitLi.count()) === 0) {
      const dayMatch = wanted.match(/(\d+)/);
      if (dayMatch) hitLi = menu.locator('li').filter({ hasText: dayMatch[1] }).first();
    }

    if ((await hitLi.count()) === 0) {
      return {
        ok: false, status: 404,
        error: `Tarih bulunamadı: ${wanted}`,
        availableDates: allOptions.map(x => (x || '').trim()).filter(Boolean),
        ...result,
      };
    }

    // recording'de <a> tag'ine tıklanıyor
    const anchor = hitLi.locator('a').first();
    const clickTarget = (await anchor.count()) > 0 ? anchor : hitLi;
    const selectedText = await hitLi.textContent().catch(() => '');
    await clickTarget.scrollIntoViewIfNeeded().catch(() => {});
    await clickTarget.click();
    await sleep(page, 2000);

    result.deliveryDateSelected = true;
    result.selectedDateText = selectedText.trim();
    console.log('Tarih seçildi:', result.selectedDateText);
  }

  // ADIM 6: Gönder butonuna tıkla
  if (submit) {
    console.log('ADIM 6: Gönder butonuna tıklanıyor...');
    const submitBtn = page.locator('[data-cy="click-submit-orderaccount-submit"]').first();
    await submitBtn.waitFor({ state: 'attached', timeout: 60000 });
    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});

    // Buton disabled ise bekle (max 15 sn)
    for (let i = 0; i < 15; i++) {
      const isDisabled = await submitBtn.isDisabled().catch(() => true);
      if (!isDisabled) break;
      console.log(`Submit butonu disabled, bekleniyor... (${i + 1}/15)`);
      await sleep(page, 1000);
    }

    // Submit öncesi screenshot
    const screenshotBase64 = await page.screenshot({ fullPage: false })
      .then(buf => buf.toString('base64')).catch(() => null);
    result.screenshotBase64 = screenshotBase64;

    // Submit öncesi state
    const preSubmitState = await page.evaluate(() => {
      try {
        const btn = document.querySelector('[data-cy="click-submit-orderaccount-submit"]');
        let s = angular.element(btn).scope();
        let depth = 0;
        while (s && depth < 15) {
          if (s.account && s.account.Header) break;
          s = s.$parent; depth++;
        }
        const h = s && s.account && s.account.Header;
        return {
          ReferenceNumber: h && h.ReferenceNumber,
          DeliveryDate: h && h.DeliveryDate,
          submitDisabled: s && s.submitDisabled,
          url: window.location.href,
        };
      } catch(e) { return { error: e.message }; }
    }).catch(e => ({ error: String(e) }));
    console.log('Pre-submit state:', JSON.stringify(preSubmitState));
    result.preSubmitState = preSubmitState;

    await submitBtn.click();
    console.log('✅ Gönder butonuna tıklandı');
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
    } else {
      const errorTexts = await page.locator('text=/hata|error|başarısız|geçersiz|uyarı/i')
        .allTextContents().catch(() => []);
      const failScreenshot = await page.screenshot({ fullPage: false })
        .then(buf => buf.toString('base64')).catch(() => null);
      return {
        ok: false, status: 500,
        error: 'Submit sonrası confirmation görülmedi',
        currentUrl: page.url(),
        errorTexts: errorTexts.filter(Boolean),
        failScreenshot,
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

    // Delivery date dropdown scope'unu tara
    const deliveryDateScope = await page.evaluate(() => {
      try {
        const dropdown = document.querySelector('[data-cy="delivery-date-dropdown"]');
        if (!dropdown) return { error: 'dropdown not found' };
        let scope = angular.element(dropdown).scope();
        let depth = 0;
        const result = { levels: [] };
        while (scope && depth < 20) {
          const keys = Object.keys(scope).filter(k => !k.startsWith('$'));
          const dateKeys = keys.filter(k =>
            k.toLowerCase().includes('date') ||
            k.toLowerCase().includes('delivery') ||
            k.toLowerCase().includes('slot')
          );
          if (dateKeys.length > 0) {
            const level = { depth, keys: dateKeys, values: {} };
            dateKeys.forEach(k => {
              const val = scope[k];
              if (Array.isArray(val)) {
                level.values[k] = val.slice(0, 3).map(d =>
                  typeof d === 'object' ? JSON.stringify(d).slice(0, 300) : d
                );
              } else if (typeof val !== 'function') {
                level.values[k] = typeof val === 'object' ?
                  JSON.stringify(val).slice(0, 300) : val;
              }
            });
            result.levels.push(level);
          }
          scope = scope.$parent;
          depth++;
        }
        return result;
      } catch(e) { return { error: e.message }; }
    }).catch(e => ({ error: String(e) }));

    return res.json({
      ok: true,
      currentUrl: page.url(),
      submitBtnState,
      angularScope,
      deliveryDateScope,
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
