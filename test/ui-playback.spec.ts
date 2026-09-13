import { expect, test } from "@playwright/test";

const tripId = "v2|u:1|d:2|MS279WG-ui-test";

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
