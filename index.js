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

const WAIT_STEP_MS = 10000;
const BASE_URL = "https://www.mybidfood.com.tr";

async function sleep(page, ms) {
  await page.waitForTimeout(ms);
}

async function setQtyByTyping(qtyInput, requestedQty) {
  await qtyInput.scrollIntoViewIfNeeded().catch(() => {});
  await qtyInput.click({ force: true }).catch(() => {});
  await qtyInput.fill(String(requestedQty)).catch(() => {});
  await qtyInput.evaluate((el) => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    try {
      const s = window.angular?.element(el)?.scope?.();
      if (s) s.$apply?.();
    } catch (e) {}
  }).catch(() => {});
}

async function login(page, username, password) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });

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


//sepeti temizleme


async function clearCartAfterLogin(page, { timeoutMs = 15000 } = {}) {
  const log = (...a) => console.log("[CLEAR_CART]", ...a);

  // Sepet ikonuna tıkla (offcanvas aç)
  const cartIcon = page.locator('[data-cy="top-menu_click-check-out-state"]').first();
  await cartIcon.waitFor({ state: "attached", timeout: 30000 }).catch(() => {});
  await cartIcon.click().catch(() => {});
  await sleep(page, 1200);

  // "Sepeti Sil" butonu varsa tıkla, yoksa sepet zaten boş olabilir
  const clearBtn = page.locator('[data-cy="click-clear-cart"], a[ng-click="clearCart()"]').first();
  const hasClear = (await clearBtn.count().catch(() => 0)) > 0;
  if (!hasClear) {
    log("Sepeti Sil butonu yok (sepet boş olabilir). Devam.");
    return { ok: true, cleared: false, reason: "clear_button_not_found" };
  }

  await clearBtn.click().catch(() => {});
  await sleep(page, 800);

  // Modal "Tamam" (OK)
  const okBtn = page.locator('[data-cy="modal-ok"], button[ng-click^="ok("]').first();
  const hasOk = await okBtn
    .waitFor({ state: "attached", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);

  if (!hasOk) {
    log("Modal OK butonu gelmedi. Devam ediyorum (UI farklı olabilir).");
    return { ok: true, cleared: false, reason: "modal_ok_not_found" };
  }

  await okBtn.click().catch(() => {});
  await sleep(page, 1200);

  log("Sepet temizleme denendi.");
  return { ok: true, cleared: true };
}

////// sepeti temizleme */


async function addOneItem(page, item) {
  const { productCode, uom, qty } = item || {};
  const requestedQty = Number(qty ?? 1);

  if (!productCode || !uom) {
    return { ok: false, status: 400, productCode, uom, error: "productCode ve uom zorunlu" };
  }
  if (!Number.isFinite(requestedQty) || requestedQty < 1) {
    return { ok: false, status: 400, productCode, showUom: uom, error: "qty >= 1 olmalı" };
  }

  const currentPageUrl = page.url();
  const userPathMatch2 = currentPageUrl.match(/mybidfood\.com\.tr(\/u\/[^/#]+)/);
  const userBasePath2 = userPathMatch2 ? userPathMatch2[1] : '';
  const productUrl = `${BASE_URL}${userBasePath2}/#/products/search/?searchTerm=${encodeURIComponent(
    productCode
  )}&category=All&page=1&useUrlParams=true`;

  await page.goto(productUrl, { waitUntil: "domcontentloaded" });
  await sleep(page, 2000);
  await sleep(page, WAIT_STEP_MS);

  const row = page.locator(`#product-list-${productCode}`).first();
  if ((await row.count()) === 0) {
    return { ok: false, status: 404, productCode, uom, error: `Ürün bloğu yok: ${productCode}`, productUrl };
  }

  const uomUpper = String(uom).trim().toUpperCase();
  const uomType = row.locator(".UOM .type").filter({
    hasText: uomUpper,
  }).first();

  if ((await uomType.count()) === 0) {
    const availableUoms = await row.locator(".UOM .type").allTextContents().catch(() => []);
    return {
      ok: false,
      status: 404,
      productCode,
      uom,
      error: `UOM bulunamadı: ${uomUpper}`,
      availableUoms: availableUoms.map((x) => (x || "").trim()).filter(Boolean),
      productUrl,
    };
  }

  const scope = uomType.locator("xpath=ancestor::tr[1]").first();

  const addBtn = scope.locator('button[data-cy="click-set-add-stateprice"]').first();
  const plusBtn = scope.locator('button[data-cy="click-increase-qtyprice"]').first();
  const minusBtn = scope.locator('button[data-cy="click-decrease-qtyprice"]').first();
  const qtyInput = scope.locator('input[data-cy="click-input-qty"]').first();

  if ((await addBtn.count()) > 0) {
    await addBtn.scrollIntoViewIfNeeded().catch(() => {});
    await addBtn.click({ force: true }).catch(() => {});
    await sleep(page, 500);
    await sleep(page, WAIT_STEP_MS);
  }

  await qtyInput.waitFor({ state: "attached", timeout: 60000 }).catch(() => {});

  
  const readQty = async () => {
    const v = await qtyInput.inputValue().catch(() => "");
    const n = parseInt(String(v || "0"), 10);
    return Number.isFinite(n) ? n : null;
  };

    // ✅ HIZLI YÖNTEM: Qty'yi input'a yazarak set et
  await setQtyByTyping(qtyInput, requestedQty);
  await sleep(page, 2500); // 1sn bekle (10sn değil)

  let finalQtyFast = await readQty();
  if (finalQtyFast === requestedQty) {
    return {
      ok: true,
      productCode,
      uom: uomUpper,
      requestedQty,
      finalQty: finalQtyFast,
      productUrl,
      note: "Akış: login -> search -> UOM satırı -> Ekle -> qty input'a yazıldı (blur/input/change) -> tamam.",
    };
  }
  // ❗ Eğer tutmadıysa aşağıdaki mevcut +/- döngülerine düşecek (fallback)


  let safety = 40;
  while (safety-- > 0) {
    const cur = await readQty();
    if (cur === null || cur <= 1) break;
    if ((await minusBtn.count()) === 0) break;
    await minusBtn.click({ force: true }).catch(() => {});
    await sleep(page, WAIT_STEP_MS);
  }

  let guard = 80;
  while (guard-- > 0) {
    const cur = await readQty();
    if (cur === requestedQty) break;

    if (cur === null) {
      return { ok: false, status: 500, productCode, uom: uomUpper, error: "Qty input okunamadı", productUrl };
    }

    if (cur < requestedQty) {
      if ((await plusBtn.count()) === 0) {
        return { ok: false, status: 500, productCode, uom: uomUpper, error: "Plus yok", productUrl };
      }
      await plusBtn.click({ force: true }).catch(() => {});
      await sleep(page, WAIT_STEP_MS);
      continue;
    }

    if ((await minusBtn.count()) === 0) {
      return { ok: false, status: 500, productCode, uom: uomUpper, error: "Minus yok", productUrl };
    }
    await minusBtn.click({ force: true }).catch(() => {});
    await sleep(page, WAIT_STEP_MS);
  }

  const finalQty = await readQty();

  if (finalQty !== requestedQty) {
    return {
      ok: false,
      status: 500,
      productCode,
      uom: uomUpper,
      requestedQty,
      finalQty,
      productUrl,
      error: "Hedef qty'ye ulaşılamadı",
    };
  }

  return {
    ok: true,
    productCode,
    uom: uomUpper,
    requestedQty,
    finalQty,
    productUrl,
    note: "Akış: login -> search -> UOM satırı seçildi -> Ekle ile qty alanı açıldı -> +/- ile hedef qty'ye gelince durdu.",
  };
}

async function scrapeConfirmationPage(page) {
  await page.waitForTimeout(1500);

  return await page.evaluate(() => {
    const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

    const orderInfo = {};
    document.querySelectorAll(".header-block .checkout-field-row").forEach((row) => {
      const label = text(row.querySelector(".col-xs-3"))?.replace(":", "");
      const value = text(row.querySelector(".col-xs-9"));
      if (label) orderInfo[label] = value || "";
    });

    const accounts = [];
    document
      .querySelectorAll('.account-wrap[ng-repeat="account in accounts"]')
      .forEach((accountEl) => {
        const title = text(accountEl.querySelector("h3.title"));
        let accountTitle = "";
        let accountCodeFromTitle = "";
        const parts = title.split(" - ").map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
          accountTitle = parts[0];
          accountCodeFromTitle = parts[1];
        } else {
          accountTitle = title;
        }

        const header = accountEl.querySelector(".account-header");
        const accountDetails = {};
        if (header) {
          header.querySelectorAll(".checkout-field-row").forEach((row) => {
            const label = text(row.querySelector(".col-xs-3"))?.replace(":", "");
            const valueCol = row.querySelector(".col-xs-9");
            if (!label || !valueCol) return;

            if (label.toLowerCase().includes("sevk adresi")) {
              const lines = Array.from(valueCol.querySelectorAll(".ng-binding"))
                .map(text)
                .filter(Boolean);
              accountDetails[label] = lines;
            } else {
              accountDetails[label] = text(valueCol);
            }
          });
        }

        const orders = [];
        accountEl
          .querySelectorAll('[ng-repeat="referenceGroup in account.Orders"]')
          .forEach((groupEl) => {
            const deliveryDate = text(groupEl.querySelector(".bold-date"));

            const items = [];
            groupEl
              .querySelectorAll('tbody tr[ng-repeat="item in referenceGroup.OrderItems"]')
              .forEach((itemEl) => {
                const tds = itemEl.querySelectorAll("td");
                if (tds.length < 3) return;

                const productCell = itemEl.querySelector("td.product") || tds[0];
                const productText = text(productCell);

                const codeMatch = productText.match(/\[([A-Z0-9]+)\]/i);
                const productCode = codeMatch ? codeMatch[1].trim() : "";

                const brandMatch = productText.match(/\(([^)]+)\)/);
                const brand = brandMatch ? brandMatch[1].trim() : "";

                const descEl = productCell.querySelector(".p-description");
                let description = descEl ? text(descEl) : productText;
                if (!descEl) {
                  description = description
                    .replace(/\([^)]+\)/, "")
                    .replace(/\[[^\]]+\]/, "")
                    .trim();
                }

                const sizeUnitCell = tds[1];
                const size = text(sizeUnitCell.querySelector('[ng-if="item.Product.PackSize"]')) || "";
                const uom = text(sizeUnitCell.querySelector('[ng-if="item.UOMDesc"]')) || "";

                const qty = text(tds[2].querySelector(".ng-binding")) || text(tds[2]) || "";

                const rightTds = Array.from(itemEl.querySelectorAll("td.text-right"));
                const priceTds = rightTds.slice(1);

                const unitPrice = text(priceTds[0]) || "";
                const subTotal = text(priceTds[1]) || "";
                const tax = text(priceTds[2]) || "";
                const total = text(priceTds[3]) || "";

                items.push({
                  description,
                  brand,
                  productCode,
                  size: size.replace(/\/\s*$/, "").trim(),
                  uom,
                  qty,
                  unitPrice,
                  subTotal,
                  tax,
                  total,
                });
              });

            orders.push({ deliveryDate, items });
          });

        accounts.push({
          accountTitle,
          accountCode: accountDetails["Hesap Kodu"] || accountCodeFromTitle || "",
          accountDetails,
          orders,
        });
      });

    const summary = {};
    document.querySelectorAll(".checkout-summary .checkout-field-row").forEach((row) => {
      const label = text(row.querySelector(".col-xs-6:first-child"));
      const value = text(row.querySelector(".col-xs-6:last-child"));
      if (label) summary[label] = value || "";
    });

    return { orderInfo, accounts, summary };
  }).catch((e) => ({ error: String(e) }));
}

async function checkoutDelivery(page, params) {
  const { orderRef, deliveryDateText, deliveryAddress, submit = true, waitBefore = 5000 } = params || {};

  const result = {
    ok: true,
    orderRef: orderRef ?? null,
    deliveryDateText: deliveryDateText ?? null,
    deliveryAddress: deliveryAddress ?? null,
    submit: !!submit,
    orderRefSet: false,
    deliveryAddressSelected: false,
    deliveryDateSelected: false,
    submitted: false,
    confirmationUrl: null,
  };

  // ADIM 1: Sepet ikonuna tıkla
  console.log("ADIM 1: Sepet ikonuna tıklanıyor...");
  const cartIcon = page.locator('[data-cy="top-menu_click-check-out-state"]').first();
  await cartIcon.waitFor({ state: "attached", timeout: 30000 });
  await cartIcon.click();
  await sleep(page, 2000);

  // ADIM 2: Siparişi Tamamla
  console.log("ADIM 2: Siparişi Tamamla tıklanıyor...");
  const checkoutBtn = page.locator('[data-cy="click-checkout-landing"]').first();
  await checkoutBtn.waitFor({ state: "attached", timeout: 30000 });
  await checkoutBtn.click();
  await sleep(page, waitBefore);
  console.log("Sipariş Detayları sayfası:", page.url());

  // ADIM 3: OrderRef yaz
  if (orderRef && String(orderRef).trim().length > 0) {
    console.log("ADIM 3: OrderRef yazılıyor...", orderRef);
    const refInput = page.locator('[data-cy="headerOrderRef"]').first();
    await refInput.waitFor({ state: "attached", timeout: 30000 });
    await refInput.scrollIntoViewIfNeeded().catch(() => {});
    await refInput.click();
    await sleep(page, 200);
    await refInput.selectText().catch(() => {});
    await refInput.fill(String(orderRef));
    await refInput.evaluate((el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      try {
        const s = angular.element(el).scope();
        if (s) s.$apply();
      } catch (e) {}
    });
    await sleep(page, 500);
    result.orderRefSet = true;
  }

  // ADIM 4: Devam butonu
  console.log("ADIM 4: Devam butonuna tıklanıyor...");
  const continueBtn = page.locator('[data-cy="continue-button"]').first();
  await continueBtn.waitFor({ state: "attached", timeout: 30000 });
  await continueBtn.scrollIntoViewIfNeeded().catch(() => {});
  await continueBtn.click();
  await sleep(page, waitBefore);
  console.log("Sevk Detayları sayfası:", page.url());

  // ADIM 5: Sevk Adresi Seç
  if (deliveryAddress && String(deliveryAddress).trim().length > 0) {
    console.log("ADIM 5: Sevk adresi seçiliyor...", deliveryAddress);
    const wanted = String(deliveryAddress).trim().toUpperCase();

    // uib-dropdown toggle butonuna tıkla (dropdown'ı aç)
    const addressToggle = page.locator("button.wrap-address").first();
    await addressToggle.waitFor({ state: "attached", timeout: 30000 });
    await addressToggle.scrollIntoViewIfNeeded().catch(() => {});
    await addressToggle.click();
    await sleep(page, 1000);

    // Açılan listedeki tüm adres linkleri
    const addressLinks = page.locator('a[data-cy="click-switch-addressaccount-address"]');
    const allAddresses = await addressLinks.allTextContents().catch(() => []);
    console.log("Mevcut adresler:", allAddresses);

    // Tam eşleşme dene
    let hitLink = addressLinks.filter({ hasText: new RegExp(wanted, "i") }).first();

    // Kısmi eşleşme: kelimeleri tek tek dene
    if ((await hitLink.count()) === 0) {
      const words = wanted
        .split(/[\s\-]+/)
        .filter((w) => w.length > 3);
      for (const word of words) {
        hitLink = addressLinks.filter({ hasText: new RegExp(word, "i") }).first();
        if ((await hitLink.count()) > 0) {
          console.log(`Kısmi eşleşme bulundu: "${word}"`);
          break;
        }
      }
    }

    if ((await hitLink.count()) === 0) {
      return {
        ok: false,
        status: 404,
        error: `Adres bulunamadı: ${wanted}`,
        availableAddresses: allAddresses.map((x) => (x || "").trim()).filter(Boolean),
        ...result,
      };
    }

    const selectedText = await hitLink.textContent().catch(() => "");
    await hitLink.scrollIntoViewIfNeeded().catch(() => {});
    await hitLink.click();
    await sleep(page, 2000);

    result.deliveryAddressSelected = true;
    result.selectedAddress = selectedText.trim();
    console.log("✅ Adres seçildi:", result.selectedAddress);
  }

  // ADIM 6: Tarih seç
  if (deliveryDateText && String(deliveryDateText).trim().length > 0) {
    console.log("ADIM 6: Tarih seçiliyor...", deliveryDateText);
    const wanted = String(deliveryDateText).trim();

    const dropdownBtn = page.locator('[data-cy="delivery-date-dropdown"]').first();
    await dropdownBtn.waitFor({ state: "attached", timeout: 30000 });
    await dropdownBtn.scrollIntoViewIfNeeded().catch(() => {});
    await dropdownBtn.click();
    await sleep(page, 1000);

    const menu = page.locator('ul[data-cy="delivery-date-menu"]').first();
    await menu.waitFor({ state: "attached", timeout: 30000 });
    const allOptions = await menu.locator("li").allTextContents().catch(() => []);
    const cleanOptions = allOptions.map((x) => (x || "").trim()).filter(Boolean);

    // Menüde tarih arama yardımcı fonksiyonu
    const findInMenu = async (searchText) => {
      let li = menu
        .locator('[data-cy="click-set-dateparentindex-account-date"]')
        .filter({ hasText: searchText })
        .first();
      if ((await li.count()) > 0) return li;

      li = menu.locator("li").filter({ hasText: searchText }).first();
      if ((await li.count()) > 0) return li;

      const dayMatch = searchText.match(/(\d+)/);
      if (dayMatch) {
        li = menu.locator("li").filter({ hasText: dayMatch[1] }).first();
        if ((await li.count()) > 0) return li;
      }

      return null;
    };

    // Türkçe ay isimleri
    const turkishMonths = {
      "Ocak": 0, "Subat": 1, "\u015eubat": 1, "Mart": 2, "Nisan": 3,
      "Mayis": 4, "May\u0131s": 4, "Haziran": 5, "Temmuz": 6,
      "Agustos": 7, "A\u011fustos": 7, "Eylul": 8, "Eyl\u00fcl": 8,
      "Ekim": 9, "Kasim": 10, "Kas\u0131m": 10, "Aralik": 11, "Aral\u0131k": 11
    };
    const monthNames = ["Ocak","\u015eubat","Mart","Nisan","May\u0131s","Haziran","Temmuz","A\u011fustos","Eyl\u00fcl","Ekim","Kas\u0131m","Aral\u0131k"];

    // Tarihi parse et
    const parseDate = (text) => {
      const trMatch = text.match(/(\d+)\s+(Ocak|\u015eubat|Subat|Mart|Nisan|May\u0131s|Mayis|Haziran|Temmuz|A\u011fustos|Agustos|Eyl\u00fcl|Eylul|Ekim|Kas\u0131m|Kasim|Aral\u0131k|Aralik)/i);
      if (trMatch) {
        const day = parseInt(trMatch[1]);
        const month = turkishMonths[trMatch[2]];
        const year = new Date().getFullYear();
        return new Date(year, month, day);
      }
      const dotMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      if (dotMatch) {
        return new Date(parseInt(dotMatch[3]), parseInt(dotMatch[2]) - 1, parseInt(dotMatch[1]));
      }
      const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (isoMatch) {
        return new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
      }
      return null;
    };

    // 1. İstenen tarihi dene
    let hitLi = await findInMenu(wanted);

    // 2. Bulunamadıysa → ertesi günü dene
    if (!hitLi) {
      console.log(`Tarih bulunamad\u0131: "${wanted}" \u2014 Ertesi g\u00fcn deneniyor...`);
      const parsedDate = parseDate(wanted);
      if (parsedDate) {
        parsedDate.setDate(parsedDate.getDate() + 1);
        const nextDateText = `${parsedDate.getDate()} ${monthNames[parsedDate.getMonth()]}`;
        console.log(`Ertesi g\u00fcn aran\u0131yor: "${nextDateText}"`);
        hitLi = await findInMenu(nextDateText);
        if (hitLi) {
          result.autoDateFallback = true;
          result.autoDateRequested = wanted;
          result.autoDateNextDay = nextDateText;
          console.log(`\u2705 Ertesi g\u00fcn bulundu: "${nextDateText}"`);
        }
      }
    }

    // 3. Hâlâ bulunamadıysa → ilk mevcut tarihe düş
    if (!hitLi) {
      console.log(`Ertesi g\u00fcn de bulunamad\u0131 \u2014 Otomatik ilk tarih deneniyor:`, cleanOptions[0]);
      if (cleanOptions.length > 0) {
        hitLi = menu.locator("li").filter({ hasText: cleanOptions[0] }).first();
        result.autoDateFallback = true;
        result.autoDateRequested = wanted;
        result.autoDateSelected = cleanOptions[0];
      }
      if (!hitLi || (await hitLi.count()) === 0) {
        return {
          ok: false,
          status: 404,
          error: `Tarih bulunamad\u0131: ${wanted}`,
          availableDates: cleanOptions,
          ...result,
        };
      }
    }

    const anchor = hitLi.locator("a").first();
    const clickTarget = (await anchor.count()) > 0 ? anchor : hitLi;
    const selectedText = await hitLi.textContent().catch(() => "");
    await clickTarget.scrollIntoViewIfNeeded().catch(() => {});
    await clickTarget.click();
    await sleep(page, 2000);

    result.deliveryDateSelected = true;
    result.selectedDateText = (selectedText || "").trim();
    console.log("Tarih seçildi:", result.selectedDateText);
  }

  // ADIM 7: Gönder
  if (submit) {
    console.log("ADIM 7: Gönder butonuna tıklanıyor...");
    const submitBtn = page.locator('[data-cy="click-submit-orderaccount-submit"]').first();
    await submitBtn.waitFor({ state: "attached", timeout: 60000 });
    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});

    for (let i = 0; i < 15; i++) {
      const isDisabled = await submitBtn.isDisabled().catch(() => true);
      if (!isDisabled) break;
      console.log(`Submit butonu disabled, bekleniyor... (${i + 1}/15)`);
      await sleep(page, 1000);
    }

    const screenshotBase64 = await page
      .screenshot({ fullPage: false })
      .then((buf) => buf.toString("base64"))
      .catch(() => null);
    result.screenshotBase64 = screenshotBase64;

    const preSubmitState = await page
      .evaluate(() => {
        try {
          const btn = document.querySelector('[data-cy="click-submit-orderaccount-submit"]');
          let s = angular.element(btn).scope();
          let depth = 0;
          while (s && depth < 15) {
            if (s.account && s.account.Header) break;
            s = s.$parent;
            depth++;
          }
          const h = s && s.account && s.account.Header;
          return {
            ReferenceNumber: h && h.ReferenceNumber,
            submitDisabled: s && s.submitDisabled,
            url: window.location.href,
          };
        } catch (e) {
          return { error: e.message };
        }
      })
      .catch((e) => ({ error: String(e) }));
    console.log("Pre-submit state:", JSON.stringify(preSubmitState));
    result.preSubmitState = preSubmitState;

    await submitBtn.click();
    console.log("✅ Gönder butonuna tıklandı");
    await sleep(page, 3000);

    let confirmationReached = false;
    for (let i = 0; i < 30; i++) {
      const currentUrl = page.url();
      console.log(`Check ${i + 1}/30: ${currentUrl}`);
      if (currentUrl.includes("/checkout/confirmation")) {
        confirmationReached = true;
        break;
      }
      await sleep(page, 3000);
    }

    if (confirmationReached) {
      result.submitted = true;
      result.confirmationUrl = page.url();

      await page.waitForSelector(".checkout-block", { timeout: 60000 }).catch(() => {});
      await page
        .waitForSelector('.account-wrap[ng-repeat="account in accounts"]', { timeout: 60000 })
        .catch(() => {});

      console.log("ADIM 8: Confirmation sayfasından veriler çekiliyor...");
      const confirmationData = await scrapeConfirmationPage(page);
      result.confirmationData = confirmationData;
      console.log("Confirmation verisi alındı:", JSON.stringify(confirmationData).slice(0, 200));
    } else {
      const errorTexts = await page
        .locator("text=/hata|error|başarısız|geçersiz|uyarı/i")
        .allTextContents()
        .catch(() => []);
      const failScreenshot = await page
        .screenshot({ fullPage: false })
        .then((buf) => buf.toString("base64"))
        .catch(() => null);
      return {
        ok: false,
        status: 500,
        error: "Submit sonrası confirmation görülmedi",
        currentUrl: page.url(),
        errorTexts: errorTexts.filter(Boolean),
        failScreenshot,
        ...result,
      };
    }
  }

  return result;
}

// ✅ LOGIN TEST
app.post("/login-test", async (req, res) => {
  const { username, password } = req.body || {};

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  try {
    const result = await withTimeout(login(page, username, password), 60000);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// ✅ TEK ÜRÜN + (opsiyonel) checkout
app.post("/add-to-cart", async (req, res) => {
  const { username, password, productCode, uom, qty, checkout } = req.body || {};

  if (!username || !password) return res.status(400).json({ ok: false, error: "username/password zorunlu" });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  try {
    const loginResult = await withTimeout(login(page, username, password), 60000);
    if (!loginResult.loggedIn) return res.status(401).json({ ok: false, step: "login", ...loginResult });

    await withTimeout(clearCartAfterLogin(page), 60000, "CLEAR_CART_TIMEOUT"); // sepet temizleme
    const itemResult = await withTimeout(addOneItem(page, { productCode, uom, qty }), 180000, "ITEM_TIMEOUT");

    let checkoutResult = null;
    if (checkout && itemResult.ok) {
      checkoutResult = await withTimeout(checkoutDelivery(page, checkout), 180000, "CHECKOUT_TIMEOUT");
    }

    const results = [itemResult];
    const summary = {
      total: 1,
      done: itemResult.ok ? 1 : 0,
      failed: itemResult.ok ? 0 : 1,
    };

    return res.json({
      ok: itemResult.ok && (!checkout || (checkoutResult && checkoutResult.ok)),
      summary,
      results,
      checkoutResult,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// ✅ ÇOKLU ÜRÜN: batch + (opsiyonel) checkout
app.post("/add-to-cart-batch", async (req, res) => {
  const { username, password, items, stopOnError = true, checkout } = req.body || {};

  if (!username || !password) return res.status(400).json({ ok: false, error: "username/password zorunlu" });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ ok: false, error: "items[] zorunlu" });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  try {
    const loginResult = await withTimeout(login(page, username, password), 60000);
    if (!loginResult.loggedIn) return res.status(401).json({ ok: false, step: "login", ...loginResult });

    await withTimeout(clearCartAfterLogin(page), 60000, "CLEAR_CART_TIMEOUT"); // sepet temizleme

    const results = [];
    for (const it of items) {
      const r = await withTimeout(addOneItem(page, it), 180000, "ITEM_TIMEOUT");
      results.push(r);

      if (!r.ok && stopOnError) break;

      await sleep(page, 1500);
    }

    const summary = {
      total: items.length,
      done: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };

    let checkoutResult = null;
    if (checkout && (summary.failed === 0 || !stopOnError)) {
      checkoutResult = await withTimeout(checkoutDelivery(page, checkout), 240000, "CHECKOUT_TIMEOUT");
    }

    return res.json({
      ok: (summary.failed === 0 || !stopOnError) && (!checkout || (checkoutResult && checkoutResult.ok)),
      summary,
      results,
      checkoutResult,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// 🔍 DEBUG: Checkout/delivery sayfasının tam DOM yapısını döker
app.post("/debug-checkout-page", async (req, res) => {
  const { username, password, productCode, uom, qty, waitBefore = 10000 } = req.body || {};

  if (!username || !password) return res.status(400).json({ ok: false, error: "username/password zorunlu" });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  try {
    const loginResult = await withTimeout(login(page, username, password), 60000);
    if (!loginResult.loggedIn) return res.status(401).json({ ok: false, step: "login", ...loginResult });

    if (productCode) {
      await withTimeout(addOneItem(page, { productCode, uom, qty }), 180000, "ITEM_TIMEOUT");
    }

    const deliveryUrl = `${BASE_URL}/#/checkout/delivery`;
    await page.goto(deliveryUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(waitBefore);

    const fullHtml = await page.content();

    const submitBtnState = await page
      .evaluate(() => {
        const btn = document.querySelector('[data-cy="click-submit-orderaccount-submit"]');
        if (!btn) return { found: false };
        return {
          found: true,
          disabled: btn.disabled,
          className: btn.className,
          outerHTML: btn.outerHTML,
          ngDisabled: btn.getAttribute("ng-disabled"),
          ngClick: btn.getAttribute("ng-click"),
        };
      })
      .catch((e) => ({ error: String(e) }));

    const inputs = await page
      .evaluate(() => {
        return Array.from(document.querySelectorAll("input, select, textarea")).map((el) => ({
          tag: el.tagName,
          type: el.type,
          name: el.name,
          id: el.id,
          value: el.value,
          disabled: el.disabled,
          ngModel: el.getAttribute("ng-model"),
          dataCy: el.getAttribute("data-cy"),
          placeholder: el.placeholder,
        }));
      })
      .catch((e) => ({ error: String(e) }));

    const errorMessages = await page.locator("text=/hata|error|uyarı|warning/i").allTextContents().catch(() => []);

    const angularScope = await page
      .evaluate(() => {
        try {
          const btn = document.querySelector('[data-cy="click-submit-orderaccount-submit"]');
          if (!btn) return { error: "btn not found" };

          let scope = angular.element(btn).scope();
          let targetScope = scope;
          let depth = 0;
          while (targetScope && depth < 15) {
            if (typeof targetScope.submitOrder === "function" || typeof targetScope.checkMinOrderSubmit === "function") break;
            targetScope = targetScope.$parent;
            depth++;
          }

          if (!targetScope) return { error: "scope with submitOrder not found" };

          const result = {
            submitDisabled: targetScope.submitDisabled,
            hasRestrictedDeliveryItems: targetScope.hasRestrictedDeliveryItems,
            approvalNeeded: targetScope.approvalNeeded,
            canTradeOnline: targetScope.canTradeOnline,
            canAllowCredit: targetScope.canAllowCredit,
            isApproverShadowSession: targetScope.isApproverShadowSession,
            checkMinOrderSubmitResult: null,
            checkRestrictedProductResult: null,
          };

          try {
            result.checkMinOrderSubmitResult = targetScope.checkMinOrderSubmit();
          } catch (e) {
            result.checkMinOrderSubmitResult = "ERROR: " + e.message;
          }

          try {
            const account = targetScope.account || (targetScope.accounts && targetScope.accounts[0]);
            result.checkRestrictedProductResult = targetScope.checkRestrictedProduct(account);
            result.account = {
              ReferenceNumber: account && account.Header && account.Header.ReferenceNumber,
              DeliveryDate: account && account.Header && account.Header.DeliveryDate,
              HasItems: account && account.Entries && account.Entries.length,
            };
          } catch (e) {
            result.checkRestrictedProductResult = "ERROR: " + e.message;
          }

          return result;
        } catch (e) {
          return { error: e.message };
        }
      })
      .catch((e) => ({ error: String(e) }));

    return res.json({
      ok: true,
      currentUrl: page.url(),
      submitBtnState,
      angularScope,
      inputs,
      errorMessages: errorMessages.filter(Boolean),
      fullHtml,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
