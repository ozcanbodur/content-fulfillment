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
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(30000);

  try {
    const result = await withTimeout(login(page, username, password), 35000);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// ✅ ADD TO CART (senin console scriptinin aynısı): hedef qty olunca DUR (başka işlem yok)
app.post("/add-to-cart", async (req, res) => {
  const { username, password, productCode, uom = "ADET", qty = 5 } = req.body || {};
  const targetQty = Number(qty);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(45000);

  const sleep = (ms) => page.waitForTimeout(ms);

  try {
    // 1) login
    const loginResult = await withTimeout(login(page, username, password), 45000);
    if (!loginResult.loggedIn) {
      return res.status(401).json({ ok: false, step: "login", ...loginResult });
    }

    // 2) ürün search URL
    const productUrl = `https://www.mybidfood.com.tr/#/products/search/?searchTerm=${encodeURIComponent(
      productCode
    )}&category=All&page=1&useUrlParams=true`;

    await page.goto(productUrl, { waitUntil: "domcontentloaded" });
    await sleep(1500);

    // 3) ürün bloğu
    const row = page.locator(`#product-list-${productCode}`).first();
    if ((await row.count()) === 0) {
      return res.status(404).json({ ok: false, error: `Ürün bloğu yok: ${productCode}`, productUrl });
    }

    await row.waitFor({ state: "visible", timeout: 30000 });

    // 4) ADET (veya uom param) satırını bul: row içinde .UOM .type text == uom
    const uomRegex = new RegExp(`^\\s*${String(uom).trim()}\\s*$`, "i");

    // tr[ng-repeat-end][ng-form="form"] satırlarının içindeki .UOM .type ile eşleşen tr'yi seç
    const scope = row
      .locator('tr[ng-repeat-end][ng-form="form"]')
      .filter({ has: row.locator(".UOM .type", { hasText: uomRegex }) })
      .first();

    if ((await scope.count()) === 0) {
      // debug: sayfada görünen UOM'ları topla
      const availableUoms = await row
        .locator('tr[ng-repeat-end][ng-form="form"] .UOM .type')
        .allInnerTexts()
        .then((arr) => arr.map((t) => t.trim()).filter(Boolean))
        .catch(() => []);

      return res.status(404).json({
        ok: false,
        error: `${uom} satırı bulunamadı.`,
        availableUoms: [...new Set(availableUoms)],
        productUrl,
      });
    }

    const q = (sel) => scope.locator(sel).first();
    const input = q('input[data-cy="click-input-qty"]');
    const plus = q('button[data-cy="click-increase-qtyprice"]');
    const minus = q('button[data-cy="click-decrease-qtyprice"]');
    const addBtn = q('button[data-cy="click-set-add-stateprice"]'); // paneli açmak için

    // 5) input görünmüyorsa: önce "Ekle" ile qty panelini açtır
    const inputVisible = await input.isVisible().catch(() => false);
    if (!inputVisible) {
      // Bu tık genelde 1 ekler ve qty panelini açar
      await addBtn.scrollIntoViewIfNeeded();
      await addBtn.click({ timeout: 15000 });
      await sleep(WAIT);
    }

    // input görünür olana kadar bekle (hidden -> visible)
    await input.waitFor({ state: "visible", timeout: 30000 });

    const readQty = async () => {
      const v = await input.inputValue().catch(() => "");
      const n = parseInt(v || "0", 10);
      return Number.isFinite(n) ? n : null;
    };

    // --- console kodun aynısı ---

    // 1'e indir (garanti başlangıç)
    let safety = 40;
    while (safety-- > 0) {
      const cur = await readQty();
      if (cur === null || cur <= 1) break;
      await minus.click({ timeout: 15000 });
      await sleep(WAIT);
    }

    // hedefe çık (hedefe ulaşınca DUR)
    let guard = 80;
    while (guard-- > 0) {
      const cur = await readQty();

      if (cur === targetQty) {
        // ✅ DUR — başka işlem yok
        return res.json({
          ok: true,
          productCode,
          uom,
          targetQty,
          finalQty: cur,
          productUrl,
          note: "✅ Hedef qty oldu, durdu. (Başka tık yok)",
        });
      }

      if (cur === null) {
        return res.status(500).json({ ok: false, error: "Qty input okunamadı", productUrl });
      }

      if (cur < targetQty) {
        await plus.click({ timeout: 15000 });
        await sleep(WAIT);
        continue;
      }

      // cur > targetQty ise azalt (nadiren)
      await minus.click({ timeout: 15000 });
      await sleep(WAIT);
    }

    // guard bitti
    return res.status(500).json({
      ok: false,
      error: "Hedefe ulaşamadı (guard bitti).",
      productCode,
      uom,
      targetQty,
      finalQty: await readQty(),
      productUrl,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
