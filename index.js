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

// ✅ Qty set et, DUR (sepete ekleme yok)
app.post("/set-qty-only", async (req, res) => {
  const { username, password, productCode, targetQty = 5 } = req.body;

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(30000);

  const sleep = (ms) => page.waitForTimeout(ms);

  try {
    const loginResult = await withTimeout(login(page, username, password), 35000);
    if (!loginResult.loggedIn) {
      return res.status(401).json({ ok: false, step: "login", ...loginResult });
    }

    const productUrl = `https://www.mybidfood.com.tr/#/products/search/?searchTerm=${encodeURIComponent(
      productCode
    )}&category=All&page=1&useUrlParams=true`;

    await page.goto(productUrl, { waitUntil: "domcontentloaded" });
    await sleep(1500);

    // product container
    const row = page.locator(`#product-list-${productCode}`).first();
    const rowCount = await row.count();
    if (!rowCount) {
      return res.status(404).json({ ok: false, error: `Ürün bloğu yok: ${productCode}`, productUrl });
    }

    // ADET satırı: "Birim: ADET" geçen elementi bul (DOM içinde text arama)
    // Playwright'ta DOM içinden evaluate ile aramak daha stabil:
    const scopeHandle = await row.evaluateHandle((tbody) => {
      // row = tbody
      // ADET hint bul
      const all = Array.from(tbody.querySelectorAll("*"));
      const adetHint = all.find((el) => /Birim:\s*ADET/i.test(el.innerText || ""));
      if (!adetHint) return null;
      return adetHint.closest("tbody") || tbody;
    });

    if (!scopeHandle) {
      return res.status(404).json({ ok: false, error: "ADET satırı bulunamadı.", productUrl });
    }

    const getInput = () => page.locator('input[data-cy="click-input-qty"]').filter({ has: page.locator(":scope") });
    // Yukarıdaki filter scope vermiyor; scopeHandle ile querySelector kullanacağız:
    const q = async (selector) => {
      const el = await scopeHandle.evaluateHandle((root, sel) => root.querySelector(sel), selector);
      const asEl = el.asElement();
      return asEl;
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

    // Hedef qty’ye getir (min 10 sn bekle)
    for (let i = 0; i < Math.max(0, targetQty - 1); i++) {
      await clickPlus();
      await sleep(WAIT);
      const cur = await readQty();
      // log amaçlı
      // console.log("ui qty =", cur);
    }

    const finalQty = await readQty();

    // Burada DURUYORUZ — sepete ekleme yok
    return res.json({
      ok: true,
      productCode,
      targetQty,
      finalQty,
      productUrl,
      note: "Qty hedefe getirildi, sepete ekleme yapılmadı.",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
