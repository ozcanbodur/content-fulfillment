const express = require("express");
const crypto = require("crypto");
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

// --------------------
// Simple in-memory job store
// --------------------
const JOBS = new Map(); // jobId -> { status, createdAt, updatedAt, result }

function newJob() {
  const jobId = crypto.randomBytes(8).toString("hex");
  const now = Date.now();
  JOBS.set(jobId, { status: "running", createdAt: now, updatedAt: now, result: null });
  return jobId;
}

function setJob(jobId, patch) {
  const cur = JOBS.get(jobId);
  if (!cur) return;
  JOBS.set(jobId, { ...cur, ...patch, updatedAt: Date.now() });
}

// --------------------
// Login helper
// --------------------
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

// --------------------
// Core: open qty panel (Ekle), pick UOM block, set qty with +
// --------------------
async function openQtyPanelAndSetQty({ page, productCode, uom, targetQty }) {
  const productUrl = `https://www.mybidfood.com.tr/#/products/search/?searchTerm=${encodeURIComponent(
    productCode
  )}&category=All&page=1&useUrlParams=true`;

  await page.goto(productUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const productRow = page.locator(`#product-list-${productCode}`).first();
  const rowCount = await productRow.count();
  if (!rowCount) {
    const err = new Error(`Ürün bloğu yok: ${productCode}`);
    err.status = 404;
    err.productUrl = productUrl;
    throw err;
  }

  await productRow.waitFor({ state: "visible", timeout: 30000 });

  // UOM blocks are per price row: tr[ng-repeat-end][ng-form="form"]
  const uomBlocks = productRow.locator('tr[ng-repeat-end][ng-form="form"]');
  const blockCount = await uomBlocks.count();

  if (!blockCount) {
    const err = new Error("UOM blokları bulunamadı (ng-repeat-end/ng-form=form yok).");
    err.status = 404;
    err.productUrl = productUrl;
    throw err;
  }

  let chosen = null;
  const availableUoms = [];

  for (let i = 0; i < blockCount; i++) {
    const blk = uomBlocks.nth(i);
    const uomText = (await blk.locator(".UOM .type.bold").first().innerText().catch(() => "")).trim();
    if (uomText) availableUoms.push(uomText);

    if (String(uomText).toUpperCase() === String(uom).toUpperCase()) {
      chosen = blk;
      break;
    }
  }

  if (!chosen) {
    const uniq = [...new Set(availableUoms.filter(Boolean))];
    const err = new Error(`UOM bulunamadı: ${uom}`);
    err.status = 404;
    err.availableUoms = uniq;
    err.productUrl = productUrl;
    throw err;
  }

  const addBtn = chosen.locator('button[data-cy="click-set-add-stateprice"]').first();
  const plusBtn = chosen.locator('button[data-cy="click-increase-qtyprice"]').first();
  const qtyInp = chosen.locator('input[data-cy="click-input-qty"]').first();

  // 1) OPEN PANEL: click "Ekle" once (this usually adds 1 AND opens qty panel)
  await addBtn.scrollIntoViewIfNeeded();
  await addBtn.click({ timeout: 15000 });

  // min 10 sec wait
  await page.waitForTimeout(WAIT);

  // 2) Ensure input is visible (if not, poke add once more)
  try {
    await qtyInp.waitFor({ state: "visible", timeout: 30000 });
  } catch {
    await addBtn.click({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(WAIT);
    await qtyInp.waitFor({ state: "visible", timeout: 30000 });
  }

  // 3) Increase to target (default starts at 1 after first add)
  const steps = Math.max(0, Number(targetQty) - 1);
  for (let k = 0; k < steps; k++) {
    await plusBtn.click({ timeout: 15000 });
    await page.waitForTimeout(WAIT);
  }

  const finalQty = await qtyInp.inputValue().catch(() => "");
  return {
    ok: true,
    productCode,
    uom,
    targetQty: Number(targetQty),
    finalQty,
    productUrl,
    note: "Önce Ekle ile panel açıldı, sonra + ile hedef qty’ye getirildi.",
  };
}

// 4) Finalize add-to-cart (some UIs require a second click on Ekle/Ön Sipariş after qty set)
async function finalizeAddToCart({ page, productCode, uom }) {
  // We re-find the same block and click addBtn once more.
  const productRow = page.locator(`#product-list-${productCode}`).first();
  await productRow.waitFor({ state: "visible", timeout: 30000 });

  const uomBlocks = productRow.locator('tr[ng-repeat-end][ng-form="form"]');
  const blockCount = await uomBlocks.count();
  if (!blockCount) throw new Error("Finalize: UOM blokları bulunamadı.");

  let chosen = null;
  for (let i = 0; i < blockCount; i++) {
    const blk = uomBlocks.nth(i);
    const uomText = (await blk.locator(".UOM .type.bold").first().innerText().catch(() => "")).trim();
    if (String(uomText).toUpperCase() === String(uom).toUpperCase()) {
      chosen = blk;
      break;
    }
  }
  if (!chosen) throw new Error(`Finalize: UOM bulunamadı: ${uom}`);

  const addBtn = chosen.locator('button[data-cy="click-set-add-stateprice"]').first();
  await addBtn.scrollIntoViewIfNeeded();
  await addBtn.click({ timeout: 15000 });
  await page.waitForTimeout(WAIT);

  return { ok: true, note: "Sepete ekleme/ön sipariş finalize için tekrar Ekle tıklandı." };
}

// --------------------
// Endpoints
// --------------------

// ✅ SADECE LOGIN TEST
app.post("/login-test", async (req, res) => {
  const { username, password } = req.body;

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

// ✅ Job status
app.get("/job/:id", (req, res) => {
  const job = JOBS.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
  res.json({ ok: true, jobId: req.params.id, ...job });
});

// ✅ SET QTY ONLY (job) — sepete ekleme finalize yok, qty hedefe gelince durur
app.post("/set-qty", (req, res) => {
  const { username, password, productCode, uom = "ADET", targetQty = 5 } = req.body || {};
  const jobId = newJob();

  res.json({
    ok: true,
    jobId,
    statusUrl: `/job/${jobId}`,
    note: "Job başlatıldı. Sonucu GET /job/:id ile sorgula.",
  });

  (async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(45000);

    try {
      const loginResult = await withTimeout(login(page, username, password), 45000);
      if (!loginResult.loggedIn) {
        setJob(jobId, { status: "error", result: { ok: false, status: 401, step: "login", ...loginResult } });
        return;
      }

      const result = await withTimeout(
        openQtyPanelAndSetQty({ page, productCode, uom, targetQty }),
        180000,
        "SET_QTY_TIMEOUT"
      );

      // DUR: finalize yok
      setJob(jobId, { status: "done", result: result });
    } catch (e) {
      const payload = { ok: false, error: String(e) };
      if (e && typeof e === "object") {
        if (e.status) payload.status = e.status;
        if (e.productUrl) payload.productUrl = e.productUrl;
        if (e.availableUoms) payload.availableUoms = e.availableUoms;
      }
      setJob(jobId, { status: "error", result: payload });
    } finally {
      await browser.close().catch(() => {});
    }
  })();
});

// ✅ ADD TO CART (job) — qty ayarlar, sonra finalize click (Ekle/Ön Sipariş)
app.post("/add-to-cart", (req, res) => {
  const { username, password, productCode, uom = "ADET", qty = 1 } = req.body || {};
  const jobId = newJob();

  res.json({
    ok: true,
    jobId,
    statusUrl: `/job/${jobId}`,
    note: "Job başlatıldı. Sonucu GET /job/:id ile sorgula.",
  });

  (async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(45000);

    try {
      const loginResult = await withTimeout(login(page, username, password), 45000);
      if (!loginResult.loggedIn) {
        setJob(jobId, { status: "error", result: { ok: false, status: 401, step: "login", ...loginResult } });
        return;
      }

      const setQtyResult = await withTimeout(
        openQtyPanelAndSetQty({ page, productCode, uom, targetQty: qty }),
        180000,
        "ADD_TO_CART_SET_QTY_TIMEOUT"
      );

      // finalize: click Ekle again to commit qty to cart (UI dependent)
      const finalize = await withTimeout(
        finalizeAddToCart({ page, productCode, uom }),
        120000,
        "ADD_TO_CART_FINALIZE_TIMEOUT"
      );

      setJob(jobId, {
        status: "done",
        result: {
          ok: true,
          productCode,
          uom,
          requestedQty: Number(qty),
          setQty: setQtyResult,
          finalize,
          afterUrl: page.url(),
          note: "Qty ayarlandı ve finalize için tekrar Ekle/Ön Sipariş tıklandı.",
        },
      });
    } catch (e) {
      const payload = { ok: false, error: String(e) };
      if (e && typeof e === "object") {
        if (e.status) payload.status = e.status;
        if (e.productUrl) payload.productUrl = e.productUrl;
        if (e.availableUoms) payload.availableUoms = e.availableUoms;
      }
      setJob(jobId, { status: "error", result: payload });
    } finally {
      await browser.close().catch(() => {});
    }
  })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
