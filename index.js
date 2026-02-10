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

// ✅ LOGIN + ÜRÜN SAYFASI TEST (SEPETE EKLEME YOK)
app.post("/login-test", async (req, res) => {
  const { username, password, productCode = "IT0004" } = req.body;

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(20000);

  try {
    const result = await withTimeout(
      (async () => {
        // 1) Ana siteye git
        await page.goto("https://www.mybidfood.com.tr/", {
          waitUntil: "domcontentloaded",
        });

        // 2) Login formunu yakala
        const pass = page.locator('input[type="password"]').first();
        const user = page
          .locator('input[type="text"], input[type="email"]')
          .first();

        const hasLoginForm = await pass.isVisible().catch(() => false);

        // 3) Login gerekiyorsa doldur
        if (hasLoginForm) {
          await user.fill(username);
          await pass.fill(password);
          await pass.press("Enter").catch(() => {});
        }

        // 4) Redirect/callback için kısa bekleme
        await page.waitForTimeout(2000);

        const afterLoginUrl = page.url();
        const passStillVisible = await pass.isVisible().catch(() => false);

        // 5) Ürün arama sayfasına git (login gerçekten oturdu mu?)
        const productUrl =
          "https://www.mybidfood.com.tr/#/products/search/?searchTerm=" +
          encodeURIComponent(productCode) +
          "&category=All&page=1&useUrlParams=true";

        await page.goto(productUrl, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1500);

        const afterProductUrl = page.url();

        // Ürün listesi geldi mi?
        const hasProductList = await page
          .locator('tbody[id^="product-list-"]')
          .first()
          .isVisible()
          .catch(() => false);

        // Identity’ye geri attı mı?
        const redirectedToIdentity =
          /identity\.mybidfood\.com\.tr/i.test(afterProductUrl);

        // Basit hata sinyali
        const errorLike = page.locator(
          "text=/hatalı|yanlış|error|invalid/i"
        );
        const hasError = (await errorLike.count().catch(() => 0)) > 0;

        // Daha sağlam “logged in” kararı:
        const loggedIn =
          (hasLoginForm && !passStillVisible) ||
          (hasProductList && !redirectedToIdentity);

        return {
          hasLoginForm,
          passStillVisible,
          afterLoginUrl,
          productUrl,
          afterProductUrl,
          hasProductList,
          redirectedToIdentity,
          hasError,
          loggedIn,
        };
      })(),
      25000
    );

    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
