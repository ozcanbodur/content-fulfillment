// index.js
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

async function safeClose(browser) {
  try {
    if (browser) await browser.close();
  } catch (_) {}
}

function buildSearchUrl(productCode) {
  return `https://www.mybidfood.com.tr/#/products/search/?searchTerm=${encodeURIComponent(
    productCode
  )}&category=All&page=1&useUrlParams=true`;
}

async function doLogin(page, { username, password }) {
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

  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1200);

  const passStillVisible = await pass.isVisible().catch(() => false);

  const logoutLike = page.locator('text=/çıkış|logout|sign out/i');
  const hasLogout = (await logoutLike.count().catch(() => 0)) > 0;

  const currentUrl = page.url();
  const redirectedToIdentity = /identity\.mybidfood\.com\.tr/i.test(currentUrl);

  const errorLike = page.locator('text=/hatalı|yanlış|error|invalid/i');
  const hasError = (await errorLike.count().catch(() => 0)) > 0;

  const loggedIn = (!passStillVisible && hasLoginForm) || hasLogout;

  return {
    hasLoginForm,
    passStillVisible,
    hasLogout,
    hasError,
    redirectedToIdentity,
    currentUrl,
    loggedIn,
  };
}

function normalizeUom(uom) {
  if (!uom) return null;
  const x = String(uom).trim().toUpperCase();
  if (x === "ADET" || x === "PAKET" || x === "ADET/PAKET") return "ADET";
  if (x === "KOLİ" || x === "KOLI") return "KOLİ";
  return x;
}

async function setQtyIfPossible(row, qty) {
  const qtyStr = String(qty);

  const qtyInput = row.locator('input[data-cy="click-input-qty"]').first();
  const visible = await qtyInput.isVisible().catch(() => false);

  if (!visible) {
    return { changed: false, finalQty: null, reason: "qty_input_not_visible" };
  }

  await qtyInput.click({ clickCount: 3 }).catch(() => {});
  await qtyInput.fill(qtyStr).catch(async () => {
    await qtyInput.type(qtyStr, { delay: 20 }).catch(() => {});
  });

  await qtyInput.dispatchEvent("input").catch(() => {});
  await qtyInput.dispatchEvent("change").catch(() => {});
  await qtyInput.blur().catch(() => {});

  const finalQty = await qtyInput.inputValue().catch(() => qtyStr);
  return { changed: true, finalQty, reason: "qty_set" };
}

async function clickAddButton(row) {
  const btn = row.locator('[data-cy="click-set-add-stateprice"]').first();
  await btn.waitFor({ timeout: 15000 });
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click({ timeout: 15000 }).catch(async () => {
    await btn.click({ force: true, timeout: 15000 }).catch(() => {});
  });
  return true;
}

async function waitForCartNetwork(page, ms = 15000) {
  // “Add to cart” sırasında giden request’leri yakalamak için toleranslı filtre
  const patterns = [/cart/i, /basket/i, /order/i, /add/i, /shopping/i, /api\/s_v1/i];

  try {
    const resp = await page.waitForResponse(
      (r) => {
        const url = r.url();
        if (!patterns.some((p) => p.test(url))) return false;
        const st = r.status();
        return st >= 200 && st < 400;
      },
      { timeout: ms }
    );

    return { matched: true, url: resp.url(), status: resp.status() };
  } catch (e) {
    return { matched: false, error: String(e) };
  }
}

// ✅ SADECE LOGIN TEST
app.post("/login-test", async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "username ve password zorunlu" });
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(25000);

    const result = await withTimeout(doLogin(page, { username, password }), 30000);

    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await safeClose(browser);
  }
});

// ✅ ADD TO CART (Ön Sipariş olsa bile butona bas)
app.post("/add-to-cart", async (req, res) => {
  const { username, password, productCode, qty = 1, uom } = req.body || {};

  if (!username || !password || !productCode) {
    return res
      .status(400)
      .json({ ok: false, error: "username, password, productCode zorunlu" });
  }

  const qtyNum = Number(qty) || 1;
  const uomWanted = normalizeUom(uom) || "ADET"; // default ADET

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);

    const result = await withTimeout(
      (async () => {
        // 1) Login
        const login = await doLogin(page, { username, password });
        if (!login.loggedIn) {
          return { ok: false, step: "login", login, error: "Login başarısız görünüyor." };
        }

        // 2) Search page
        const productUrl = buildSearchUrl(productCode);
        await page.goto(productUrl, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(800);

        // 3) Product tbody
        const tbody = page.locator(`tbody#product-list-${productCode}`).first();
        await tbody.waitFor({ timeout: 20000 });

        // 4) UOM satırı (ADET/KOLİ)
        const row = tbody
          .locator("tr")
          .filter({ has: page.locator(".UOM .type", { hasText: uomWanted }) })
          .first();

        const rowVisible = await row.isVisible().catch(() => false);
        if (!rowVisible) {
          // fallback: ilk UOM'ları listele
          const uoms = await tbody.locator(".UOM .type").allInnerTexts().catch(() => []);
          return {
            ok: false,
            step: "uom_row",
            productUrl,
            afterUrl: page.url(),
            uomWanted,
            uomsFound: uoms,
            note: "İstenen UOM satırı bulunamadı.",
          };
        }

        // 5) Qty set (görünürse)
        const qtySet = await setQtyIfPossible(row, qtyNum);

        // 6) Add click + network
        const cartNetPromise = waitForCartNetwork(page, 15000);
        await clickAddButton(row);
        const cartNetwork = await cartNetPromise;

        // 7) küçük bekleme
        await page.waitForTimeout(1200);

        // 8) sepet UI badge (çok toleranslı)
        const cartIconBadge = page.locator('css=span.badge, css=.badge').first();
        const badgeText = await cartIconBadge.innerText().catch(() => null);

        return {
          ok: true,
          productCode,
          requestedQty: qtyNum,
          finalQty: qtySet.finalQty || String(qtyNum),
          uomDetected: uomWanted,
          productUrl,
          afterUrl: page.url(),
          cartNetwork,
          badgeText,
          note:
            "Butona tıklandı (Ekle/Ön Sipariş). Asıl doğrulama için cartNetwork.matched=true ve/veya sepette ürün görünmesi beklenir.",
        };
      })(),
      45000
    );

    return res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await safeClose(browser);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
