import { expect, test } from "@playwright/test";

const tripId = "v2|u:1|d:2|MS279WG-ui-test";

test("fractional trip durations render as whole seconds", async ({ page, context }) => {
  await context.addCookies([
    { name: "session_token", value: "ui-device-test-session", domain: "127.0.0.1", path: "/" },
  ]);
  await page.goto("/trip/" + encodeURIComponent(tripId));
  expect(await page.evaluate(() => (window as any).fmtDuration(639.48993229999999))).toBe(
    "10m 39s",
  );
});

test("long playback timecodes keep the hour field visible before one hour", async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: "session_token", value: "ui-device-test-session", domain: "127.0.0.1", path: "/" },
  ]);
  await page.goto("/trip/" + encodeURIComponent(tripId));
  const timecodes = await page.evaluate(() => {
    const format = (window as any).fmtSecs;
    return [format(3599), format(3600), format(3723), format(59, 3600)];
  });
  expect(timecodes).toEqual(["59:59", "1:00:00", "1:02:03", "0:00:59"]);
});

test("both cameras resume from the short paused preload Chromium provides", async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: "session_token", value: "ui-device-test-session", domain: "127.0.0.1", path: "/" },
  ]);
  await page.goto("/trip/" + encodeURIComponent(tripId));
  await expect
    .poll(() =>
      page
        .locator("#stage video")
        .evaluateAll((videos: HTMLVideoElement[]) =>
          videos.every((video) => video.readyState >= 3),
        ),
    )
    .toBe(true);
  await page.locator("#stage video").evaluateAll((videos: HTMLVideoElement[]) => {
    for (const video of videos) {
      // Real long MP4s can stop preloading at about 2.27 s while paused.
      Object.defineProperty(video, "buffered", {
        configurable: true,
        get: () => ({ length: 1, start: () => 0, end: () => 2.266667 }),
      });
    }
  });
  await page.locator("#btn-play").click();
  await expect
    .poll(() =>
      page
        .locator("#stage video")
        .evaluateAll((videos: HTMLVideoElement[]) => videos.every((video) => !video.paused)),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page
        .locator("#stage video")
        .evaluateAll((videos: HTMLVideoElement[]) =>
          videos.every((video) => video.currentTime > 0.2),
        ),
    )
    .toBe(true);
});

test("a brief network wait does not flash a message over synchronized playback", async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: "session_token", value: "ui-device-test-session", domain: "127.0.0.1", path: "/" },
  ]);
  await page.goto("/trip/" + encodeURIComponent(tripId));
  await page.locator("#btn-play").click();
  await expect
    .poll(() =>
      page
        .locator("#stage video")
        .evaluateAll((videos: HTMLVideoElement[]) => videos.every((v) => !v.paused)),
    )
    .toBe(true);
  await page.locator("#pip video").evaluate((video: HTMLVideoElement) => {
    Object.defineProperty(video, "readyState", { configurable: true, get: () => 2 });
    video.dispatchEvent(new Event("waiting"));
  });
  await expect
    .poll(() =>
      page
        .locator("#stage video")
        .evaluateAll((videos: HTMLVideoElement[]) => videos.every((v) => v.paused)),
    )
    .toBe(true);
  await page.waitForTimeout(100);
  await page.locator("#pip video").evaluate((video: HTMLVideoElement) => {
    delete (video as any).readyState;
    video.dispatchEvent(new Event("canplay"));
  });
  await expect
    .poll(() =>
      page
        .locator("#stage video")
        .evaluateAll((videos: HTMLVideoElement[]) => videos.every((v) => !v.paused)),
    )
    .toBe(true);
  await page.waitForTimeout(350);
  await expect(page.locator(".playback-status")).toBeHidden();
});

test("rapid paused seeks keep both cameras on the newest requested position", async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: "session_token", value: "ui-device-test-session", domain: "127.0.0.1", path: "/" },
  ]);
  await page.goto("/trip/" + encodeURIComponent(tripId));
  await expect
    .poll(() =>
      page
        .locator("#stage video")
        .evaluateAll((videos: HTMLVideoElement[]) => videos.every((v) => v.readyState >= 2)),
    )
    .toBe(true);
  await page.locator("#seek").evaluate((input: HTMLInputElement) => {
    for (const value of [10, 25, 50, 75, 90]) {
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await expect
    .poll(() =>
      page
        .locator("#stage video")
        .evaluateAll((videos: HTMLVideoElement[]) =>
          videos.every((v) => !v.seeking && Math.abs(v.currentTime / v.duration - 0.9) < 0.03),
        ),
    )
    .toBe(true);
  expect(
    await page
      .locator("#stage video")
      .evaluateAll((videos: HTMLVideoElement[]) => videos.every((v) => v.paused)),
  ).toBe(true);
});

for (const shared of [false, true]) {
  test(`${shared ? "share" : "trip"} waits for delayed rear video and resumes both cameras`, async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { name: "session_token", value: "ui-device-test-session", domain: "127.0.0.1", path: "/" },
    ]);
    let url = "/trip/" + encodeURIComponent(tripId);
    if (shared) {
      const response = await context.request.post(
        "/api/trip-shares/" + encodeURIComponent(tripId),
        { data: { expires_in_days: 1 } },
      );
      expect(response.status()).toBe(201);
      url = (await response.json()).share_url;
      await context.clearCookies();
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delayed = false;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(shared ? "**/share/video/rear" : "**/video/**/rear", async (route) => {
      delayed = true;
      await gate;
      await route.continue();
    });
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await expect(page.locator("#btn-play")).toBeVisible();
      await page.locator("#btn-play").click();
      await expect.poll(() => delayed).toBe(true);
      await expect(page.locator(".playback-status")).toContainText("後鏡頭");
      await expect(page.locator("#btn-play")).toHaveAttribute("aria-label", "暫停");
      await expect
        .poll(() =>
          page
            .locator("#stage video")
            .evaluateAll((videos: HTMLVideoElement[]) => videos.every((v) => v.paused)),
        )
        .toBe(true);
      const frozen = await page
        .locator("#zoom-layer video")
        .evaluate((v: HTMLVideoElement) => v.currentTime);
      await page.waitForTimeout(450);
      expect(
        await page.locator("#zoom-layer video").evaluate((v: HTMLVideoElement) => v.currentTime),
      ).toBeCloseTo(frozen, 2);
      release();
      await expect(page.locator(".playback-status")).toBeHidden();
      await expect
        .poll(() =>
          page
            .locator("#stage video")
            .evaluateAll((videos: HTMLVideoElement[]) => videos.every((v) => !v.paused)),
        )
        .toBe(true);
      const times = await page
        .locator("#stage video")
        .evaluateAll((videos: HTMLVideoElement[]) => videos.map((v) => v.currentTime));
      expect(Math.abs(times[0]! - times[1]!)).toBeLessThanOrEqual(0.25);
      await page.waitForTimeout(350);
      const later = await page
        .locator("#stage video")
        .evaluateAll((videos: HTMLVideoElement[]) => videos.map((v) => v.currentTime));
      expect(later[0]).toBeGreaterThan(times[0]!);
      expect(later[1]).toBeGreaterThan(times[1]!);
      expect(Math.abs(later[0]! - later[1]!)).toBeLessThanOrEqual(0.25);
      await page.locator("#btn-play").click();
      expect(errors).toEqual([]);
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}

test("manual pause during a delayed rear response survives buffer recovery", async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: "session_token", value: "ui-device-test-session", domain: "127.0.0.1", path: "/" },
  ]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/video/**/rear", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/trip/" + encodeURIComponent(tripId), { waitUntil: "domcontentloaded" });
    await page.locator("#btn-play").click();
    await expect(page.locator(".playback-status")).toBeVisible();
    await page.locator("#btn-play").click();
    await expect(page.locator("#btn-play")).toHaveAttribute("aria-label", "播放");
    release();
    await expect
      .poll(() => page.locator("#pip video").evaluate((v: HTMLVideoElement) => v.readyState))
      .toBeGreaterThanOrEqual(3);
    await page.waitForTimeout(450);
    expect(
      await page
        .locator("#stage video")
        .evaluateAll((videos: HTMLVideoElement[]) => videos.every((v) => v.paused)),
    ).toBe(true);
    await expect(page.locator(".playback-status")).toBeHidden();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("editor preview uses the buffering barrier and stops without accidental resume", async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: "session_token", value: "ui-device-test-session", domain: "127.0.0.1", path: "/" },
  ]);
  await page.goto("/trip/" + encodeURIComponent(tripId));
  await page.locator("#edit-btn").click();
  await page.locator("#clip-preview").click();
  await expect
    .poll(() =>
      page
        .locator("#stage video")
        .evaluateAll((videos: HTMLVideoElement[]) => videos.every((v) => !v.paused)),
    )
    .toBe(true);
  // Deterministically inject a mid-play buffer underrun; the other tests delay real media requests.
  await page.locator("#pip video").evaluate((v: HTMLVideoElement) => {
    Object.defineProperty(v, "readyState", { configurable: true, get: () => 2 });
    v.dispatchEvent(new Event("waiting"));
  });
  await expect(page.locator(".playback-status")).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator("#stage video")
        .evaluateAll((videos: HTMLVideoElement[]) => videos.every((v) => v.paused)),
    )
    .toBe(true);
  await page.locator("#clip-preview").click();
  await page.locator("#pip video").evaluate((v: HTMLVideoElement) => {
    delete (v as any).readyState;
    v.dispatchEvent(new Event("canplay"));
  });
  await expect(page.locator(".playback-status")).toBeHidden();
  expect(
    await page
      .locator("#stage video")
      .evaluateAll((videos: HTMLVideoElement[]) => videos.every((v) => v.paused)),
  ).toBe(true);
});

test("trip page stays on one screen, note cancel works, and the dock offers speed and clock modes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/trip/${encodeURIComponent(tripId)}`);
  await expect(page.locator("#page-main")).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
  // 備註:取消要真的關閉編輯框
  await page.locator(".note-open").click();
  await expect(page.locator("#note-textarea")).toBeVisible();
  await page.locator("#note-textarea").fill("暫存文字");
  await page.locator("#note-cancel").click();
  await expect(page.locator("#note-textarea")).toHaveCount(0);
  await page.locator(".note-open").click();
  await page.locator("#note-textarea").press("Escape");
  await expect(page.locator("#note-textarea")).toHaveCount(0);
  // 速度選單
  await page.locator("#stage").hover();
  await page.locator("#btn-speed").click();
  await page.locator('#speed-menu button[data-rate="2"]').click();
  await expect(page.locator("#btn-speed")).toHaveText("2×");
  await expect(page.locator("#speed-menu")).toBeHidden();
  // 時間:預設顯示實際時間,點一下切成影片時間
  await expect(page.locator("#t-wall")).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await page.locator("#dock-clock").click();
  await expect(page.locator("#dock-clock")).toHaveClass(/elapsed-first/);
});
