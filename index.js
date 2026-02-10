const express = require("express");
const { chromium } = require("playwright");
const crypto = require("crypto");

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
const jobs = new Map();
/*
job = {
  ok: true,
  jobId,
  status: 'running' | 'done' | 'error',
  createdAt,
  updatedAt,
  result: any
}
*/

function makeJob() {
  const jobId = crypto.randomBytes(8).toString("hex");
  const now = Date.now();
  const job = { ok: true, jobId, status: "running", createdAt: now, updatedAt: now, result: null };
  jobs.set(jobId, job);
  return job;
}

function finishJob(jobId, status, result) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = status;
  job.result = result;
  job.updatedAt = Date.now();
  jobs.set(jobId, job);
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
// Find product row robustly
// --------------------
async function findProductRow(page, productCode) {
  // 1) direct id
  const direct = page.locator(`#product-list-${productCode}`).first();
  if ((await direct.count().catch(() => 0)) > 0) return direct;

  // 2) fallback: search within all product-list tbody and match by product code label
  const all = page.locator('tbody[id^="product-list-"]');
  const count = await all.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const candidate = all.nth(i);
    const codeEl = candidate.locator('[data-cy="product-code"]').first();
    const text = await codeEl.textContent().catch(() => "");
    if ((text || "").trim().toUpperCase() === String(productCode).trim().toUpperCase()) {
      return candidate;
    }
  }

  return null;
}

// --------------------
// Scope finder by UOM inside product row
// --------------------
async function getScopeHandleByUom(rowLocator, uom) {
  // rowLocator is locator of the product's tbody
  const rowHandle = await rowLocator.elementHandle();
  if (!rowHandle) return null;

  const scopeHandle = await rowHandle.evaluateHandle((tbody, uomText) => {
    const wanted = String(uomText || "").trim().toUpperCase();

    // find ".UOM .type" node matching wanted
    const uomNodes = Array.from(tbody.querySelectorAll(".UOM .type"));
    const match = uomNodes.find((el) => (el.textContent || "").trim().toUpperCase() === wanted);
    if (!match) return null;

    // walk to nearest TR around this UOM
    const tr = match.closest("tr");
    if (!tr) return tbody;

    // sometimes controls are not in the same tr; scan current + next siblings
    let cur = tr;
    for (let i = 0; i < 8; i++) {
      if (!cur) break;

      const hasCtl =
        cur.querySelector('[data-cy="click-set-add-stateprice"]') ||
        cur.querySelector('[data-cy="click-increase-qtyprice"]') ||
        cur.querySelector('[data-cy="click-decrease-qtyprice"]') ||
        cur.querySelector('[data-cy="click-input-qty"]');

      if (hasCtl) return cur;

      cur = cur.nextElementSibling;
    }

    // fallback
    return tbody;
  }, uom);

  return scopeHandle?.asElement() ? scopeHandle : null;
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

// ✅ SET QTY (job) - sadece qty ayarla, DUR
app.post("/set-qty", async (req, res) => {
  const job = makeJob();

  // hızlı yanıt
  res.json({
    ok: true,
    jobId: job.jobId,
    statusUrl: `/job/${job.jobId}`,
    note: "Job başlatıldı. Sonucu GET /job/:id ile sorgula.",
  });

  // job async run
  (async () => {
    const { username, password, productCode, targetQty = 5 } = req.body;
    const uom = (req.body.uom || "ADET").toString().toUpperCase().trim();

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(45000);

    const sleep = (ms) => page.waitForTimeout(ms);

    try {
      // 1) login
      const loginResult = await withTimeout(login(page, username, password), 45000);
      if (!loginResult.loggedIn) {
        finishJob(job.jobId, "error", { ok: false, step: "login", status: 401, ...loginResult });
        return;
      }

      // 2) go product search
      const productUrl = `https://www.mybidfood.com.tr/#/products/search/?searchTerm=${encodeURIComponent(
        productCode
      )}&category=All&page=1&useUrlParams=true`;

      await page.goto(productUrl, { waitUntil: "domcontentloaded" });
      await sleep(1500);

      // 3) find product row robustly
      const row = await findProductRow(page, productCode);
      if (!row) {
        finishJob(job.jobId, "error", {
          ok: false,
          status: 404,
          error: `Ürün bloğu yok: ${productCode}`,
          productUrl,
        });
        return;
      }

      // 4) scope by uom
      const scopeHandle = await getScopeHandleByUom(row, uom);
      if (!scopeHandle) {
        finishJob(job.jobId, "error", {
          ok: false,
          status: 404,
          error: `UOM bulunamadı: ${uom} (ürün: ${productCode})`,
          productUrl,
        });
        return;
      }

      // helper: query within scope (DOM)
      const q = async (selector) => {
        const h = await scopeHandle.evaluateHandle((root, sel) => root.querySelector(sel), selector);
        return h.asElement();
      };

      const readQty = async () => {
        const inp = await q('input[data-cy="click-input-qty"]');
        if (!inp) return null;
        const v = await inp.evaluate((n) => parseInt(n.value || "0", 10));
        return Number.isFinite(v) ? v : null;
      };

      const clickMinus = async () => {
        const minus = await q('button[data-cy="click-decrease-qtyprice"]');
        if (!minus) return false;
        await minus.click({ force: true });
        return true;
      };

      const clickPlus = async () => {
        const plus = await q('button[data-cy="click-increase-qtyprice"]');
        if (!plus) throw new Error("Plus yok (scope içinde)");
        await plus.click({ force: true });
      };

      // 5) ensure start from 1 (stabilize)
      let safety = 25;
      while (safety-- > 0) {
        const cur = await readQty();
        if (cur === null || cur <= 1) break;
        const ok = await clickMinus();
        if (!ok) break;
        await sleep(WAIT);
      }

      // 6) increase to target
      for (let i = 0; i < Math.max(0, targetQty - 1); i++) {
        await clickPlus();
        await sleep(WAIT);
      }

      const finalQty = await readQty();

      // ✅ DUR: sepete ekleme yok
      finishJob(job.jobId, "done", {
        ok: true,
        productCode,
        uom,
        targetQty,
        finalQty,
        productUrl,
        note: "Qty hedefe getirildi, sepete ekleme yapılmadı.",
      });
    } catch (e) {
      finishJob(job.jobId, "error", { ok: false, status: 500, error: String(e) });
    } finally {
      await browser.close().catch(() => {});
    }
  })().catch((e) => {
    finishJob(job.jobId, "error", { ok: false, status: 500, error: String(e) });
  });
});

// ✅ JOB STATUS
app.get("/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, status: 404, error: "Job not found" });
  res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
