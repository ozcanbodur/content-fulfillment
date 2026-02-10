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
    const result = await withTimeout(
      (async () => {
        await page.goto("https://www.mybidfood.com.tr/", {
          waitUntil: "domcontentloaded",
        });

        // login inputlarını yakala
        const pass = page.locator('input[type="password"]').first();
        const user = page.locator('input[type="text"], input[type="email"]').first();

        const hasLoginForm = await pass.isVisible().catch(() => false);

        if (hasLoginForm) {
          await user.fill(username);
          await pass.fill(password);

          // Enter veya login butonu
          await pass.press("Enter").catch(() => {});
        }

        // login sonrası “bir şey değişti mi?” kontrolü
        // 1) password input kayboldu mu?
        await page.waitForTimeout(1500);

        const passStillVisible = await pass.isVisible().catch(() => false);

        // 2) URL / hash değişti mi?
        const currentUrl = page.url();

        // 3) Sayfada "Logout / Çıkış" benzeri bir şey var mı? (toleranslı)
        const logoutLike = page.locator('text=/çıkış|logout|sign out/i');
        const hasLogout = (await logoutLike.count().catch(() => 0)) > 0;

        // 4) Bir hata mesajı var mı? (toleranslı)
        const errorLike = page.locator('text=/hatalı|yanlış|error|invalid/i');
        const hasError = (await errorLike.count().catch(() => 0)) > 0;

        // Başarı heuristiği:
        // - login formu vardı ve şimdi password görünmüyor => büyük ihtimal login oldu
        // - ya da logout benzeri çıktı
        const loggedIn = (!passStillVisible && hasLoginForm) || hasLogout;

        return {
          hasLoginForm,
          passStillVisible,
          hasLogout,
          hasError,
          currentUrl,
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
