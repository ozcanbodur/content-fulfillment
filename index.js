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

const WAIT = 10000; // min 10 sn

// -------------------- JOB STORE (in-memory) --------------------
const jobs = new Map();
function newJobId() {
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}
function setJob(id, patch) {
  const cur = jobs.get(id) || {};
  jobs.set(id, { ...cur, ...patch, updatedAt: Date.now() });
}

app.get("/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
  res.json({ ok: true, jobId: req.params.id, ...job });
});

// -------------------- HELPERS --------------------
const norm = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

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

async function sleep(page, ms) {
  await page.waitForTimeout(ms);
}

/**
 * HTML yapına göre:
 * - product block: tbody#product-list-IT1140
 * - UOM satırları: tr[ng-repeat-end][ng-form="form"]
 * - UOM text: .UOM .type.bold (ADET / KOLİ)
 * - qty input: input[data-cy="click-input-qty"]
 * - add button: button[data-cy="click-set-add-stateprice"]
 */
async function findUomRowScope(page, productCode, wantedUom) {
  const productSel = `#product-list-${productCode}`;

  // SPA/Angular render gecikmesi olabiliyor
  const productTbody = page.locator(productSel).first();
  await productTbody.waitFor({ state: "attached", timeout: 30000 });

  // UOM satırlarını al
  const uomRows = productTbody.locator('tr[ng-repeat-end][ng-form="form"]');
  const count = await uomRows.count().catch(() => 0);

  if (!count) {
    return {
      ok: false,
      status: 404,
      error: `UOM satırları bulunamadı (ng-repeat-end/ng-form)`,
      productSel,
      availableUoms: [],
    };
  }

  const availableUoms = [];
  const target = norm(wantedUom);

  for (let i = 0; i < count; i++) {
    const row = uomRows.nth(i);

    const uomText = await row
      .locator(".UOM .type.bold")
      .first()
      .innerText()
      .catch(() => "");

    const uom = norm(uomText);
    if (uom) availableUoms.push(uom);

    if (uom === target) {
      // Bu row içinde input + add button var mı?
      const input = row.locator('input[data-cy="click-input-qty"]').first();
      const addBtn = row.locator('button[data-cy="click-set-add-stateprice"]').first();

      const hasInput = (await input.count().catch(() => 0)) > 0;
      const hasAdd = (await addBtn.count().catch(() => 0)) > 0;

      if (!hasInput || !hasAdd) {
        return {
          ok: false,
          status: 404,
          error: `UOM satırı bulundu ama input/add eksik (uom=${target})`,
          availableUoms: [...new Set(availableUoms)],
        };
      }

      return {
        ok: true,
        row,
        input,
        addBtn,
        uom,
        availableUoms: [...new Set(availableUoms)],
      };
    }
  }

  return {
    ok: false,
    status: 404,
    error: `UOM bulunamadı: ${target}`,
    availableUoms: [...new Set(availableUoms)],
  };
}

async function setQtyAngularSafe(page, inputLocator, targetQty) {
  const qty = Math.max(1, parseInt(targetQty, 10) || 1);

  // input görünür olmalı
  await inputLocator.waitFor({ state: "visible", timeout: 30000 });

  // Angular ng-model için en stabil yöntem: value set + input/change/blur
  await inputLocator.scrollIntoViewIfNeeded().catch(() => {});
  await inputLocator.click({ clickCount: 3 }).catch(() => {});
  await inputLocator.fill(String(qty)).catch(async () => {
    // bazı durumlarda fill çalışmazsa evaluate ile value bas
    await inputLocator.evaluate((el, v) => {
      el.value = v;
    }, String(qty));
  });

  await inputLocator.evaluate((el) => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  });

  // Angular digest/render için min bekleme
  await sleep(page, WAIT);

  // okuma
  const finalQty = await inputLocator.evaluate((el) => parseInt(el.value || "0", 10)).catch(() => null);
  return { requestedQty: qty, finalQty };
}

// -------------------- ENDPOINTS --------------------

// LOGIN TEST
app.post("/login-test", async (req, res) => {
  const { username, password } = req.body;

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(30000);

  try {
    const result = await withTimeout(login(page, username, password), 35000);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

/**
 * POST /set-qty
 * body: { username, password, productCode, uom:"ADET"|"KOLİ", targetQty:9 }
 * job başlatır
 */
app.post("/set-qty", (req, res) => {
  const jobId = newJobId();
  setJob(jobId, { status: "running", createdAt: Date.now(), result: null });

  res.json({
    ok: true,
    jobId,
    statusUrl: `/job/${jobId}`,
    note: "Job başlatıldı. Sonucu GET /job/:id ile sorgula.",
  });

  (async () => {
    const { username, password, productCode, uom = "ADET", targetQty = 5 } = req.body || {};

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(25000);
    page.setDefaultNavigationTimeout(40000);

    try {
      const loginResult = await withTimeout(login(page, username, password), 40000);
      if (!loginResult.loggedIn) {
        setJob(jobId, {
          status: "error",
          result: { ok: false, status: 401, step: "login", ...loginResult },
        });
        return;
      }

      const productUrl = `https://www.mybidfood.com.tr/#/products/search/?searchTerm=${encodeURIComponent(
        productCode
      )}&category=All&page=1&useUrlParams=true`;

      await page.goto(productUrl, { waitUntil: "domcontentloaded" });
      await sleep(page, 2000);

      // product block bekle (Angular geç render edebilir)
      const productTbody = page.locator(`#product-list-${productCode}`).first();
      const exists = await productTbody.count().catch(() => 0);
      if (!exists) {
        // biraz daha bekleyip tekrar bak
        await sleep(page, WAIT);
      }

      const exists2 = await productTbody.count().catch(() => 0);
      if (!exists2) {
        setJob(jobId, {
          status: "error",
          result: { ok: false, status: 404, error: `Ürün bloğu yok: ${productCode}`, productUrl },
        });
        return;
      }

      const scope = await findUomRowScope(page, productCode, uom);
      if (!scope.ok) {
        setJob(jobId, {
          status: "error",
          result: { ok: false, status: scope.status || 404, error: scope.error, availableUoms: scope.availableUoms, productUrl },
        });
        return;
      }

      const { requestedQty, finalQty } = await setQtyAngularSafe(page, scope.input, targetQty);

      setJob(jobId, {
        status: "done",
        result: {
          ok: true,
          mode: "set-qty",
          productCode,
          uom: scope.uom,
          requestedQty,
          finalQty,
          productUrl,
          note: "Qty ayarlandı. Sepete ekleme yapılmadı.",
        },
      });
    } catch (e) {
      setJob(jobId, { status: "error", result: { ok: false, error: String(e) } });
    } finally {
      await browser.close();
    }
  })();
});

/**
 * POST /add-to-cart
 * body: { username, password, productCode, uom:"ADET"|"KOLİ", qty:5 }
 * job başlatır
 */
app.post("/add-to-cart", (req, res) => {
  const jobId = newJobId();
  setJob(jobId, { status: "running", createdAt: Date.now(), result: null });

  res.json({
    ok: true,
    jobId,
    statusUrl: `/job/${jobId}`,
    note: "Job başlatıldı. Sonucu GET /job/:id ile sorgula.",
  });

  (async () => {
    const { username, password, productCode, uom = "ADET", qty = 1 } = req.body || {};

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(25000);
    page.setDefaultNavigationTimeout(40000);

    try {
      const loginResult = await withTimeout(login(page, username, password), 40000);
      if (!loginResult.loggedIn) {
        setJob(jobId, {
          status: "error",
          result: { ok: false, status: 401, step: "login", ...loginResult },
        });
        return;
      }

      const productUrl = `https://www.mybidfood.com.tr/#/products/search/?searchTerm=${encodeURIComponent(
        productCode
      )}&category=All&page=1&useUrlParams=true`;

      await page.goto(productUrl, { waitUntil: "domcontentloaded" });
      await sleep(page, 2000);

      const productTbody = page.locator(`#product-list-${productCode}`).first();
      const exists = await productTbody.count().catch(() => 0);
      if (!exists) {
        await sleep(page, WAIT);
      }

      const exists2 = await productTbody.count().catch(() => 0);
      if (!exists2) {
        setJob(jobId, {
          status: "error",
          result: { ok: false, status: 404, error: `Ürün bloğu yok: ${productCode}`, productUrl },
        });
        return;
      }

      const scope = await findUomRowScope(page, productCode, uom);
      if (!scope.ok) {
        setJob(jobId, {
          status: "error",
          result: { ok: false, status: scope.status || 404, error: scope.error, availableUoms: scope.availableUoms, productUrl },
        });
        return;
      }

      const { requestedQty, finalQty } = await setQtyAngularSafe(page, scope.input, qty);

      // Ekle / Ön Sipariş tıkla
      await scope.addBtn.scrollIntoViewIfNeeded().catch(() => {});
      await scope.addBtn.click({ force: true }).catch(async () => {
        // bazen overlay yüzünden click kaçırır
        await scope.addBtn.evaluate((btn) => btn.click());
      });

      // Sepete yansıması için bekle
      await sleep(page, WAIT);

      setJob(jobId, {
        status: "done",
        result: {
          ok: true,
          mode: "add-to-cart",
          productCode,
          uom: scope.uom,
          requestedQty,
          finalQty,
          productUrl,
          note:
            "Qty ayarlandı ve Ekle/Ön Sipariş butonuna tıklandı. UI ekleme sonrası qty reset olabilir; önemli olan sepet sonucudur.",
        },
      });
    } catch (e) {
      setJob(jobId, { status: "error", result: { ok: false, error: String(e) } });
    } finally {
      await browser.close();
    }
  })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
