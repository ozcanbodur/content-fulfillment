const express = require("express");
const crypto = require("crypto");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("OK"));

// =====================
// Helpers
// =====================
function withTimeout(promise, ms, label = "FLOW_TIMEOUT") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

const WAIT = 10000; // min 10 sn (kullanıcı isteği)
const JOB_TTL_MS = 10 * 60 * 1000; // 10 dk

const jobs = new Map(); // jobId -> {status, createdAt, updatedAt, result}

function newJobId() {
  return crypto.randomBytes(8).toString("hex");
}

function now() {
  return Date.now();
}

function cleanupJobs() {
  const t = now();
  for (const [id, j] of jobs.entries()) {
    if (t - j.updatedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

function startJob(runFn) {
  cleanupJobs();
  const jobId = newJobId();
  jobs.set(jobId, {
    ok: true,
    jobId,
    status: "running",
    createdAt: now(),
    updatedAt: now(),
    result: null,
  });

  // fire & forget (same process)
  (async () => {
    try {
      const result = await runFn();
      jobs.set(jobId, {
        ...jobs.get(jobId),
        status: "done",
        updatedAt: now(),
        result,
      });
    } catch (e) {
      jobs.set(jobId, {
        ...jobs.get(jobId),
        status: "error",
        updatedAt: now(),
        result: { ok: false, error: String(e) },
      });
    }
  })();

  return jobId;
}

app.get("/job/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ ok: false, error: "Job not found" });
  res.json(j);
});

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

  // Angular/redirect settle
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

  // SPA: ürün listesi bazen geç düşüyor → 45 sn bekle
  await page.waitForFunction(
    () => !!document.querySelector('tbody[id^="product-list-"]'),
    null,
    { timeout: 45000 }
  );
  await page.waitForTimeout(1500);

  return productUrl;
}

async function findPriceRowForUom(page, productCode, uom) {
  const row = page.locator(`#product-list-${productCode}`).first();
  const exists = await row.count();
  if (!exists) {
    const afterUrl = page.url();
    const listCount = await page.locator('tbody[id^="product-list-"]').count().catch(() => 0);
    return {
      ok: false,
      status: 404,
      error: `Ürün bloğu yok: ${productCode}`,
      afterUrl,
      listCount,
    };
  }

  // Aynı product tbody içinde birden fazla UOM blok var (ADET/KOLİ)
  // UOM yazısı (div.UOM .type) hangi bloktaysa o "price row" içinden butonları alacağız.
  const priceRow = row
    .locator("tr")
    .filter({
      has: row.locator(".UOM .type").filter({ hasText: uom }),
    })
    .first();

  const prCount = await priceRow.count().catch(() => 0);
  if (!prCount) {
    // Debug: hangi uomlar var?
    const uoms = await row.locator(".UOM .type").allTextContents().catch(() => []);
    return {
      ok: false,
      status: 404,
      error: `UOM bulunamadı: ${uom}`,
      availableUoms: uoms.map((s) => (s || "").trim()).filter(Boolean),
    };
  }

  return { ok: true, row, priceRow };
}

async function setQtyInPriceRow(page, priceRow, targetQty) {
  const sleep = (ms) => page.waitForTimeout(ms);

  const getInput = () => priceRow.locator('input[data-cy="click-input-qty"]').first();
  const getPlus = () => priceRow.locator('button[data-cy="click-increase-qtyprice"]').first();
  const getMinus = () => priceRow.locator('button[data-cy="click-decrease-qtyprice"]').first();

  const readQty = async () => {
    const inp = getInput();
    const c = await inp.count().catch(() => 0);
    if (!c) return null;
    const v = await inp.inputValue().catch(() => "");
    const n = parseInt((v || "").trim() || "0", 10);
    return Number.isFinite(n) ? n : null;
  };

  // Önce mümkünse 1'e indir (stabil başlangıç)
  for (let safety = 0; safety < 30; safety++) {
    const cur = await readQty();
    if (cur === null || cur <= 1) break;
    const minus = getMinus();
    if (!(await minus.count().catch(() => 0))) break;
    await minus.click({ force: true }).catch(() => {});
    await sleep(WAIT);
  }

  // Sonra + ile hedefe çık
  const steps = Math.max(0, targetQty - 1);
  for (let i = 0; i < steps; i++) {
    const plus = getPlus();
    const pc = await plus.count().catch(() => 0);
    if (!pc) throw new Error("Plus butonu yok");
    await plus.click({ force: true });
    await sleep(WAIT);
  }

  const finalQty = await readQty();
  return finalQty;
}

// =====================
// Endpoints
// =====================

// ✅ LOGIN TEST (anında response)
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
    const result = await withTimeout(login(page, username, password), 45000);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// ✅ Qty set et (sepete ekleme YOK) — Job
app.post("/set-qty", async (req, res) => {
  const { username, password, productCode, uom = "ADET", targetQty = 5 } = req.body;

  const jobId = startJob(async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(25000);
    page.setDefaultNavigationTimeout(45000);

    try {
      const loginResult = await withTimeout(login(page, username, password), 60000);
      if (!loginResult.loggedIn) {
        return { ok: false, step: "login", ...loginResult };
      }

      const productUrl = await gotoProductSearch(page, productCode);

      const found = await findPriceRowForUom(page, productCode, uom);
      if (!found.ok) {
        return { ok: false, ...found, productUrl };
      }

      const finalQty = await setQtyInPriceRow(page, found.priceRow, targetQty);

      // BURADA DURUYORUZ (sepete ekleme yok)
      return {
        ok: true,
        productCode,
        uom,
        targetQty,
        finalQty,
        productUrl,
        afterUrl: page.url(),
        note: "Qty hedefe getirildi. Sepete ekleme yapılmadı.",
      };
    } finally {
      await browser.close().catch(() => {});
    }
  });

  res.json({
    ok: true,
    jobId,
    statusUrl: `/job/${jobId}`,
    note: "Job başlatıldı. Sonucu GET /job/:id ile sorgula.",
  });
});

// ✅ Qty set + Sepete ekle — Job
app.post("/add-to-cart", async (req, res) => {
  const { username, password, productCode, uom = "ADET", qty = 1 } = req.body;

  const jobId = startJob(async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(25000);
    page.setDefaultNavigationTimeout(45000);

    try {
      const loginResult = await withTimeout(login(page, username, password), 60000);
      if (!loginResult.loggedIn) {
        return { ok: false, step: "login", ...loginResult };
      }

      const productUrl = await gotoProductSearch(page, productCode);

      const found = await findPriceRowForUom(page, productCode, uom);
      if (!found.ok) {
        return { ok: false, ...found, productUrl };
      }

      const finalQty = await setQtyInPriceRow(page, found.priceRow, qty);

      // Add button
      const addBtn = found.priceRow.locator('button[data-cy="click-set-add-stateprice"]').first();
      const addCount = await addBtn.count().catch(() => 0);
      if (!addCount) {
        return {
          ok: false,
          status: 500,
          error: "Add butonu yok",
          productUrl,
        };
      }

      await addBtn.scrollIntoViewIfNeeded().catch(() => {});
      await addBtn.click({ force: true });

      // UI bazen qty'yi 1'e resetler (normal). Sepete gidip gitmediğini burada garanti edemeyiz,
      // ama en azından click gerçekleşti.
      await page.waitForTimeout(WAIT);

      return {
        ok: true,
        productCode,
        uom,
        requestedQty: qty,
        finalQty: finalQty,
        productUrl,
        afterUrl: page.url(),
        note: "Butona tıklandı (Ekle/Ön Sipariş). UI qty reset olabilir (normal).",
      };
    } finally {
      await browser.close().catch(() => {});
    }
  });

  res.json({
    ok: true,
    jobId,
    statusUrl: `/job/${jobId}`,
    note: "Job başlatıldı. Sonucu GET /job/:id ile sorgula.",
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
