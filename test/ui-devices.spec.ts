import { expect, test, type Page } from "@playwright/test";

const baseURL = process.env.DASHCAM_E2E_BASE_URL ?? "http://127.0.0.1:8181";
const token = process.env.DASHCAM_E2E_SESSION_TOKEN ?? "ui-device-test-session";
const tripId = process.env.DASHCAM_E2E_TRIP_ID ?? "v2|u:1|d:2|MS279WG-ui-test";
const mivueTripId = process.env.DASHCAM_E2E_MIVUE_TRIP_ID ?? "v2|u:1|d:1|MiVue-ui-test";

test.use({ baseURL });

async function authenticate(page: Page): Promise<void> {
  const url = new URL(baseURL);
  await page.context().addCookies([{
    name: "session_token",
    value: token,
    domain: url.hostname,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  }]);
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }))).toEqual(expect.objectContaining({
    content: expect.any(Number),
    viewport: expect.any(Number),
  }));
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  const overflowing = overflow > 1 ? await page.evaluate(() => [...document.querySelectorAll('*')].filter(el=>{
    const rect=el.getBoundingClientRect();return rect.width>0 && rect.right>document.documentElement.clientWidth+1;
  }).map(el=>({tag:el.tagName,cls:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right}))) : [];
  expect(overflow,JSON.stringify(overflowing)).toBeLessThanOrEqual(1);
}

async function expectDeviceCountAnchored(page: Page): Promise<void> {
  const label = page.locator("#device-section-title > span:first-child");
  const count = page.locator("#device-count");
  await expect(label).toBeVisible();
  await expect(count).toHaveText("2 / 12 台");

  const layout = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing device heading element: ${selector}`);
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    };
    return {
      label: rect("#device-section-title > span:first-child"),
      count: rect("#device-count"),
      title: rect("#device-section-title"),
      panel: rect("#devices"),
      add: rect("#device-add"),
    };
  });

  expect(layout.count.left).toBeGreaterThanOrEqual(layout.label.right + 5);
  expect(layout.count.left - layout.label.right).toBeLessThanOrEqual(10);
  expect(layout.count.top).toBeLessThan(layout.label.bottom);
  expect(layout.count.bottom).toBeGreaterThan(layout.label.top);
  expect(layout.count.left).toBeGreaterThanOrEqual(layout.title.left);
  expect(layout.count.right).toBeLessThanOrEqual(layout.title.right + 1);
  expect(layout.count.right).toBeLessThanOrEqual(layout.panel.right + 1);
  expect(layout.count.right).toBeLessThanOrEqual(layout.add.left);
}

test("桌機：多裝置設定、上傳來源與影片資訊完整串接", async ({ page }, testInfo) => {
  await authenticate(page);
  const errors = watchErrors(page);

  await page.goto("/account#devices");
  await expect(page.locator("#devices")).toBeVisible();
  await expect(page.locator(".device-item")).toHaveCount(2);
  await expectDeviceCountAnchored(page);
  const polaroid = page.locator(".device-item").filter({ hasText: "Polaroid MS279WG" });
  await expect(polaroid).toContainText("機車固定式");
  await expect(polaroid).toContainText("前後雙鏡頭，固定安裝於機車車身（非安全帽）");
  await expect(polaroid.locator(".device-pill--default")).toHaveText("預設");
  await polaroid.getByRole("button", { name: /編輯/ }).click();
  await expect(page.getByRole("dialog", { name: "編輯行車記錄器" })).toBeVisible();
  await expect(page.locator("#device-profile")).toHaveValue("polaroid-ms279wg");
  await page.locator("#device-cancel").click();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("account-desktop.png"), fullPage: true });

  await page.goto("/upload");
  await expect(page.locator("#create-device")).toHaveCount(0);
  const actionBoxes = await page.locator(".create-actions .btn").evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height };
    }),
  );
  expect(actionBoxes).toHaveLength(2);
  expect(Math.abs(actionBoxes[0]!.top - actionBoxes[1]!.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(actionBoxes[0]!.bottom - actionBoxes[1]!.bottom)).toBeLessThanOrEqual(1);
  expect(actionBoxes[0]!.height).toBe(actionBoxes[1]!.height);
  expect(actionBoxes[0]!.right).toBeLessThanOrEqual(actionBoxes[1]!.left);
  await page.locator("#create-btn").click();
  const session = page.locator("#sessions-list .sftp-card");
  await expect(session).toHaveCount(1);
  const source = session.locator("[data-device-select]");
  const confirm = session.locator('[data-act="confirm"]');
  await expect(page.locator("[data-device-select]")).toHaveCount(1);
  await expect(source.locator("option:checked")).toContainText("Polaroid MS279WG");
  await expect(confirm).toBeEnabled();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("upload-desktop.png"), fullPage: true });
  page.once("dialog", (dialog) => dialog.accept());
  await session.locator('[data-act="cancel"]').click();
  await expect(session).toHaveCount(0);

  const extraDeviceResponse = await page.request.post("/api/account/devices", {
    data: {
      profile_key: "mivue-mp20",
      model: "暫存測試記錄器",
      nickname: "待封存",
      note: "測試工作階段快照",
      show_on_trips: true,
    },
  });
  expect(extraDeviceResponse.ok()).toBeTruthy();
  const extraDevice = await extraDeviceResponse.json() as { device: { id: number } };
  const staleSessionResponse = await page.request.post("/api/upload-sessions", {
    data: { device_id: extraDevice.device.id },
  });
  expect(staleSessionResponse.ok()).toBeTruthy();
  const staleSession = await staleSessionResponse.json() as { id: string };
  const archiveResponse = await page.request.delete(`/api/account/devices/${extraDevice.device.id}`);
  expect(archiveResponse.ok()).toBeTruthy();

  await page.goto("/upload");
  const staleCard = page.locator(`#sc-${staleSession.id}`);
  await expect(staleCard.locator("[data-device-select] option:checked"))
    .toHaveText("原裝置已封存或資料已變更，請重新選擇");
  await expect(staleCard.locator('[data-act="confirm"]')).toBeDisabled();
  await staleCard.locator("[data-device-select]").selectOption("2");
  await expect(staleCard.locator("[data-device-select] option:checked")).toContainText("Polaroid MS279WG");
  await expect(staleCard.locator('[data-act="confirm"]')).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await staleCard.locator('[data-act="cancel"]').click();
  await expect(staleCard).toHaveCount(0);

  await page.goto(`/trip/${encodeURIComponent(tripId)}`);
  await expect(page.locator("#page-main")).toBeVisible();
  await expect(page.locator("#info-strip")).toContainText("Polaroid MS279WG");
  await expect(page.locator("#info-strip")).not.toContainText("機車固定式");
  await expect(page.locator("#device-inline")).toHaveCount(0);
  await expect(page.locator("#page-main")).not.toContainText("非安全帽");
  await expect(page.locator("video")).toHaveCount(2);
  await expect.poll(() => page.locator("video").first().evaluate((video: HTMLVideoElement) => video.readyState))
    .toBeGreaterThanOrEqual(1);
  const range = await page.request.get(`/video/${encodeURIComponent(tripId)}/front`, {
    headers: { Range: "bytes=0-1023" },
  });
  expect(range.status()).toBe(206);
  expect(range.headers()["content-type"]).toContain("video/mp4");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("trip-desktop.png"), fullPage: true });

  const decoded = await page.locator(".stage-video").evaluate(async (video: HTMLVideoElement) => {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("seek timeout")), 15_000);
      video.addEventListener("seeked", () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
      video.currentTime = Math.min(30, video.duration / 2);
    });
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 36;
    const context = canvas.getContext("2d")!;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let min = 255;
    let max = 0;
    let nonBlack = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const luminance = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
      min = Math.min(min, luminance);
      max = Math.max(max, luminance);
      if (luminance > 12) nonBlack++;
    }
    return { min, max, nonBlack, total: pixels.length / 4, readyState: video.readyState };
  });
  expect(decoded.readyState).toBe(4);
  expect(decoded.max - decoded.min).toBeGreaterThan(100);
  expect(decoded.nonBlack / decoded.total).toBeGreaterThan(0.8);

  await page.goto(`/trip/${encodeURIComponent(mivueTripId)}`);
  await expect(page.locator("#page-main")).toBeVisible();
  await expect(page.locator("#info-strip")).toContainText("MiVue™ MP20");
  await expect(page.locator("#device-inline")).toHaveCount(0);
  await expect(page.getByText("MiVue™ MP20", { exact: true })).toHaveCount(1);

  expect(errors).toEqual([]);
});

test.describe("手機版", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("裝置設定與旅程資訊無溢位或重疊", async ({ page }, testInfo) => {
    await authenticate(page);
    const errors = watchErrors(page);
    await page.goto("/account#devices");
    await expect(page.locator(".device-item")).toHaveCount(2);
    await expectDeviceCountAnchored(page);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("account-mobile.png"), fullPage: true });

    await page.goto("/upload");
    await expect(page.locator("#create-device")).toHaveCount(0);
    const mobileActions = page.locator(".create-actions .btn");
    await expect(mobileActions).toHaveCount(2);
    const mobileActionBoxes = await mobileActions.evaluateAll((buttons) =>
      buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          textFits: button.scrollWidth <= button.clientWidth && button.scrollHeight <= button.clientHeight,
        };
      }),
    );
    expect(Math.abs(mobileActionBoxes[0]!.top - mobileActionBoxes[1]!.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(mobileActionBoxes[0]!.bottom - mobileActionBoxes[1]!.bottom)).toBeLessThanOrEqual(1);
    expect(mobileActionBoxes[0]!.right).toBeLessThanOrEqual(mobileActionBoxes[1]!.left);
    expect(mobileActionBoxes.every((box) => box.textFits)).toBeTruthy();
    await page.locator("#create-btn").click();
    const session = page.locator("#sessions-list .sftp-card");
    await expect(page.locator("[data-device-select]")).toHaveCount(1);
    await expect(session.locator("[data-device-select] option:checked")).toContainText("Polaroid MS279WG");
    await expect(session.locator('[data-act="confirm"]')).toBeEnabled();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("upload-mobile.png"), fullPage: true });
    page.once("dialog", (dialog) => dialog.accept());
    await session.locator('[data-act="cancel"]').click();
    await expect(session).toHaveCount(0);

    await page.goto(`/trip/${encodeURIComponent(tripId)}`);
    await expect(page.locator("#info-strip")).toContainText("Polaroid MS279WG");
    await expect(page.locator("#info-strip")).not.toContainText("機車固定式");
    await expect(page.locator("#device-inline")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("trip-mobile.png"), fullPage: true });

    await page.goto(`/trip/${encodeURIComponent(mivueTripId)}`);
    await expect(page.locator("#info-strip")).toContainText("MiVue™ MP20");
    await expect(page.locator("#device-inline")).toHaveCount(0);
    await expect(page.getByText("MiVue™ MP20", { exact: true })).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });
});
