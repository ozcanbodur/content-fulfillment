async function checkoutDelivery(page, opts = {}) {
  const deliveryUrl = "https://www.mybidfood.com.tr/#/checkout/delivery";
  const orderRef = String(opts.orderRef ?? "").trim();
  const deliveryDateText = String(opts.deliveryDateText ?? "").trim();
  const submit = !!opts.submit;

  await page.goto(deliveryUrl, { waitUntil: "domcontentloaded" });

  // Angular sayfa otursun
  await sleep(page, WAIT);

  let orderRefSet = false;
  let deliveryDateSelected = false;
  let submitted = false;

  // 1) Sipariş no
  if (orderRef) {
    const ref = page.locator('input[name="orderreference"]').first();
    await ref.waitFor({ state: "visible", timeout: 60000 }).catch(() => null);

    if (await ref.count()) {
      await ref.scrollIntoViewIfNeeded().catch(() => {});
      await ref.click({ force: true }).catch(() => {});
      await ref.fill(orderRef).catch(() => {});
      await ref.dispatchEvent("input").catch(() => {});
      await ref.dispatchEvent("change").catch(() => {});
      await ref.dispatchEvent("blur").catch(() => {});
      orderRefSet = true;
    }
  }

  await sleep(page, 1000);

  // 2) Sevk tarihi seç
  if (deliveryDateText) {
    const dropdownBtn = page.locator('[data-cy="delivery-date-dropdown"]').first();
    await dropdownBtn.waitFor({ state: "visible", timeout: 60000 }).catch(() => null);

    if (await dropdownBtn.count()) {
      await dropdownBtn.scrollIntoViewIfNeeded().catch(() => {});
      await dropdownBtn.click({ force: true }).catch(() => {});
      await sleep(page, 800);

      const menu = page.locator('ul[data-cy="delivery-date-menu"]').first();
      await menu.waitFor({ state: "visible", timeout: 15000 }).catch(() => null);

      const li = menu.locator("li", { hasText: deliveryDateText }).first();
      if (await li.count()) {
        await li.scrollIntoViewIfNeeded().catch(() => {});
        await li.click({ force: true }).catch(() => {});
        deliveryDateSelected = true;
        // Tarih seçimi sonrası Angular'ın güncellemesi için bekle
        await sleep(page, 2000);
      } else {
        const options = await menu.evaluate((ul) =>
          Array.from(ul.querySelectorAll("li")).map((x) => (x.innerText || "").trim()).filter(Boolean)
        );
        return {
          ok: false,
          deliveryUrl,
          orderRef,
          deliveryDateText,
          submit,
          orderRefSet,
          deliveryDateSelected: false,
          submitted: false,
          error: `Delivery date bulunamadı: ${deliveryDateText}`,
          availableDates: options,
          currentUrl: page.url(),
        };
      }
    }
  }

  // 3) Gönder - Console kodundaki mantık ile
  if (submit) {
    const submitDiv = page.locator('[data-cy="click-submit-orderaccount-submit"]').first();
    await submitDiv.waitFor({ state: "visible", timeout: 60000 }).catch(() => null);

    if (await submitDiv.count()) {
      // ng-disabled kontrolü ve tıklama - console kodundaki gibi
      const clickResult = await submitDiv.evaluate((btn) => {
        const ngDisabled = btn.getAttribute("ng-disabled");
        
        // Butonu scroll et ve görünür yap
        btn.scrollIntoView({ block: "center" });
        
        // Tıkla
        btn.click();
        
        return {
          clicked: true,
          ngDisabled: ngDisabled,
          wasDisabled: ngDisabled === "true" || ngDisabled === "1"
        };
      });

      await sleep(page, 2000);

      // URL değişikliğini kontrol et
      const afterUrl = page.url();
      submitted = !afterUrl.includes("#/checkout/delivery") || 
                  afterUrl.includes("confirmation") || 
                  afterUrl.includes("complete");

      // Debug bilgisi
      console.log("✅ Gönder tıklandı:", clickResult);
      console.log("📍 Sonraki URL:", afterUrl);
      console.log("✔️ Submitted:", submitted);

    } else {
      return {
        ok: false,
        deliveryUrl,
        orderRef,
        deliveryDateText,
        submit,
        orderRefSet,
        deliveryDateSelected,
        submitted: false,
        error: "Submit/Gönder butonu bulunamadı",
        currentUrl: page.url(),
      };
    }
  }

  return {
    ok: true,
    deliveryUrl,
    orderRef,
    deliveryDateText,
    submit,
    orderRefSet,
    deliveryDateSelected,
    submitted,
    currentUrl: page.url(),
  };
}
