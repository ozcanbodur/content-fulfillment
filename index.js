const express = require("express");
const { chromium } = require("playwright");
const crypto = require("crypto");

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("OK"));

const WAIT = 10000; // min 10 sn

function withTimeout(promise, ms, label = "FLOW_TIMEOUT") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

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

/**
 * Qty set et, DUR (sepete ekleme yok)
 * - Plus tıklayarak artırır, her tık sonrası WAIT kadar bekler.
 * - Hedefe gelince döner.
 */
async function setQtyOnlyFlow(page, { username, password, productCode, targetQty }) {
  const sleep = (ms) => page.waitForTimeout(ms);

  const loginResult = await withTimeout(login(page, username, password), 35000);
  if (!loginResult.loggedIn) {
    return { ok: false, status: 401, step: "login", ...loginResult };
  }

  const productUrl = `https://www.mybidfood.com.tr/#/products/search/?searchTerm=${encodeURIComponent(
    productCode
  )}&category=All&page=1&useUrlParams=true`;

  await page.goto(productUrl, { waitUntil: "domcontentloaded" });
  await sleep(1500);

  const row = page.locator(`#product-list-${productCode}`).first();
  if ((await row.count()) === 0) {
    return { ok: false, status: 404, error: `Ürün bloğu yok: ${productCode}`, productUrl };
  }

  const scopeHandle = await row.evaluateHandle((tbody) => {
    const all = Array.from(tbody.querySelectorAll("*"));
    const adetHint = all.find((el) => /Birim:\s*ADET/i.test(el.innerText || ""));
    if (!adetHint) return null;
    return adetHint.closest("tbody") || tbody;
  });

  const scopeEl = scopeHandle?.asElement();
  if (!scopeEl) {
    return { ok: false, status: 404, error: "ADET satırı bulunamadı.", productUrl };
  }

  const q = async (selector) => {
    const h = await scopeEl.evaluateHandle((root, sel) => root.querySelector(sel), selector);
    return h?.asElement() || null;
  };

  const readQty = async () => {
    const inp = await q('input[data-cy="click-input-qty"]');
    if (!inp) return null;
    const val = await inp.evaluate((n) => parseInt(n.value || "0", 10));
    return Number.isFinite(val) ? val : null;
  };

  const clickPlus = async () => {
    const plus = await q('button[data-cy="click-increase-qtyprice"]');
    if (!plus) throw new Error("Plus yok");
    await plus.click({ force: true });
  };

  // Hedefe gidene kadar kontrollü artır
  const maxAttempts = Math.max(20, targetQty * 10);
  let attempts = 0;

  while (attempts++ < maxAttempts) {
    const cur = await readQty();
    if (cur === null) {
      await sleep(1000);
      continue;
    }
    if (cur >= targetQty) {
      return {
        ok: true,
        productCode,
        targetQty,
        finalQty: cur,
        productUrl,
        note: "✅ Hedef qty oldu, duruyorum. (Sepete ekleme yok.)",
      };
    }

    await clickPlus();
    await sleep(WAIT);
  }

  return {
    ok: false,
    status: 500,
    error: "Hedef qty'ye ulaşılamadı (UI lag/reset olabilir).",
    productCode,
    targetQty,
    finalQty: await readQty(),
    productUrl,
  };
}

// --------------------
// JOB SİSTEMİ (timeout çözümü)
// --------------------
const jobs = new Map(); // jobId -> {status, createdAt, updatedAt, result/error}

function newJobId() {
  return crypto.randomBytes(8).toString("hex");
}

async function runSetQtyJob(jobId, payload) {
  jobs.set(jobId, { status: "running", createdAt: Date.now(), updatedAt: Date.now() });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(30000);

  try {
    // Uzun sürebilir: targetQty 9 => ~80s + login + load
    const result = await withTimeout(
      setQtyOnlyFlow(page, payload),
      5 * 60 * 1000, // 5 dk job timeout
      "SET_QTY_JOB_TIMEOUT"
    );

    jobs.set(jobId, {
      status: result.ok ? "done" : "error",
      createdAt: jobs.get(jobId).createdAt,
      updatedAt: Date.now(),
      result,
    });
  } catch (e) {
    jobs.set(jobId, {
      status: "error",
      createdAt: jobs.get(jobId).createdAt,
      updatedAt: Date.now(),
      result: { ok: false, error: String(e) },
    });
  } finally {
    await browser.close();
  }
}

// ✅ JOB BAŞLAT: HEMEN DÖNER (502 olmaz)
app.post("/set-qty", async (req, res) => {
  const { username, password, productCode, targetQty = 5 } = req.body;
  if (!username || !password || !productCode) {
    return res.status(400).json({ ok: false, error: "username, password, productCode zorunlu" });
  }

  const jobId = newJobId();
  jobs.set(jobId, { status: "queued", createdAt: Date.now(), updatedAt: Date.now() });

  // Arkada çalıştır
  runSetQtyJob(jobId, { username, password, productCode, targetQty });

  return res.json({
    ok: true,
    jobId,
    statusUrl: `/job/${jobId}`,
    note: "Job başlatıldı. Sonucu GET /job/:id ile sorgula.",
  });
});

// ✅ JOB DURUMU / SONUÇ
app.get("/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job bulunamadı" });

  return res.json({
    ok: true,
    jobId: req.params.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result || null,
  });
});

// ✅ LOGIN TEST
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
