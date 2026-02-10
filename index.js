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

const WAIT = 10000; // min 10 sn (her artıştan sonra)

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

/**
 * Qty set et, DUR (sepete ekleme yok)
 * - targetQty olunca response döner.
 * - min 10 sn bekleme var.
 * - UI lag / reset durumuna retry ile dayanıklı.
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

  // product container
  const row = page.locator(`#product-list-${productCode}`).first();
  const rowCount = await row.count();
  if (!rowCount) {
    return { ok: false, status: 404, error: `Ürün bloğu yok: ${productCode}`, productUrl };
  }

  // ADET scope root'unu bul (aynı ürün tbody içinde ADET satırının olduğu kısım)
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

  // scope içinde selector bulucu
  const q = async (selector) => {
    const h = await scopeEl.evaluateHandle((root, sel) => root.querySelector(sel), selector);
    return h?.asElement() || null;
  };

  // qty okuma: input value (asıl kaynak)
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

  // UI bazen 1 geriden/geri düşebiliyor => hedefe ulaşana kadar kontrollü ilerle
  // maxAttempts: sonsuz döngü olmasın
  const maxAttempts = Math.max(10, targetQty * 6);
  let attempts = 0;

  while (attempts++ < maxAttempts) {
    const cur = await readQty();
    // bazen ilk anda 0/null gelebiliyor; biraz bekleyip tekrar dene
    if (cur === null) {
      await sleep(1000);
      continue;
    }

    // hedefteyiz => DUR
    if (cur >= targetQty) {
      return {
        ok: true,
        productCode,
        targetQty,
        finalQty: cur,
        productUrl,
        note: "✅ Hedef qty oldu, duruyorum. (Sepete ekleme yapılmadı.)",
      };
    }

    // 1 arttır
    await clickPlus();
    await sleep(WAIT);

    const after = await readQty();
    // Debug amaçlı: UI lag / reset görürsen buradan anlayacaksın
    // console.log("ui qty =", after);
  }

  // buraya geldiyse hedefe ulaşamadı
  const last = await readQty();
  return {
    ok: false,
    status: 500,
    error: "Hedef qty'ye ulaşılamadı (UI lag/reset olabilir).",
    productCode,
    targetQty,
    finalQty: last,
    productUrl,
  };
}

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

  try {
    const result = await withTimeout(
      setQtyOnlyFlow(page, { username, password, productCode, targetQty }),
      120000,
      "SET_QTY_TIMEOUT"
    );

    if (result?.ok) return res.json(result);
    const status = result?.status || 500;
    return res.status(status).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// ✅ ALIAS: sen curl ile /set-qty çağırıyorsun diye (Cannot POST fix)
app.post("/set-qty", async (req, res) => {
  // aynen /set-qty-only gibi çalışır
  req.url = "/set-qty-only";
  return app._router.handle(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
