import { expect, test } from "@playwright/test";

const tripId = "v2|u:1|d:2|MS279WG-ui-test";

function clip(id: number) {
  return {
    id,
    trip_id: tripId,
    date: "2026-08-02",
    day_order: 1,
    trip_start_epoch: 1_785_714_400,
    label: "路口片段",
    start_sec: 1.125,
    end_sec: 3.375,
    duration_sec: 2.25,
    layout: "front",
    quality: "precise",
    main_cam: null,
    size_bytes: 1024,
    created_at: 1_785_714_410,
    report: {},
    reported_at: null,
    source_version: null,
  };
}

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    { name: "session_token", value: "ui-device-test-session", domain: "127.0.0.1", path: "/" },
  ]);
});

test("a single clip has a themed search field, no pagination, and opens its source range", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/clips?*", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([clip(42)]),
    }),
  );
  await page.goto("/clips");
  await expect(page.locator(".clip-card")).toHaveCount(1);
  await expect(page.locator("#clips-more")).toBeHidden();
  await expect(page.locator(".clips-search-input")).toHaveAttribute("type", "search");
  const searchBackground = await page
    .locator(".clips-search-input")
    .evaluate((input) => getComputedStyle(input).backgroundColor);
  expect(searchBackground).not.toBe("rgb(255, 255, 255)");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);

  await page.locator(".clip-edit").click();
  await expect(page).toHaveURL(/#edit-clip-42$/);
  await expect(page.locator("#edit-panel")).toBeVisible();
  await expect(page.locator("#sel-start-input")).toHaveValue("1.125");
  await expect(page.locator("#sel-end-input")).toHaveValue("3.375");
  await expect(page.locator("#clip-label")).toHaveValue("路口片段");
});

test("load more appears only when another page exists", async ({ page }) => {
  const clips = Array.from({ length: 51 }, (_, index) => clip(index + 1));
  await page.route("**/api/clips?*", async (route) => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset") || 0);
    const limit = Number(url.searchParams.get("limit") || 51);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(clips.slice(offset, offset + limit)),
    });
  });
  await page.goto("/clips");
  await expect(page.locator(".clip-card")).toHaveCount(50);
  await expect(page.locator("#clips-count")).toContainText("50");
  await expect(page.locator("#clips-more")).toBeVisible();
  await page.locator("#clips-more").click();
  await expect(page.locator(".clip-card")).toHaveCount(51);
  await expect(page.locator("#clips-more")).toBeHidden();
});
