const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("OK"));

const WAIT = 10000; // min 10 sn
const sleep = (page, ms) => page.waitForTimeout(ms);

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

// (opsiyonel) Login test
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

// ✅ TEK ENDPOINT: Login + Ürün Bul + UOM seç + qty hedefe getirince DUR
app.post("/add-to-cart", async (req, res) => {
  const { username, password, productCode, uom = "ADET", qty = 1 } = req.body;

  const targetQty = Math.max(1, parseInt(qty, 10) || 1);
  const wantedUom = String(uom || "").trim().toUpperCase();

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(25000);
  page.setDefaultNavigationTimeout(45000);

  try {
    // 1) Login
    const loginResult = await withTimeout(login(page, username, password), 60000);
    if (!loginResult.loggedIn) {
      return res.status(401).json({ ok: false, step: "login", ...loginResult });
    }

    // 2) Ürün arama sayfasına git
    const productUrl = `https://www.mybidfood.com.tr/#/products/search/?searchTerm=${encodeURIComponent(
      productCode
    )}&category=All&page=1&useUrlParams=true`;

    await page.goto(productUrl, { waitUntil: "domcontentloaded" });

    // Angular/SPA -> DOM'un oturması için ekstra bekleme
    await sleep(page, 2500);

    // 3) Ürün bloğunu bekle (hemen gelmeyebiliyor)
    const row = page.locator(`#product-list-${productCode}`).first();
    await row.waitFor({ state: "visible", timeout: 60000 });

    // 4) Bu ürün için mevcut UOM'ları listele ve istenen UOM satırını bul
    const uomRows = row.locator('tr[ng-repeat-end][ng-form="form"]');
    const uomCount = await uomRows.count();

    const availableUoms = [];
    let pickedIndex = -1;

    for (let i = 0; i < uomCount; i++) {
      const r = uomRows.nth(i);
      const t = await r.locator(".UOM .type").first().textContent().catch(() => "");
      const normalized = String(t || "").trim().toUpperCase();
      if (normalized) availableUoms.push(normalized);
      if (normalized === wantedUom && pickedIndex === -1) pickedIndex = i;
    }

    if (pickedIndex === -1) {
      return res.status(404).json({
        ok: false,
        step: "pick-uom",
        error: `UOM bulunamadı: ${wantedUom}`,
        availableUoms: Array.from(new Set(availableUoms)),
        productUrl,
      });
    }

    const scope = uomRows.nth(pickedIndex);

    // 5) Önce "Ekle" tıkla -> qty alanını açtırır (genelde sepete 1 ekler)
    const addBtn = scope.locator('button[data-cy="click-set-add-stateprice"]').first();
    await addBtn.waitFor({ state: "visible", timeout: 30000 });
    await addBtn.click({ force: true });

    // Sistem/UI toparlansın (min 10 sn şartın)
    await sleep(page, WAIT);

    // 6) Qty input / plus / minus yakala
    const input = scope.locator('input[data-cy="click-input-qty"]').first();
    const plusBtn = scope.locator('button[data-cy="click-increase-qtyprice"]').first();
    const minusBtn = scope.locator('button[data-cy="click-decrease-qtyprice"]').first();

    // Input bazen render oluyor ama görünmüyor olabilir; yine de deneyeceğiz.
    // Önce input görünür olmayı biraz bekle.
    await input.waitFor({ state: "visible", timeout: 30000 }).catch(() => {});

    const readQty = async () => {
      const v = await input.inputValue().catch(() => "");
      const n = parseInt(v || "0", 10);
      return Number.isFinite(n) ? n : null;
    };

    // 7) Hedefe gelene kadar + / - (her adımda 10 sn bekle)
    // Başlangıç qty okunamazsa "1" varsay (Ekle sonrası genelde 1 olur)
    let cur = await readQty();
    if (cur === null) cur = 1;

    // Güvenlik guard
    let guard = 120;

    while (guard-- > 0) {
      cur = await readQty();
      if (cur === null) cur = 1;

      if (cur === targetQty) break;

      if (cur < targetQty) {
        await plusBtn.click({ force: true });
        await sleep(page, WAIT);
        continue;
      }

      // cur > targetQty
      await minusBtn.click({ force: true });
      await sleep(page, WAIT);
    }

    const finalQty = await readQty();

    // ✅ Burada DURUYORUZ: başka aksiyon yok.
    return res.json({
      ok: true,
      productCode,
      uom: wantedUom,
      requestedQty: targetQty,
      finalQty: finalQty ?? "(unknown)",
      productUrl,
      note:
        "Akış: login -> search -> UOM satırı seçildi -> Ekle ile qty alanı açıldı -> +/- ile hedef qty'ye gelince durdu.",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
