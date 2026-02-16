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

  // Direkt delivery sayfasına git
  await page.goto(deliveryUrl, { waitUntil: "domcontentloaded" });
  await sleep(page, waitBefore);

  // 1) orderreference yaz
  if (orderRef && String(orderRef).trim().length > 0) {
    const ref = page.locator('input[name="orderreference"]').first();
    await ref.waitFor({ state: "attached", timeout: 60000 });

    await ref.scrollIntoViewIfNeeded().catch(() => {});
    await ref.click({ force: true }).catch(() => {});
    await sleep(page, 150);

    // Select all + clear
    await ref.fill("").catch(async () => {
      // fallback: input event
      await ref.evaluate((el) => {
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });

    // "typing" benzeri akış
    const text = String(orderRef);
    for (const ch of text) {
      await ref.type(ch, { delay: 20 }).catch(async () => {
        // fallback type çalışmazsa value append
        await ref.evaluate((el, c) => {
          el.value = (el.value || "") + c;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }, ch);
      });
    }

    await ref.dispatchEvent("change").catch(() => {});
    await ref.dispatchEvent("blur").catch(() => {});
    result.orderRefSet = true;

    await sleep(page, 500);
  }

  // 2) teslim tarihi seç
  if (deliveryDateText && String(deliveryDateText).trim().length > 0) {
    const btn = page.locator('[data-cy="delivery-date-dropdown"]').first();
    await btn.waitFor({ state: "attached", timeout: 60000 });

    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ force: true }).catch(() => {});
    await sleep(page, 500);

    const menu = page.locator('ul[data-cy="delivery-date-menu"]').first();
    await menu.waitFor({ state: "attached", timeout: 60000 });

    const allOptions = await menu.locator("li").allTextContents().catch(() => []);

    const wanted = String(deliveryDateText).trim();
    
    // Hem tam eşleşme hem de partial eşleşme dene
    let hitLi = menu.locator("li").filter({ hasText: wanted }).first();
    
    if ((await hitLi.count()) === 0) {
      // Tam eşleşme yoksa, partial dene
      const dayMatch = wanted.match(/(\d+)/);
      if (dayMatch) {
        const day = dayMatch[1];
        hitLi = menu.locator("li").filter({ hasText: day }).first();
      }
    }

    if ((await hitLi.count()) === 0) {
      return {
        ok: false,
        status: 404,
        error: `Tarih bulunamadı: ${wanted}`,
        availableDates: allOptions.map((x) => (x || "").trim()).filter(Boolean),
        ...result,
      };
    }

    const selectedText = await hitLi.textContent().catch(() => "");

    await hitLi.scrollIntoViewIfNeeded().catch(() => {});
    await hitLi.click({ force: true }).catch(() => {});
    await sleep(page, 800);

    result.deliveryDateSelected = true;
    result.selectedDateText = selectedText;
    
    // Form validation trigger
    await page.evaluate(() => {
      try {
        const inputs = document.querySelectorAll('input, select');
        inputs.forEach(input => {
          input.dispatchEvent(new Event('blur', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        
        const scope = angular.element(document.body).scope();
        if (scope) {
          scope.$apply();
        }
        
        const forms = document.querySelectorAll('form');
        forms.forEach(form => {
          const formScope = angular.element(form).scope();
          if (formScope && formScope.$$childHead && formScope.$$childHead.$validate) {
            formScope.$$childHead.$validate();
          }
        });
      } catch (e) {
        console.log("Validation trigger hatası:", e);
      }
    }).catch(() => {});
    
    await sleep(page, 5000);
  }

  // 3) Gönder - ✅ ANGULAR submitOrder FONKSIYONUNU ÇAĞIR
  if (submit) {
    const submitBtn = page.locator('[data-cy="click-submit-orderaccount-submit"]').first();
    await submitBtn.waitFor({ state: "attached", timeout: 60000 });

    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(page, 5000); // Uzun bekle - Angular hazır olsun

    // ✅ Angular submitOrder fonksiyonunu direkt çağır
    const submitted = await page.evaluate(() => {
      try {
        const btn = document.querySelector('[data-cy="click-submit-orderaccount-submit"]');
        if (!btn) return 'button-not-found';
        
        const scope = angular.element(btn).scope();
        if (!scope) return 'scope-not-found';
        
        // submitOrder fonksiyonunu bul
        if (typeof scope.submitOrder === 'function') {
          // account parametresini scope'tan al
          const account = scope.account || scope.$parent.account || (scope.accounts && scope.accounts[0]);
          scope.submitOrder(account, 'submit');
          scope.$apply();
          return 'submitOrder-called';
        }
        
        // Parent scope'ta dene
        let parent = scope.$parent;
        let depth = 0;
        while (parent && depth < 10) {
          if (typeof parent.submitOrder === 'function') {
            const account = parent.account || (parent.accounts && parent.accounts[0]);
            parent.submitOrder(account, 'submit');
            parent.$apply();
            return 'parent-submitOrder-called';
          }
          parent = parent.$parent;
          depth++;
        }
        
        return 'submitOrder-not-found';
        
      } catch (e) {
        return 'error: ' + e.message;
      }
    });

    console.log('✅ Submit result:', submitted);
    await sleep(page, 3000);

    // Confirmation bekle
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
      result.submitMethod = submitted;
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
        submitMethod: submitted,
        errorTexts: errorTexts.filter(Boolean),
        ...result 
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
