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
  await sleep(page, WAIT_STEP_MS);

  const row = page.locator(`#product-list-${productCode}`).first();
  if ((await row.count()) === 0) {
    return { ok: false, status: 404, productCode, uom, error: `Ürün bloğu yok: ${productCode}`, productUrl };
  }

  const uomUpper = String(uom).trim().toUpperCase();
  const uomType = row.locator(".UOM .type").filter({
    hasText: uomUpper,
  }).first();

  if ((await uomType.count()) === 0) {
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

  const scope = uomType.locator("xpath=ancestor::tr[1]").first();

  const addBtn = scope.locator('button[data-cy="click-set-add-stateprice"]').first();
  const plusBtn = scope.locator('button[data-cy="click-increase-qtyprice"]').first();
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

  await page.goto(deliveryUrl, { waitUntil: "domcontentloaded" });
  await sleep(page, waitBefore);

  // 1) orderreference yaz
  if (orderRef && String(orderRef).trim().length > 0) {
    const ref = page.locator('input[name="orderreference"]').first();
    await ref.waitFor({ state: "attached", timeout: 60000 });

    await ref.scrollIntoViewIfNeeded().catch(() => {});
    await ref.click({ force: true }).catch(() => {});
    await sleep(page, 150);

    await ref.fill("").catch(async () => {
      await ref.evaluate((el) => {
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });

    const text = String(orderRef);
    for (const ch of text) {
      await ref.type(ch, { delay: 20 }).catch(async () => {
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
    let hitLi = menu.locator("li").filter({ hasText: wanted }).first();
    
    if ((await hitLi.count()) === 0) {
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

  // 3) ✅ YENİ: Gönder butonunun TÜM detaylarını al
  if (submit) {
    const submitBtn = page.locator('[data-cy="click-submit-orderaccount-submit"]').first();
    await submitBtn.waitFor({ state: "attached", timeout: 60000 });

    // ✅ Butonun tüm bilgilerini al
    const buttonInfo = await submitBtn.evaluate((el) => {
      return {
        outerHTML: el.outerHTML,
        innerHTML: el.innerHTML,
        disabled: el.disabled,
        className: el.className,
        attributes: Array.from(el.attributes).map(attr => ({
          name: attr.name,
          value: attr.value
        })),
        computedStyle: {
          display: window.getComputedStyle(el).display,
          visibility: window.getComputedStyle(el).visibility,
          opacity: window.getComputedStyle(el).opacity,
          pointerEvents: window.getComputedStyle(el).pointerEvents,
        },
        parentHTML: el.parentElement ? el.parentElement.outerHTML : null,
        // Angular scope bilgisi
        angularScope: (() => {
          try {
            const scope = angular.element(el).scope();
            return {
              hasScope: !!scope,
              hasSubmitFunction: scope && typeof scope.submit === 'function',
              scopeKeys: scope ? Object.keys(scope).filter(k => !k.startsWith('$')) : []
            };
          } catch (e) {
            return { error: e.message };
          }
        })()
      };
    });

    result.buttonDebugInfo = buttonInfo;

    // Artık submit yapmadan dönsün, sadece button bilgisi alsın
    return result;
  }

  return result;
}

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
