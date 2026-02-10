// index.js (GÜNCEL TAM HAL)
// - /login-test : login kontrol
// - /add-to-cart : login -> product search -> UOM (ADET/KOLİ) satırını seç -> önce "Ekle" ile qty alanını aç -> +/- ile qty'yi hedefe getir -> DUR (istersen add click de eklenebilir)
// - /set-qty : login -> product search -> UOM satırını seç -> önce "Ekle" ile qty alanını aç -> +/- ile qty'yi hedefe getir -> DUR (sepete ekleme yok)
// - /job/:id : background job sonucu
//
// Not: SPA/Angular yüzünden "#product-list-XXX" mutlaka waitFor ile bekleniyor.

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

const WAIT = 10000; // min 10 sn (senin kuralın)
const NAV_TIMEOUT = 90000;
const DEFAULT_TZ = "Europe/Istanbul";

// --------------------
// Basit in-memory job store
// --------------------
const JOBS = new Map(); // id -> { status, createdAt, updatedAt, result }

function newJob() {
  const id = crypto.randomBytes(8).toString("hex");
  const now = Date.now();
  JOBS.set(id, { status: "running", createdAt: now, updatedAt: now, result: null });
  return id;
}

function setJobDone(id, result) {
  const j = JOBS.get(id);
  if (!j) return;
  j.status = "done";
  j.updatedAt = Date.now();
  j.result = result;
}

function setJobError(id, result) {
  const j = JOBS.get(id);
  if (!j) return;
  j.status = "error";
  j.updatedAt = Date.now();
  j.result = result;
}

app.get("/job/:id", (req, res) => {
  const id = req.params.id;
  const j = JOBS.get(id);
  if (!j) return res.status(404).json({ ok: false, error: "Job bulunamadı" });
  res.json({ ok: true, jobId: id, ...j });
});

// --------------------
// Helpers
// --------------------
async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

function buildProductUrl(productCode) {
  return `https://www.mybidfood.com.tr/#/products/search/?searchTerm=${encodeURIComponent(
    productCode
  )}&category=All&page=1&useUrlParams=true`;
}

async function login(page, username, password) {
  await page.goto("https://www.mybidfood.com.tr/", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

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

// SPA wait: ürün bloğu (#product-list-XXXX) oluşana kadar bekle + retry
async function waitForProductRow(page, productCode, productUrl) {
  const row = page.locator(`#product-list-${productCode}`).first();

  // 3 deneme: bazen ilk load’da liste gelmiyor
  for (let attempt = 1; attempt <= 3; attempt++) {
    // küçük bekleme: XHR render
    await page.waitForTimeout(2500);

    if (await row.isVisible().catch(() => false)) return row;

    // aynı sayfayı yeniden yükle
    await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  }

  // son şans: uzun bekleme
  await row.waitFor({ state: "visible", timeout: NAV_TIMEOUT });
  return row;
}

// UOM satırını bul: row içinden ".UOM .type" text'i ADET/KOLİ olanı bul, sonra en yakın tr
async function pickUomScope(page, row, uom) {
  const wanted = String(uom || "").trim().toUpperCase();
  if (!wanted) throw new Error("uom zorunlu: 'ADET' veya 'KOLİ'");

  // scope = ilgili UOM satırının TR'i
  const scopeHandle = await row.evaluateHandle((tbody, wantedUom) => {
    const types = Array.from(tbody.querySelectorAll(".UOM .type"));
    const hit = types.find((el) => (el.textContent || "").trim().toUpperCase() === wantedUom);
    if (!hit) return null;
    return hit.closest("tr");
  }, wanted);

  const scopeEl = scopeHandle?.asElement?.() ? scopeHandle.asElement() : null;
  if (!scopeEl) {
    const availableUoms = await row.evaluate((tbody) => {
      return Array.from(tbody.querySelectorAll(".UOM .type"))
        .map((el) => (el.textContent || "").trim().toUpperCase())
        .filter(Boolean);
    });
    const err = new Error(`UOM bulunamadı: ${wanted}`);
    err.meta = { availableUoms };
    throw err;
  }

  return scopeEl;
}

// qty kontrol elementleri scope içinde.
// Not: ilk başta qty input gizli olabiliyor; önce "Ekle" butonuna basıp qty alanını açıyoruz.
async function openQtyControls(scopeEl) {
  const addBtnHandle = await scopeEl.evaluateHandle((tr) => tr.querySelector('button[data-cy="click-set-add-stateprice"]'));
  const addBtn = addBtnHandle?.asElement?.() ? addBtnHandle.asElement() : null;
  if (!addBtn) throw new Error("Ekle (setAddState) butonu bulunamadı");

  // qty input görünür değilse önce click
  const inputHandle0 = await scopeEl.evaluateHandle((tr) => tr.querySelector('input[data-cy="click-input-qty"]'));
  const input0 = inputHandle0?.asElement?.() ? inputHandle0.asElement() : null;

  const inputVisible =
    input0 ? await input0.isVisible().catch(() => false) : false;

  if (!inputVisible) {
    await addBtn.click({ force: true });
    // Angular render için bekle
    await scopeEl.page().waitForTimeout(2000);
  }

  // Şimdi input görünür olana kadar bekle (ama bazen DOM var, hidden; 30sn içinde açılmazsa hata)
  const inputHandle = await scopeEl.evaluateHandle((tr) => tr.querySelector('input[data-cy="click-input-qty"]'));
  const input = inputHandle?.asElement?.() ? inputHandle.asElement() : null;
  if (!input) throw new Error("Qty input bulunamadı (click-input-qty)");

  await input.waitForElementState("visible", { timeout: 30000 });
  return true;
}

async function readQty(scopeEl) {
  const inpHandle = await scopeEl.evaluateHandle((tr) => tr.querySelector('input[data-cy="click-input-qty"]'));
  const inp = inpHandle?.asElement?.() ? inpHandle.asElement() : null;
  if (!inp) return null;
  const val = await inp.evaluate((n) => parseInt(n.value || "0", 10)).catch(() => null);
  return Number.isFinite(val) ? val : null;
}

async function clickPlus(scopeEl) {
  const plusHandle = await scopeEl.evaluateHandle((tr) => tr.querySelector('button[data-cy="click-increase-qtyprice"]'));
  const plus = plusHandle?.asElement?.() ? plusHandle.asElement() : null;
  if (!plus) throw new Error("Plus butonu yok (click-increase-qtyprice)");
  await plus.click({ force: true });
}

async function clickMinus(scopeEl) {
  const minusHandle = await scopeEl.evaluateHandle((tr) => tr.querySelector('button[data-cy="click-decrease-qtyprice"]'));
  const minus = minusHandle?.asElement?.() ? minusHandle.asElement() : null;
  if (!minus) throw new Error("Minus butonu yok (click-decrease-qtyprice)");
  await minus.click({ force: true });
}

// Console’daki stabil mantık: önce 1’e indir, sonra hedefe gelene kadar +/-
async function setQtyToTarget(page, scopeEl, targetQty) {
  const tgt = Math.max(1, parseInt(String(targetQty ?? 1), 10) || 1);

  // 1) Kontrolleri aç
  await openQtyControls(scopeEl);

  // 2) 1'e indir (garanti başlangıç)
  let safety = 40;
  while (safety-- > 0) {
    const cur = await readQty(scopeEl);
    if (cur === null || cur <= 1) break;
    await clickMinus(scopeEl);
    await page.waitForTimeout(WAIT);
  }

  // 3) hedefe çık, hedefe ulaşınca DUR
  let guard = 80;
  while (guard-- > 0) {
    const cur = await readQty(scopeEl);

    if (cur === tgt) {
      return { targetQty: tgt, finalQty: cur };
    }

    if (cur === null) throw new Error("Qty input okunamadı");

    if (cur < tgt) {
      await clickPlus(scopeEl);
      await page.waitForTimeout(WAIT);
      continue;
    }

    // cur > tgt ise azalt
    await clickMinus(scopeEl);
    await page.waitForTimeout(WAIT);
  }

  const last = await readQty(scopeEl);
  return { targetQty: tgt, finalQty: last, warn: "Guard bitti, hedefe tam ulaşamadı." };
}

// --------------------
// Endpoints
// --------------------

// ✅ SADECE LOGIN TEST
app.post("/login-test", async (req, res) => {
  const { username, password } = req.body;

  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  await page.emulateTimezone(DEFAULT_TZ).catch(() => {});

  try {
    const result = await withTimeout(login(page, username, password), 35000);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// ✅ Qty set et, DUR (sepete ekleme yok) — async job
app.post("/set-qty", async (req, res) => {
  const { username, password, productCode, uom = "ADET", targetQty = 5 } = req.body;

  const jobId = newJob();
  res.json({
    ok: true,
    jobId,
    statusUrl: `/job/${jobId}`,
    note: "Job başlatıldı. Sonucu GET /job/:id ile sorgula.",
  });

  (async () => {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    await page.emulateTimezone(DEFAULT_TZ).catch(() => {});

    try {
      const loginResult = await withTimeout(login(page, username, password), 45000);
      if (!loginResult.loggedIn) {
        return setJobError(jobId, { ok: false, status: 401, step: "login", ...loginResult });
      }

      const productUrl = buildProductUrl(productCode);

      await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

      // ✅ kritik: SPA ürün bloğunu bekle
      const row = await waitForProductRow(page, productCode, productUrl);

      // UOM satırını seç (ADET/KOLİ)
      const scopeEl = await pickUomScope(page, row, uom);

      // Qty’yi hedefe getir, DUR
      const qtyRes = await setQtyToTarget(page, scopeEl, targetQty);

      return setJobDone(jobId, {
        ok: true,
        productCode,
        uom: String(uom).toUpperCase(),
        ...qtyRes,
        productUrl,
        note: "Qty hedefe getirildi. Sepete ekleme yapılmadı (burada durdu).",
      });
    } catch (e) {
      const meta = e?.meta ? { meta: e.meta } : {};
      setJobError(jobId, { ok: false, error: String(e), ...meta });
    } finally {
      await browser.close();
    }
  })();
});

// ✅ Add-to-cart (job): login -> ürün -> UOM -> qty hedefe getir.
// Not: Burada “Ekle” butonuna sadece qty alanını açmak için tıklıyoruz.
// Sepete gerçekten eklemek istersen en sonda add click’i ayrıca yapabiliriz.
app.post("/add-to-cart", async (req, res) => {
  const { username, password, productCode, uom = "ADET", qty = 1 } = req.body;

  const jobId = newJob();
  res.json({
    ok: true,
    jobId,
    statusUrl: `/job/${jobId}`,
    note: "Job başlatıldı. Sonucu GET /job/:id ile sorgula.",
  });

  (async () => {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    await page.emulateTimezone(DEFAULT_TZ).catch(() => {});

    try {
      const loginResult = await withTimeout(login(page, username, password), 45000);
      if (!loginResult.loggedIn) {
        return setJobError(jobId, { ok: false, status: 401, step: "login", ...loginResult });
      }

      const productUrl = buildProductUrl(productCode);

      await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

      // ✅ kritik: SPA ürün bloğunu bekle
      const row = await waitForProductRow(page, productCode, productUrl);

      // UOM satırını seç (ADET/KOLİ)
      const scopeEl = await pickUomScope(page, row, uom);

      // Qty’yi hedefe getir
      const qtyRes = await setQtyToTarget(page, scopeEl, qty);

      // ⚠️ Burada DURUYORUZ (sen istersen “sepete ekle” click’i de ekleyebilirim)
      return setJobDone(jobId, {
        ok: true,
        productCode,
        uom: String(uom).toUpperCase(),
        requestedQty: parseInt(String(qty), 10) || 1,
        ...qtyRes,
        productUrl,
        note:
          "Qty hedefe getirildi. UI bazen add sonrası input’u resetler; burada sepete ekleme click’i atmadık, sadece qty alanını açıp ayarladık.",
      });
    } catch (e) {
      const meta = e?.meta ? { meta: e.meta } : {};
      setJobError(jobId, { ok: false, error: String(e), ...meta });
    } finally {
      await browser.close();
    }
  })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
