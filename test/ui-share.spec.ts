import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

const baseURL = process.env.DASHCAM_E2E_BASE_URL ?? "http://127.0.0.1:8181";
const sessionToken = process.env.DASHCAM_E2E_SESSION_TOKEN ?? "ui-device-test-session";
const tripId = process.env.DASHCAM_E2E_TRIP_ID ?? "v2|u:1|d:2|MS279WG-ui-test";
const playPath = "M8 5v14l11-7z";
const pausePath = "M6 5h4v14H6zM14 5h4v14h-4z";

test.use({ baseURL });
test.describe.configure({ timeout: 90_000 });

async function authenticate(page: Page): Promise<void> {
  const url = new URL(baseURL);
  await page.context().addCookies([{
    name: "session_token",
    value: sessionToken,
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
    if (message.type() === "error") {
      const source = message.location().url;
      errors.push(`console: ${message.text()}${source ? ` @ ${source}` : ""}`);
    }
  });
  return errors;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectShareModalFits(page: Page): Promise<void> {
  const layout = await page.locator("#share-modal .share-modal-box").evaluate((modal) => {
    const box = modal.getBoundingClientRect();
    const list = modal.querySelector<HTMLElement>("#share-list");
    return {
      left: box.left,
      right: box.right,
      viewportWidth: window.innerWidth,
      modalOverflow: modal.scrollWidth - modal.clientWidth,
      listOverflow: list ? list.scrollWidth - list.clientWidth : 0,
    };
  });
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.modalOverflow).toBeLessThanOrEqual(1);
  expect(layout.listOverflow).toBeLessThanOrEqual(1);
  await expectNoHorizontalOverflow(page);
}

async function expectShareButtonOutsidePlayer(page: Page): Promise<void> {
  const layout = await page.locator("#btn-link").evaluate((button) => {
    const buttonBox = button.getBoundingClientRect();
    const stage = document.querySelector<HTMLElement>("#stage");
    const info = document.querySelector<HTMLElement>("#info-strip");
    const summary = button.closest<HTMLElement>(".trip-summary-row");
    const actions = button.closest<HTMLElement>(".trip-media-actions");
    if (!stage || !info || !summary || !actions) throw new Error("缺少影片或摘要操作列");
    const stageBox = stage.getBoundingClientRect();
    const infoBox = info.getBoundingClientRect();
    return {
      insideStage: stage.contains(button),
      insideSummary: summary.contains(info),
      buttonTop: buttonBox.top,
      buttonBottom: buttonBox.bottom,
      stageBottom: stageBox.bottom,
      infoTop: infoBox.top,
      infoBottom: infoBox.bottom,
      actionsRight: actions.getBoundingClientRect().right,
      buttonRight: buttonBox.right,
      desktop: window.innerWidth > 560,
    };
  });
  expect(layout.insideStage).toBe(false);
  expect(layout.insideSummary).toBe(true);
  expect(layout.buttonTop).toBeGreaterThanOrEqual(layout.stageBottom - 1);
  expect(layout.actionsRight - layout.buttonRight).toBeGreaterThanOrEqual(-1);
  expect(layout.actionsRight - layout.buttonRight).toBeLessThanOrEqual(1);
  if (layout.desktop) {
    expect(layout.buttonTop).toBeLessThan(layout.infoBottom);
    expect(layout.buttonBottom).toBeGreaterThan(layout.infoTop);
  }
}

async function expectSinglePlaybackIcon(page: Page): Promise<void> {
  const button = page.locator("#btn-play");
  await expect(button.locator("svg")).toHaveCount(1);
  await expect(button.locator("[data-playback-icon] path")).toHaveAttribute("d", playPath);
  await expect(button).toHaveAttribute("aria-label", "播放");
}

async function expectPreciseSeek(page: Page): Promise<void> {
  const track = page.locator("#track");
  const seek = page.locator("#seek");
  const fill = page.locator("#fill");
  await expect.poll(() => page.locator("#stage video").first().evaluate(
    (video: HTMLVideoElement) => video.readyState,
  )).toBeGreaterThanOrEqual(1);
  await track.scrollIntoViewIfNeeded();
  const box = await track.boundingBox();
  if (!box) throw new Error("找不到可見進度軌道");

  const tap = async (ratio: number): Promise<void> => {
    const x = box.x + box.width * ratio;
    const y = box.y + box.height / 2;
    if ((page.viewportSize()?.width ?? 0) <= 640) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
    await expect.poll(async () => Math.abs(Number(await seek.inputValue()) - ratio * 100))
      .toBeLessThanOrEqual(0.11);
    const geometry = await fill.evaluate((element, expected) => {
      const fillBox = element.getBoundingClientRect();
      const trackBox = element.parentElement!.getBoundingClientRect();
      const times = [...document.querySelectorAll<HTMLVideoElement>("#stage video")]
        .map(video => video.duration ? video.currentTime / video.duration : 0);
      return {
        fillError: Math.abs(fillBox.width - trackBox.width * Number(expected)),
        timeErrors: times.map(value => Math.abs(value - Number(expected))),
      };
    }, ratio);
    expect(geometry.fillError).toBeLessThanOrEqual(1);
    expect(Math.max(...geometry.timeErrors)).toBeLessThanOrEqual(0.03);
  };

  for (const ratio of [0.1, 0.25, 0.5, 0.75, 0.9]) await tap(ratio);

  if ((page.viewportSize()?.width ?? 0) > 640) {
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.1, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => Math.abs(Number(await seek.inputValue()) - 90))
      .toBeLessThanOrEqual(0.11);

    await seek.focus();
    await page.keyboard.press("Home");
    await expect(seek).toHaveValue("0");
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => Number(await seek.inputValue())).toBeGreaterThan(0);
  }
  await tap(0.25);
}

async function expectEssentialContentInViewport(page: Page, shared: boolean): Promise<void> {
  const layout = await page.evaluate((isShared) => {
    const candidates = isShared
      ? [document.querySelector(".share-facts")]
      : [document.querySelector("#other-row"), document.querySelector("#info-strip")];
    const visible = candidates.filter((element): element is Element => Boolean(element))
      .filter(element => getComputedStyle(element).display !== "none");
    const bottom = Math.max(...visible.map(element => element.getBoundingClientRect().bottom));
    return {
      bottom,
      viewportHeight: window.innerHeight,
      stageHeight: document.querySelector("#stage")!.getBoundingClientRect().height,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      dark: document.documentElement.getAttribute("data-theme") === "dark",
    };
  }, shared);
  expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.stageHeight).toBeGreaterThanOrEqual(239);
  expect(layout.overflow).toBeLessThanOrEqual(1);
  if (shared) {
    expect(layout.dark).toBe(false);
    expect(layout.colorScheme).toBe("light");
  }
}

async function createShareFromTrip(page: Page): Promise<{ shareUrl: string; activeBefore: number; shareId: number }> {
  await authenticate(page);
  await page.goto(`/trip/${encodeURIComponent(tripId)}`);
  await expect(page.locator("#page-main")).toBeVisible();

  const shareButton = page.locator("#btn-link");
  await expect(shareButton).toBeVisible();
  await expect(shareButton).toContainText("快速分享");
  await expectShareButtonOutsidePlayer(page);
  await expectSinglePlaybackIcon(page);
  await expectPreciseSeek(page);
  if ((page.viewportSize()?.width ?? 0) > 760) await expectEssentialContentInViewport(page, false);
  await shareButton.click();
  await expect(page.locator("#share-modal")).toBeVisible();
  await expect(page.locator("#share-expiry")).toHaveValue("7");
  await expect(page.locator("#share-count")).toContainText("個有效連結", { timeout: 15_000 });

  const activeRows = page.locator("#share-list .share-row .share-status:not(.off)");
  const activeBefore = await activeRows.count();
  const createResponse = page.waitForResponse((response) =>
    response.request().method() === "POST"
      && response.url().includes("/api/trip-shares/"),
  );
  await page.locator("#share-create").click();
  const response = await createResponse;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual({ expires_in_days: 7 });
  const created = await response.json();
  const shareId = Number(created.share.id);
  expect(shareId).toBeGreaterThan(0);

  await expect(page.locator("#share-result")).toBeVisible();
  const shareUrlInput = page.locator("#share-url");
  await expect(shareUrlInput).not.toHaveValue("");
  const shareUrl = await shareUrlInput.inputValue();
  const parsed = new URL(shareUrl);
  expect(parsed.pathname).toBe("/share");
  expect(parsed.hash.length).toBeGreaterThan(20);
  expect(created.share).toEqual(expect.objectContaining({
    recoverable: true,
    token_version: expect.stringMatching(/^[a-f0-9]{16}$/),
  }));
  const localValues = await page.evaluate(() => Object.values(localStorage).join("\n"));
  expect(localValues).not.toContain(parsed.hash.slice(1));

  await expect(activeRows).toHaveCount(activeBefore + 1);
  await expect(page.locator("#share-list .share-row").first().locator(".share-status"))
    .toHaveText("有效");
  await expect(page.locator("#share-count")).toHaveText(`${activeBefore + 1} 個有效連結`);

  await page.locator("#share-close").click();
  await expect(page.locator("#share-modal")).toBeHidden();
  await expect(shareUrlInput).toHaveValue("");
  const reopenResponse = page.waitForResponse((res) =>
    res.request().method() === "POST"
      && res.url().endsWith(`/api/trip-shares/${shareId}/link`),
  );
  await page.locator("#btn-link").click();
  expect((await reopenResponse).status()).toBe(200);
  await expect(shareUrlInput).toHaveValue(shareUrl);

  // 關閉頁面／重新整理後，原本的有效連結必須能由加密保管層再次取得。
  await page.reload();
  await expect(page.locator("#page-main")).toBeVisible();
  const revealResponse = page.waitForResponse((res) =>
    res.request().method() === "POST"
      && res.url().endsWith(`/api/trip-shares/${shareId}/link`),
  );
  await page.locator("#btn-link").click();
  expect((await revealResponse).status()).toBe(200);
  await expect(page.locator("#share-modal")).toBeVisible();
  await expect(page.locator("#share-result")).toBeVisible();
  await expect(shareUrlInput).toHaveValue(shareUrl);
  await expect(page.locator("#share-list .share-row").first().locator(".share-row-copy")).toHaveCount(1);
  await expect(page.locator("#share-list .share-row").first().locator(".share-rotate")).toHaveCount(0);
  await expectShareModalFits(page);

  const reopenedPage = await page.context().newPage();
  try {
    await reopenedPage.goto(`/trip/${encodeURIComponent(tripId)}`);
    await expect(reopenedPage.locator("#page-main")).toBeVisible();
    await reopenedPage.locator("#btn-link").click();
    await expect(reopenedPage.locator("#share-url")).toHaveValue(shareUrl);
  } finally {
    await reopenedPage.close();
  }
  return { shareUrl, activeBefore, shareId };
}

async function expectPlayable(page: Page, selector: string): Promise<void> {
  await expect.poll(
    () => page.locator(selector).evaluate((video: HTMLVideoElement) => video.readyState),
    { timeout: 20_000 },
  ).toBeGreaterThanOrEqual(1);
  const decoded = await page.locator(selector).evaluate(async (video: HTMLVideoElement) => {
    await video.play();
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    video.pause();
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 36;
    const context = canvas.getContext("2d")!;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let min = 255;
    let max = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const value = (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    return { min, max };
  });
  expect(decoded.max - decoded.min).toBeGreaterThan(80);
}

async function expectViewerGeometry(page: Page): Promise<void> {
  const layout = await page.locator("#stage").evaluate((stage) => {
    const stageBox = stage.getBoundingClientRect();
    const pip = stage.querySelector<HTMLElement>("#pip");
    const controls = stage.querySelector<HTMLElement>("#ctrl");
    if (!pip || !controls) throw new Error("缺少子母畫面或控制列");
    const pipBox = pip.getBoundingClientRect();
    const controlsBox = controls.getBoundingClientRect();
    return {
      stage: { left: stageBox.left, top: stageBox.top, right: stageBox.right, bottom: stageBox.bottom },
      pip: { left: pipBox.left, top: pipBox.top, right: pipBox.right, bottom: pipBox.bottom },
      controlsTop: controlsBox.top,
      mobile: window.innerWidth <= 680,
    };
  });
  expect(layout.pip.left).toBeGreaterThanOrEqual(layout.stage.left);
  expect(layout.pip.top).toBeGreaterThanOrEqual(layout.stage.top);
  expect(layout.pip.right).toBeLessThanOrEqual(layout.stage.right + 1);
  expect(layout.pip.bottom).toBeLessThanOrEqual(layout.stage.bottom + 1);
  if (layout.mobile) expect(layout.pip.bottom).toBeLessThanOrEqual(layout.controlsTop + 1);
  await expectNoHorizontalOverflow(page);
}

async function expectAnonymousPlayback(page: Page, shareUrl: string): Promise<void> {
  const bearer = new URL(shareUrl).hash.slice(1);
  expect(bearer.length).toBeGreaterThan(20);
  const requestUrls: string[] = [];
  page.on("request", (request) => requestUrls.push(request.url()));

  // 尚未以 fragment 兌換 cookie 時，固定媒體端點不可讀。
  const denied = await page.request.get(new URL("/share/video/front", shareUrl).href);
  expect(denied.status()).toBe(404);
  await page.goto(shareUrl);
  await expect(page.locator("#content")).toBeVisible();
  await expect(page.locator(".share-brand-mark")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.locator(".share-brand-mark")).toHaveCSS("border-radius", "0px");
  await expect(page.locator("#title")).toContainText("2026-08-02");
  await expect(page.locator("#device-chip")).toContainText("Polaroid MS279WG");
  await expect(page.locator("#device")).toHaveCount(0);
  await expect(page.locator("#content")).not.toContainText("機車固定式");
  await expect(page.locator("#content")).not.toContainText("非安全帽");
  expect(new URL(page.url()).hash).toBe("");

  const cookies = await page.context().cookies();
  expect(cookies.some((cookie) => cookie.name === "session_token")).toBeFalsy();
  const shareCookie = cookies.find((cookie) => cookie.name === "dashcam_share_access");
  expect(shareCookie).toEqual(expect.objectContaining({
    httpOnly: true,
    sameSite: "Strict",
    path: "/share",
  }));

  const front = page.locator('video[data-camera="front"]');
  const rear = page.locator('video[data-camera="rear"]');
  await expect(front).toHaveCount(1);
  await expect(rear).toHaveCount(1);
  await expect(front).toHaveAttribute("src", "/share/video/front");
  await expect(rear).toHaveAttribute("src", "/share/video/rear");
  await expect(front).not.toHaveAttribute("controls", "");
  await expect(rear).not.toHaveAttribute("controls", "");
  await expect(page.locator('#zoom-layer > video[data-camera="front"]')).toHaveCount(1);
  await expect(page.locator('#pip > video[data-camera="rear"]')).toHaveCount(1);
  await expect(page.locator("#cam-tag")).toHaveText("前鏡頭");
  await expect(page.locator("#pip-tag")).toHaveText("後鏡頭");
  await expectPlayable(page, 'video[data-camera="front"]');
  await expectPlayable(page, 'video[data-camera="rear"]');
  await expectSinglePlaybackIcon(page);
  await expectPreciseSeek(page);
  await expectEssentialContentInViewport(page, true);

  // 自訂控制列同步操作兩支常駐影片。
  await page.locator("#btn-play").click();
  await expect(page.locator("#btn-play [data-playback-icon] path")).toHaveAttribute("d", pausePath);
  await expect(page.locator("#btn-play")).toHaveAttribute("aria-label", "暫停");
  await expect.poll(() => front.evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  await expect.poll(() => rear.evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  await page.waitForTimeout(400);
  const playingTimes = await page.locator("#stage video").evaluateAll((items: HTMLVideoElement[]) =>
    items.map(video => video.currentTime));
  expect(Math.abs(playingTimes[0]! - playingTimes[1]!)).toBeLessThanOrEqual(0.25);
  await page.locator("#btn-play").click();
  await expect(page.locator("#btn-play [data-playback-icon] path")).toHaveAttribute("d", playPath);
  await expect(page.locator("#btn-play")).toHaveAttribute("aria-label", "播放");

  await page.locator("#seek").evaluate((input: HTMLInputElement) => {
    input.value = "50";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect.poll(() => page.locator("#stage video").evaluateAll((items: HTMLVideoElement[]) =>
    Math.abs(items[0]!.currentTime - items[1]!.currentTime))).toBeLessThanOrEqual(0.08);

  await page.locator("#btn-speed").click();
  await expect(page.locator("#btn-speed")).toHaveText("1.5×");
  expect(await page.locator("#stage video").evaluateAll((items: HTMLVideoElement[]) =>
    items.every(video => video.playbackRate === 1.5))).toBe(true);

  const beforeFrame = await front.evaluate((video: HTMLVideoElement) => video.currentTime);
  await page.locator("#btn-fwd").click();
  await expect.poll(() => front.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeGreaterThan(beforeFrame);

  const beforeSwap = await rear.evaluate((video: HTMLVideoElement) => video.currentTime);
  await page.locator("#pip").click();
  await expect(page.locator('#zoom-layer > video[data-camera="rear"]')).toHaveCount(1);
  await expect(page.locator('#pip > video[data-camera="front"]')).toHaveCount(1);
  await expect(page.locator("#cam-tag")).toHaveText("後鏡頭");
  await expect(page.locator("#pip-tag")).toHaveText("前鏡頭");
  expect(await rear.evaluate((video: HTMLVideoElement) => video.muted)).toBe(false);
  expect(await front.evaluate((video: HTMLVideoElement) => video.muted)).toBe(true);
  expect(Math.abs((await rear.evaluate((video: HTMLVideoElement) => video.currentTime)) - beforeSwap))
    .toBeLessThanOrEqual(0.15);

  await page.locator("#stage").dispatchEvent("wheel", { deltaY: -100, clientX: 160, clientY: 120 });
  await expect(page.locator("#zoom-tag")).toHaveClass(/show/);
  await expect(page.locator("#zoom-layer")).not.toHaveCSS("transform", "none");
  await page.locator("#stage").dispatchEvent("dblclick", { clientX: 160, clientY: 120 });
  await expect(page.locator("#zoom-tag")).not.toHaveClass(/show/);

  if ((page.viewportSize()?.width ?? 0) > 680) {
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#btn-snap").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.png$/);
    await page.locator("#stage").evaluate((element) => {
      Object.defineProperty(element, "requestFullscreen", {
        configurable: true,
        value() {
          element.setAttribute("data-fullscreen-requested", "true");
          return Promise.resolve();
        },
      });
    });
    await page.locator("#btn-full").click();
    await expect(page.locator("#stage")).toHaveAttribute("data-fullscreen-requested", "true");
  }

  await expectViewerGeometry(page);

  const browse = await page.request.get(new URL("/api/trips", shareUrl).href);
  expect(browse.status()).toBe(401);
  expect(requestUrls.length).toBeGreaterThan(0);
  for (const requestUrl of requestUrls) {
    expect(requestUrl, "bearer token 不得出現在任何瀏覽器 HTTP request URL").not.toContain(bearer);
  }
  await expect(page.locator("#share-toast")).toBeHidden({ timeout: 4_000 });
  await expectNoHorizontalOverflow(page);
}

async function revokeShare(page: Page, activeBefore: number, shareId?: number): Promise<void> {
  const latest = page.locator("#share-list .share-row").first();
  await expect(latest.locator(".share-status")).toHaveText("有效");
  page.once("dialog", (dialog) => dialog.accept());
  await latest.locator(".share-revoke").click();
  await expect(latest.locator(".share-status")).toHaveText("已失效");
  await expect(latest.locator(".share-revoke")).toHaveCount(0);
  await expect(page.locator("#share-list .share-row .share-status:not(.off)"))
    .toHaveCount(activeBefore);
  await expect(page.locator("#share-count")).toHaveText(`${activeBefore} 個有效連結`);
}

async function expectRevokedLink(page: Page, shareUrl: string): Promise<void> {
  // 即使已停在 /share，同一路徑只變更 fragment 也必須重新驗證並清空舊播放器。
  await page.goto(shareUrl);
  await expect(page.locator("#state")).toContainText("這個分享連結已失效");
  await expect(page.locator("#content")).toBeHidden();
  await expect(page.locator("#stage video")).toHaveCount(0);
  const front = await page.request.get(new URL("/share/video/front", shareUrl).href);
  const rear = await page.request.get(new URL("/share/video/rear", shareUrl).href);
  expect(front.status()).toBe(404);
  expect(rear.status()).toBe(404);
  await expectNoHorizontalOverflow(page);
}

async function newAnonymousContext(
  browser: Browser,
  options: {
    viewport: { width: number; height: number };
    isMobile?: boolean;
    hasTouch?: boolean;
    colorScheme?: "light" | "dark";
  },
): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  expect(await context.cookies()).toEqual([]);
  return context;
}

test("桌機：由旅程建立 7 天快速分享、匿名播放並撤銷", async ({ page, browser }, testInfo) => {
  const ownerErrors = watchErrors(page);
  const { shareUrl, activeBefore, shareId } = await createShareFromTrip(page);
  await page.screenshot({ path: testInfo.outputPath("share-modal-desktop.png"), fullPage: true });

  const anonymous = await newAnonymousContext(browser, {
    viewport: { width: 1280, height: 720 },
    colorScheme: "dark",
  });
  try {
    const anonymousPage = await anonymous.newPage();
    const anonymousErrors = watchErrors(anonymousPage);
    await expectAnonymousPlayback(anonymousPage, shareUrl);
    await anonymousPage.screenshot({ path: testInfo.outputPath("share-desktop-viewport.png") });
    await anonymousPage.screenshot({ path: testInfo.outputPath("share-desktop.png"), fullPage: true });
    expect(anonymousErrors).toEqual([]);

    await revokeShare(page, activeBefore, shareId);
    await expectRevokedLink(anonymousPage, shareUrl);
    expect(anonymousErrors.every((error) => error.includes("404 (Not Found)"))).toBeTruthy();
  } finally {
    await anonymous.close();
  }
  expect(ownerErrors).toEqual([]);
});

test("舊有分享未保存在此瀏覽器時可原地重新產生", async ({ page, browser }) => {
  await authenticate(page);
  const before = await page.request.get(`/api/trip-shares/${encodeURIComponent(tripId)}`);
  expect(before.status()).toBe(200);
  const activeBefore = (await before.json()).shares.filter((share: { active: boolean }) => share.active).length;

  const createdResponse = await page.request.post("/__test/legacy-share");
  expect(createdResponse.status()).toBe(201);
  const created = await createdResponse.json();
  const shareId = Number(created.share.id);
  const oldUrl = new URL(created.share_url, baseURL).href;

  await page.goto(`/trip/${encodeURIComponent(tripId)}`);
  await expect(page.locator("#page-main")).toBeVisible();
  await page.locator("#btn-link").click();
  const row = page.locator(`.share-row[data-share-id="${shareId}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator("[data-share-copy]")).toHaveCount(0);
  await expect(row.locator("[data-share-rotate]")).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  const rotatedResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
      && response.url().endsWith(`/api/trip-shares/${shareId}/rotate`),
  );
  await row.locator("[data-share-rotate]").click();
  const rotatedResponse = await rotatedResponsePromise;
  expect(rotatedResponse.status()).toBe(200);
  const rotated = await rotatedResponse.json();
  expect(Number(rotated.share.id)).toBe(shareId);
  const newUrl = new URL(rotated.share_url, baseURL).href;
  expect(newUrl).not.toBe(oldUrl);
  await expect(page.locator("#share-url")).toHaveValue(newUrl);
  await expect(page.locator(`.share-row[data-share-id="${shareId}"] [data-share-copy]`)).toBeVisible();
  expect(rotatedResponse.request().postDataJSON()).toEqual({
    token_version: created.share.token_version,
  });

  await page.reload();
  await expect(page.locator("#page-main")).toBeVisible();
  await page.locator("#btn-link").click();
  await expect(page.locator("#share-url")).toHaveValue(newUrl);
  await expectShareModalFits(page);

  const anonymous = await newAnonymousContext(browser, { viewport: { width: 1280, height: 720 } });
  try {
    const guest = await anonymous.newPage();
    await expectRevokedLink(guest, oldUrl);
    await expectAnonymousPlayback(guest, newUrl);
  } finally {
    await anonymous.close();
  }

  await revokeShare(page, activeBefore, shareId);
});

test("分享頁在常見桌機與直式手機尺寸保留必要內容於首屏", async ({ page, browser }, testInfo) => {
  const { shareUrl, activeBefore, shareId } = await createShareFromTrip(page);
  const viewports = [
    { name: "desktop-1024x768", viewport: { width: 1024, height: 768 } },
    { name: "desktop-1366x768", viewport: { width: 1366, height: 768 } },
    { name: "desktop-1440x900", viewport: { width: 1440, height: 900 } },
    { name: "desktop-1920x1080", viewport: { width: 1920, height: 1080 } },
    { name: "mobile-360x800", viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true },
    { name: "mobile-375x667", viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true },
  ];

  for (const item of viewports) {
    const context = await newAnonymousContext(browser, { ...item, colorScheme: "dark" });
    try {
      const guest = await context.newPage();
      await guest.goto(shareUrl);
      await expect(guest.locator("#content")).toBeVisible();
      await guest.evaluate(() => document.fonts?.ready);
      await guest.waitForTimeout(100);
      await expectEssentialContentInViewport(guest, true);
      if (item.name === "desktop-1366x768" || item.name === "mobile-375x667") {
        await guest.screenshot({ path: testInfo.outputPath(`${item.name}.png`) });
      }
    } finally {
      await context.close();
    }
  }
  await revokeShare(page, activeBefore, shareId);
});

test.describe("手機版", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("旅程快速分享、匿名前後鏡頭與撤銷流程無溢位", async ({ page, browser }, testInfo) => {
    const ownerErrors = watchErrors(page);
    const { shareUrl, activeBefore, shareId } = await createShareFromTrip(page);
    await page.screenshot({ path: testInfo.outputPath("share-modal-mobile.png"), fullPage: true });

    const anonymous = await newAnonymousContext(browser, {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      colorScheme: "dark",
    });
    try {
      const anonymousPage = await anonymous.newPage();
      const anonymousErrors = watchErrors(anonymousPage);
      await expectAnonymousPlayback(anonymousPage, shareUrl);
      await anonymousPage.screenshot({ path: testInfo.outputPath("share-mobile.png"), fullPage: true });
      expect(anonymousErrors).toEqual([]);

      await revokeShare(page, activeBefore, shareId);
      await expectRevokedLink(anonymousPage, shareUrl);
      expect(anonymousErrors.every((error) => error.includes("404 (Not Found)"))).toBeTruthy();
    } finally {
      await anonymous.close();
    }
    expect(ownerErrors).toEqual([]);
  });
});
