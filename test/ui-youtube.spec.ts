import { expect, test, type Page } from "@playwright/test";
const baseURL = process.env.DASHCAM_E2E_BASE_URL ?? "http://127.0.0.1:8181";
const token = process.env.DASHCAM_E2E_SESSION_TOKEN ?? "ui-device-test-session";
const shots = process.env.DASHCAM_E2E_SHOTS;
async function setup(page: Page) {
  await page.context().addCookies([
    {
      name: "session_token",
      value: token,
      domain: new URL(baseURL).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight - innerHeight),
  ).toBeLessThanOrEqual(1);
}
async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}
const connected = {
  configured: true,
  defaults: { title_template: "行車記錄 {date} {camera}", description_template: "旅程 {trip_id}" },
  parameters: ["date", "camera", "trip_id"],
  account: { channel_title: "UI 頻道", channel_id: "ui-channel", paused: false, daily_limit: 10, used: 0 },
};

test("unconfigured site guides the owner to the OAuth setup steps in ops", async ({ page }) => {
  await setup(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/youtube");
    await expect(page.locator("#yt-need-setup")).toBeVisible();
    await expect(page.locator("#yt-next")).toBeDisabled();
    await expect(page.locator("#yt-foot-status")).toContainText("連結頻道後才能繼續");
    await noOverflow(page);
    await shot(page, `wizard-setup-${viewport.width}`);
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.locator("#yt-go-setup").click();
  await expect(page).toHaveURL(/\/ops#youtube$/);
  await expect(page.locator("#ytm-setup")).toBeVisible();
  await expect(page.locator("#ytm-redirect-copy")).toHaveText(`${baseURL}/api/youtube/callback`);
  await expect(page.locator("#ytm-redirect")).toHaveValue(`${baseURL}/api/youtube/callback`);
  await noOverflow(page);
  await shot(page, "ops-youtube-setup");
  expect(errors).toEqual([]);
});

test("connected account walks through the five steps and submits a paired batch", async ({ page }) => {
  await setup(page);
  const trips = Array.from({ length: 30 }, (_, index) => ({
    trip_id: `trip-${index}`,
    date: "2026-10-06",
    day_order: index + 1,
    start_epoch: 1785714400,
    end_epoch: 1785714406,
    duration_sec: 6,
    has_front: 1,
    has_rear: 1,
    device: { model: "Polaroid MS279WG" },
  }));
  await page.route("**/api/trips?*", (route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    return route.fulfill({ json: { trips: trips.slice(offset, offset + limit), total: trips.length } });
  });
  await page.route("**/api/youtube/trip-status?*", (route) =>
    route.fulfill({ json: { trips: { "trip-1": { front: "succeeded", rear: "uploading" } } } }),
  );
  await page.route("**/api/youtube/account", (route) => route.fulfill({ json: connected }));
  await page.route("**/api/youtube/preview", (route) =>
    route.fulfill({ json: { title: "行車記錄 2026-10-06 前鏡頭", description: "旅程 trip-0" } }),
  );
  let submitted: any;
  await page.route("**/api/youtube/uploads", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ json: { added: 4, skipped: 0 } });
  });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1024, height: 768 },
    { width: 1366, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/youtube");
    await expect(page.locator("#yt-step-1")).toBeVisible();
    await expect(page.locator('#yt-steps li[data-step="0"]')).toHaveClass(/is-done/);
    await expect(page.locator("#yt-trips")).toContainText("前・已上傳");
    await expect(page.locator('[data-trip="trip-1"]')).toBeDisabled();
    await expect(page.locator(".yt-trip.is-done")).toHaveCount(1);
    await noOverflow(page);
    await shot(page, `wizard-select-${viewport.width}`);
  }
  await expect(page.locator("#yt-next")).toBeDisabled();
  await page.locator("#yt-select-page").click();
  await expect(page.locator('[data-trip="trip-1"]')).not.toBeChecked();
  await expect(page.locator('[data-trip="trip-2"]')).toBeChecked();
  await page.locator("#yt-clear-selection").click();
  await expect(page.locator("#yt-foot-status")).toHaveText("尚未選擇旅程");
  await expect(page.locator('[data-trip="trip-2"]')).not.toBeChecked();
  await page.locator('[data-trip="trip-0"]').check();
  await expect(page.locator("#yt-foot-status")).toContainText("已選 1 趟");
  await page.locator("#yt-trip-pager").getByRole("button", { name: "下一頁" }).click();
  await expect(page.locator("#yt-trip-pager")).toContainText("第 2 /");
  await page.locator(`[data-trip="trip-8"]`).check();
  await page.locator("#yt-trip-pager").getByRole("button", { name: "上一頁" }).click();
  await expect(page.locator('[data-trip="trip-0"]')).toBeChecked();
  await expect(page.locator("#yt-foot-status")).toContainText("已選 2 趟 · 4 部影片");
  await page.locator("#yt-next").click();
  await expect(page.locator("#yt-step-2")).toBeVisible();
  await expect(page.locator("#yt-preview-result")).toContainText("行車記錄 2026-10-06 前鏡頭");
  await page.locator("#yt-title").focus();
  await page.locator(".yt-param", { hasText: "鏡頭" }).click();
  await expect(page.locator("#yt-title")).toHaveValue(/\{camera\}$/);
  await noOverflow(page);
  await shot(page, "wizard-metadata");
  await page.locator("#yt-next").click();
  await expect(page.locator('input[name="yt-camera"][value="both"]')).toBeChecked();
  await page.locator("details.yt-advanced summary").click();
  await page.locator("#yt-start").fill("2026-12-01T09:00");
  await noOverflow(page);
  await shot(page, "wizard-mode");
  await page.locator("#yt-next").click();
  await expect(page.locator("#yt-summary")).toContainText("2 趟");
  await expect(page.locator("#yt-summary")).toContainText("4 部");
  await expect(page.locator("#yt-next")).toBeDisabled();
  await page.locator("#yt-confirm-upload").check();
  await noOverflow(page);
  await shot(page, "wizard-confirm");
  await page.locator("#yt-next").click();
  await expect(page.locator("#yt-step-done")).toBeVisible();
  await expect(page.locator("#yt-done-text")).toContainText("已加入 4 部影片");
  expect(submitted.trip_ids).toEqual(["trip-0", "trip-8"]);
  expect(submitted.camera).toBe("both");
  expect(submitted.pair).toBe(true);
  expect(submitted.privacy).toBe("private");
  expect(submitted.made_for_kids).toBe(false);
  expect(submitted.title_template).toContain("{camera}");
  expect(submitted.not_before).toBeGreaterThan(Date.now());
  await noOverflow(page);
  await shot(page, "wizard-done");
});

test("ops YouTube pane shows queue detail and archive with playlist links", async ({ page }) => {
  await setup(page);
  const upload = {
    id: 42,
    trip_id: "trip-x",
    title: "測試前鏡頭",
    camera: "front",
    status: "succeeded",
    progress: 100,
    uploaded_bytes: 2000,
    source_size: 2000,
    message: "YouTube 已完成處理",
    not_before: 0,
    deleted_at: null,
    video_url: "https://www.youtube.com/watch?v=abc",
    studio_url: "https://studio.youtube.com/video/abc/edit",
    playlist_url: "https://www.youtube.com/playlist?list=PL1",
    pair_status: "done",
    can_restart: false,
    youtube: { title: "Studio 改過的標題", privacy: "unlisted", views: 1234, likes: 5, comments: 2, missing: false, synced_at: Date.now() },
  };
  const deletedUpload = {
    ...upload,
    id: 43,
    camera: "rear",
    title: "測試後鏡頭",
    status: "failed",
    youtube: { missing: true, synced_at: Date.now() },
  };
  let syncCalls = 0;
  await page.route("**/api/youtube/sync", (route) => {
    syncCalls++;
    return route.fulfill({ json: { synced: 1, missing: 1, synced_at: Date.now() } });
  });
  await page.route("**/api/youtube/account", (route) => route.fulfill({ json: connected }));
  await page.route("**/api/youtube/uploads?*", (route) =>
    route.fulfill({
      json: route.request().url().includes("filter=archive")
        ? { uploads: [upload, deletedUpload], total: 2, counts: [{ status: "succeeded", n: 1 }] }
        : { uploads: [upload], total: 1, counts: [{ status: "succeeded", n: 1 }] },
    }),
  );
  await page.route("**/api/youtube/uploads/42?*", (route) =>
    route.fulfill({
      json: { upload, events: [{ id: 1, created_at: Date.now(), message: "完成" }], total: 1, limit: 8 },
    }),
  );
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/ops#youtube");
    await page.locator('[data-ytm="queue"]').click();
    await page.locator('[data-job="42"]').click();
    await expect(page.locator("#ytm-detail")).toContainText("完成");
    await noOverflow(page);
    await shot(page, `ops-youtube-queue-${viewport.width}`);
    await page.locator('[data-ytm="archive"]').click();
    await expect(page.locator("#ytm-archives")).toContainText("已配對播放清單");
    await expect(page.locator("#ytm-archives")).toContainText("1,234 次觀看");
    await expect(page.locator("#ytm-archives")).toContainText("YouTube 標題：Studio 改過的標題");
    await expect(page.locator("#ytm-archives")).toContainText("YouTube 上找不到這部影片");
    await expect(page.locator("#ytm-archives a", { hasText: "在 Studio 編輯" })).toHaveAttribute(
      "href",
      upload.studio_url,
    );
    expect(syncCalls).toBeGreaterThan(0);
    await expect(page.locator("#ytm-archives a", { hasText: "前後鏡頭清單" }).first()).toHaveAttribute(
      "href",
      upload.playlist_url,
    );
    await noOverflow(page);
    await shot(page, `ops-youtube-archive-${viewport.width}`);
  }
});

test("ops storage pane reports disk usage and reclaimable items", async ({ page }) => {
  await setup(page);
  await page.route("**/api/admin/storage/reclaimable", (route) =>
    route.fulfill({
      json: {
        disk: { total: 1000e9, free: 81e9 },
        footage_bytes: 789e9,
        trip_count: 208,
        items: [
          { id: "superseded:1", kind: "superseded", label: "2026-09-11 11.43-14.20 (157分)", detail: "已合併", bytes: 24e9, deletable: true },
          { id: "orphan_dir:2", kind: "orphan_dir", label: "2026-10-05 16.17-16.53 (36分)", detail: "半成品", bytes: 2.6e9, deletable: true },
        ],
      },
    }),
  );
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/ops#storage");
  await expect(page.locator("#storage-summary .st-nums")).toContainText("92%");
  await expect(page.locator("#storage-summary .st-tiles")).toContainText("可直接回收");
  await expect(page.locator("#storage-delete")).toBeDisabled();
  await page.locator('[data-reclaim="superseded:1"]').check();
  await expect(page.locator("#storage-delete")).toBeEnabled();
  await noOverflow(page);
  await shot(page, "ops-storage");
});
