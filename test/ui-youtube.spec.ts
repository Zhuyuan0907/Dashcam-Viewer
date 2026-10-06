import { expect, test, type Page } from "@playwright/test";
const tripId = "v2|u:1|d:2|MS279WG-ui-test";
const baseURL = process.env.DASHCAM_E2E_BASE_URL ?? "http://127.0.0.1:8181";
const token = process.env.DASHCAM_E2E_SESSION_TOKEN ?? "ui-device-test-session";
async function setup(page: Page) {
  await page
    .context()
    .addCookies([
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
test("fixed desktop and mobile panels, metadata preview, OAuth setup and navigation", async ({
  page,
}) => {
  await setup(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/youtube");
    await expect(page.locator("#yt-trips .yt-row")).toHaveCount(2);
    await noOverflow(page);
    await page.locator(`[data-trip="${tripId}"]`).check();
    await page.locator("#yt-next").click();
    await expect(page.locator("#yt-settings-metadata")).toBeVisible();
    await expect(page.locator("#yt-title")).toHaveValue(/\{date\}/);
    await page.locator("#yt-title").fill("測試 {date} {time} {camera}");
    await page.locator("#yt-settings-next").click();
    await expect(page.locator("#yt-camera")).toHaveValue("both");
    await noOverflow(page);
    await page.locator("#yt-settings-next").click();
    await page.locator("#yt-preview").click();
    await expect(page.locator("#yt-preview-result")).toContainText("測試 2026-08-02");
    await expect(page.locator("#yt-preview-result")).toContainText("前鏡頭");
    await noOverflow(page);
    await page.locator('[data-tab="queue"]').click();
    await expect(page.locator("#yt-uploads")).toContainText("尚未有上傳工作");
    await noOverflow(page);
    await page.locator('[data-tab="archive"]').click();
    await expect(page.locator("#yt-archives")).toContainText("尚未有已傳送");
    await noOverflow(page);
    await page.locator('[data-tab="account"]').click();
    await expect(page.locator("#yt-connect")).toBeDisabled();
    await noOverflow(page);
    await page.locator("#yt-setup-tab").click();
    await expect(page.locator("#yt-redirect")).toHaveValue(`${baseURL}/api/youtube/callback`);
    await noOverflow(page);
  }
  expect(errors).toEqual([]);
});
test("cross-page selections persist and a confirmed paired batch includes templates and schedule", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1366, height: 768 });
  const trips = Array.from({ length: 100 }, (_, index) => ({
    trip_id: `trip-${index}`,
    date: "2026-10-06",
    day_order: index + 1,
    start_epoch: 1785714400,
    end_epoch: 1785714406,
    duration_sec: 6,
    has_front: 1,
    has_rear: 1,
  }));
  await page.route("**/api/trips?*", (route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    return route.fulfill({
      json: { trips: trips.slice(offset, offset + limit), total: trips.length },
    });
  });
  await page.route("**/api/youtube/account", async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({ json: { status: "saved" } });
      return;
    }
    await route.fulfill({
      json: {
        configured: true,
        defaults: {
          title_template: "行車記錄 {date} {camera}",
          description_template: "旅程 {trip_id}",
        },
        parameters: ["date", "camera", "trip_id"],
        account: {
          channel_title: "UI 頻道",
          channel_id: "ui-channel",
          paused: false,
          daily_limit: 10,
          used: 0,
        },
      },
    });
  });
  await page.route("**/api/youtube/preview", (route) =>
    route.fulfill({ json: { title: "行車記錄 2026-10-06 前鏡頭", description: "旅程 trip-0" } }),
  );
  let submitted: any;
  await page.route("**/api/youtube/uploads", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ json: { added: 4, skipped: 0 } });
  });
  await page.goto("/youtube");
  await expect(page.locator("#yt-trips .yt-row")).toHaveCount(6);
  await page.locator('[data-trip="trip-0"]').check();
  await page.locator("#yt-trip-pager").getByRole("button", { name: "下一頁" }).click();
  await page.locator('[data-trip="trip-6"]').check();
  await expect(page.locator("#yt-selection-count")).toHaveText("2");
  await page.locator("#yt-trip-pager").getByRole("button", { name: "上一頁" }).click();
  await expect(page.locator('[data-trip="trip-0"]')).toBeChecked();
  await noOverflow(page);
  await page.locator("#yt-next").click();
  await page.locator("#yt-settings-next").click();
  await page.locator("#yt-start").fill("2026-12-01T09:00");
  await page.locator("#yt-settings-next").click();
  await page.locator("#yt-submit").click();
  await expect(page.locator("#yt-notice")).toContainText("請先勾選上傳確認");
  await page.locator("#yt-confirm-upload").check();
  await page.locator("#yt-submit").click();
  await expect(page.locator("#yt-queue")).toBeVisible();
  expect(submitted.trip_ids).toEqual(["trip-0", "trip-6"]);
  expect(submitted.camera).toBe("both");
  expect(submitted.privacy).toBe("private");
  expect(submitted.made_for_kids).toBe(false);
  expect(submitted.title_template).toContain("{date}");
  expect(submitted.not_before).toBeGreaterThan(Date.now());
  await noOverflow(page);
});
test("processing history is paginated and mobile can return from detail to queue", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const upload = {
    id: 42,
    trip_id: tripId,
    title: "測試前鏡頭",
    description: "",
    camera: "front",
    date: "2026-08-02",
    trip_no: 1,
    status: "uploading",
    progress: 50,
    uploaded_bytes: 1000,
    source_size: 2000,
    message: "YouTube 已接收",
    not_before: 0,
    deleted_at: null,
    video_url: null,
    studio_url: null,
  };
  await page.route("**/api/youtube/uploads?*", (route) =>
    route.fulfill({
      json: { uploads: [upload], total: 1, counts: [{ status: "uploading", n: 1 }] },
    }),
  );
  await page.route("**/api/youtube/uploads/42?*", (route) =>
    route.fulfill({
      json: {
        upload,
        events: Array.from({ length: 8 }, (_, i) => ({
          id: i,
          created_at: Date.now(),
          message: `傳輸步驟 ${i}`,
          stage: "transfer",
          bytes: 1000,
        })),
        total: 24,
        limit: 8,
      },
    }),
  );
  await page.goto("/youtube");
  await page.locator('[data-tab="queue"]').click();
  await page.locator('[data-job="42"]').click();
  await expect(page.locator("#yt-job-detail")).toHaveClass(/has-job/);
  await expect(page.locator("#yt-log-pager")).toContainText("1 / 3");
  await noOverflow(page);
  await page.locator("#yt-log-pager").getByRole("button", { name: "下一頁" }).click();
  await expect(page.locator("#yt-log-pager")).toContainText("2 / 3");
  await page.locator("#yt-detail-back").click();
  await expect(page.locator("#yt-uploads")).toBeVisible();
  await noOverflow(page);
});
