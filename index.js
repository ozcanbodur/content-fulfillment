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
  // 1) Siteye gir
  await page.goto("https://www.mybidfood.com.tr/", { waitUntil: "domcontentloaded" });

  // 2) Login formunu yakala (identity redirect ile de gelebiliyor)
  const pass = page.locator('input[type="password"]').first();
  const user = page.locator('input[type="text"], input[type="email"]').first();

  const hasLoginForm = await pass.isVisible().catch(() => false);

  if (hasLoginForm) {
    await user.fill(username);
    await pass.fill(password);

    // Enter bas (bazı ekranlarda buton yoksa en hızlı yol)
    await pass.press("Enter").catch(() => {});
  }

  // 3) Login sonrası kısa bekleme
  await page.waitForTimeout(1500);

  // heuristics
  const passStillVisible = await pass.isVisible().catch(() => false);
  const currentUrl = page.url();

  // Logout/Çıkış var mı?
  const logoutLike = page.locator('text=/çıkış|logout|sign out/i');
  const hasLogout = (await logoutLike.count().catch(() => 0)) > 0;

  // Error var mı?
  const errorLike = page.locator('text=/hatalı|yanlış|error|invalid/i');
  const hasError = (await errorLike.count().catch(() => 0)) > 0;

  // Başarı: login formu vardı ve şimdi password yok -> büyük ihtimal ok
  const loggedIn = (!passStillVisible && hasLoginForm) || hasLogout;

  return { hasLoginForm, passStillVisible, hasLogout, hasError, currentUrl, loggedIn };
}

// ✅ SADECE LOGIN TEST
app.post("/login-test", async (req, res) => {
  const { username, password } = req.body;

  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(25000);

  try {
    const result = await withTimeout(login(page, username, password), 30000);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// ✅ LOGIN + ÜRÜN SAYFASINA GİT + "Ön Sipariş / Sepete Ekle" TIKLA (şimdilik 1 adet)
app.post("/add-to-cart", async (req, res) => {
  const {
    username,
    password,
    productCode = "IT0004",
    // şimdilik uom/qty opsiyonel; sonraki adımda geliştireceğiz
    uom, // örn "KOLİ" / "ADET"
    qty, // örn 1
  } = req.body;

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

    // SPA: en kritik nokta -> ürün tbody'si gelene kadar bekle
    const productTbodySelector = `tbody#product-list-${productCode}`;
    await page.waitForSelector(productTbodySelector, { timeout: 35000 });

    const product = page.locator(productTbodySelector).first();

    // "Ön Sipariş / Sepete Ekle" butonu data-cy üzerinden
    // Not: DOM’da birden fazla UOM satırı olabilir; şimdilik ilk görünen add butonuna tıklıyoruz.
    const addBtn = product.locator('button[data-cy^="click-set-add-state"]').first();

    // Bazı durumlarda buton render oluyor ama disable/hide olabilir; kısa bir bekleme ile garantiye alalım
    await addBtn.waitFor({ state: "visible", timeout: 15000 });

    await addBtn.click();

    // Sonuç: sayfada sepet sayacı vs. kontrolünü bir sonraki adımda ekleriz.
    const afterClickUrl = page.url();

    res.json({
      ok: true,
      productCode,
      productUrl,
      afterClickUrl,
      note:
        "Şimdilik ürünün ilk add butonuna tıklandı. UOM/qty seçimini (KOLİ/ADET + adet) bir sonraki adımda DOM’a göre netleştirelim.",
    });
  } catch (e) {
    // Debug için küçük ipuçları
    const currentUrl = page.url().catch ? await page.url().catch(() => null) : null;
    res.status(500).json({ ok: false, error: String(e), currentUrl });
  } finally {
    await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
