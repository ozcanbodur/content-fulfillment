const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

// healthcheck
app.get("/", (req, res) => res.send("OK"));

app.post("/add-to-cart", async (req, res) => {
  const {
    username,
    password,
    productCode = "IT0004",
    uom = "KOLİ",
    qty = 1
  } = req.body;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto("https://www.mybidfood.com.tr/", {
      waitUntil: "domcontentloaded"
    });
    await page.waitForLoadState("networkidle").catch(() => {});

    const pass = page.locator('input[type="password"]').first();
    if (await pass.isVisible().catch(() => false)) {
      await page
        .locator('input[type="text"], input[type="email"]')
        .first()
        .fill(username);
      await pass.fill(password);
      await pass.press("Enter");
      await page.waitForLoadState("networkidle").catch(() => {});
    }

    const url =
      "https://www.mybidfood.com.tr/#/products/search/?searchTerm=" +
      encodeURIComponent(productCode) +
      "&category=All&page=1&useUrlParams=true";

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});

    const product = page.locator('tbody[id^="product-list-"]').first();
    await product.waitFor({ timeout: 15000 });

    const row = product
      .locator("tr")
      .filter({
        has: page.locator(".UOM .type").filter({ hasText: uom })
      })
      .first();

    const qtyInput = row.locator('input[data-cy="click-input-qty"]').first();
    await qtyInput.click({ clickCount: 3 });
    await qtyInput.type(String(qty));

    const addBtn = row
      .locator('button[data-cy="click-set-add-stateprice"]')
      .first();
    await addBtn.click();

    res.json({ ok: true, productCode, uom, qty });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log("Server listening on", PORT)
);
