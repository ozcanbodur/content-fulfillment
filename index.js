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

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

async function login(page, username, password) {
  await page.goto("https://www.mybidfood.com.tr/", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  const pass = page.locator('input[type="password"]').first();
  const user = page.locator('input[type="text"], input[type="email"]').first();

  const hasLoginForm = await pass.isVisible().catch(() => false);

  if (hasLoginForm) {
    await user.fill(username);
    await pass.fill(password);
    await pass.press("Enter").catch(() => {});
  }

  // SPA/redirect sonrası biraz nefes
  await page.waitForTimeout(1500);

  const passStillVisible = await pass.isVisible().catch(() => false);
  const currentUrl = page.url();

  // “logout/çıkış” benzeri bir şey var mı? (toleranslı)
  const logoutLike = page.locator("text=/çıkış|logout|sign out/i");
  const hasLogout = (await logoutLike.count().catch(() => 0)) > 0;

  // hata mesajı var mı? (toleranslı)
  const errorLike = page.locator("text=/hatalı|yanlış|error|invalid/i");
  const hasError = (await errorLike.count().catch(() => 0)) > 0;

  // Başarı heuristiği:
  const loggedIn = (!passStillVisible && hasLoginForm) || hasLogout;

  return {
    hasLoginForm,
    passStillVisible,
    hasLogout,
    hasError,
    currentUrl,
    loggedIn,
  };
}

// ✅ SADECE LOGIN TEST
app.post("/login-test", async (req, res) => {
  const { username, password } = req.body;

  const browser = await launchBrowser();
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

// ✅ LOGIN + IT0004 1 ADET EKLE (ön sipariş olsa bile)
app.post("/add-to-cart", async (req, res) => {
  const { username, password, productCode = "IT0004", qty = 1 } = req.body;

  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(25000);
  page.setDefaultNavigationTimeout(30000);

  try {
    const loginResult = await withTimeout(login(page, username, password), 35000);

    if (!loginResult.loggedIn) {
      return res.status(401).json({
        ok: false,
        step: "login",
        loginResult,
        error: "Login başarısız görünüyor (loggedIn=false).",
      });
    }

    const productUrl =
      "https://www.mybidfood.com.tr/#/products/search/?" +
      "searchTerm=" +
      encodeURIComponent(productCode) +
      "&category=All&page=1&useUrlParams=true";

    await page.goto(productUrl, { waitUntil: "domcontentloaded" });

    // SPA: ürün tbody’si gelene kadar bekle
    const productTbodySelector = `tbody#product-list-${productCode}`;
    await page.waitForSelector(productTbodySelector, { timeout: 35000 });

    const product = page.locator(productTbodySelector).first();

    // Ürün bloğundaki ilk add butonu: "Sepete Ekle" veya "Ön Sipariş" (aynı button)
    const addBtn = product.locator('button[data-cy="click-set-add-stateprice"]').first();
    await addBtn.waitFor({ state: "visible", timeout: 15000 });

    // 1) İlk tık -> çoğu senaryoda default 1 ekler (ön sipariş dahil)
    await addBtn.click();

    // 2) Aynı satırdaki qty input’u yakala (varsa)
    const row = addBtn.locator("xpath=ancestor::tr[1]");
    const qtyInput = row.locator('input[data-cy="click-input-qty"]').first();

    // Angular bazen click sonrası qty input’u görünür yapıyor; kısa bekleyelim
    await page.waitForTimeout(800);

    const qtyVisible = await qtyInput.isVisible().catch(() => false);

    let finalQty = null;

    if (qtyVisible) {
      await qtyInput.click({ clickCount: 3 }).catch(() => {});
      await qtyInput.fill(String(qty)).catch(() => {});
      await qtyInput.press("Enter").catch(() => {});
      await qtyInput.blur().catch(() => {});
      finalQty = await qtyInput.inputValue().catch(() => null);
    }

    // Ürün içinde UOM text’i (bilgi amaçlı) - ilk görünen UOM
    const uomText = await product.locator(".UOM .type").first().innerText().catch(() => null);

    res.json({
      ok: true,
      productCode,
      requestedQty: qty,
      finalQty,
      uomDetected: uomText,
      productUrl,
      afterUrl: page.url(),
      note:
        "Butona tıklandı (Ön Sipariş/Sepete Ekle). Qty input görünürse 1'e zorlandı. Input görünmezse de UI default 1 eklemiş olabilir.",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e), currentUrl: page.url() });
  } finally {
    await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
