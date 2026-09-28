import { expect, test } from "@playwright/test";

const dates = Array.from({ length: 8 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 7, 2 - index)).toISOString().slice(0, 10);
  return {
    date,
    trip_count: index === 0 ? 2 : 0,
    total_sec: index === 0 ? 12 : 0,
    emer_count: 0,
    max_gforce: 0,
    gforce_events: 0,
  };
});

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: "session_token", value: "ui-device-test-session", domain: "127.0.0.1", path: "/" },
  ]);
  await page.route("**/api/trips/dates?*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dates) }),
  );
});

test("desktop date gallery previews real trips and follows a trackpad gesture", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/browse");
  await expect(page.locator("#date-list .drow")).toHaveCount(8);
  await page.locator(".tm-launch").click();
  await expect(page.locator("#time-machine")).toBeVisible();
  await expect(page.locator("#tm-preview-body .trip-card")).toHaveCount(2);
  await page.locator("#tm-stage").hover();
  await page.mouse.wheel(240, 0);
  await expect(page.locator('.tm-card[aria-current="date"]')).toHaveAttribute("data-index", "1");
  await expect(page.locator("#tm-preview-body .tm-empty")).toBeVisible();
  await page.locator("#tm-open-day").click();
  await expect(page.locator("#time-machine")).toBeHidden();
  await expect(page.locator("#date-list .drow.active")).toHaveAttribute("data-date", dates[1].date);
  expect(new URL(page.url()).hash).toBe(`#${dates[1].date}`);
});

test("a trip preview in the date gallery opens that recording", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/browse");
  await page.locator(".tm-launch").click();
  await expect(page.locator("#tm-preview-body .trip-card")).toHaveCount(2);
  await page.locator("#tm-preview-body .trip-card").first().click();
  await expect(page).toHaveURL(/\/trip\//);
  await expect(page.locator("#page-main")).toBeVisible();
});

test("phone date gallery supports drag, keyboard, and escape without page overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await page.goto("/browse");
  await expect(page.locator("#daterail-trigger")).toBeVisible();
  await page.locator("#daterail-trigger").click();
  const stage = page.locator("#tm-stage");
  await expect(stage).toBeFocused();
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
  await page.mouse.down();
  const before = await page
    .locator('.tm-card[data-index="0"]')
    .evaluate((element) => element.style.transform);
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 6 });
  const during = await page
    .locator('.tm-card[data-index="0"]')
    .evaluate((element) => element.style.transform);
  expect(during).not.toBe(before);
  await page.mouse.up();
  await expect(page.locator('.tm-card[aria-current="date"]')).toHaveAttribute("data-index", "1");
  await stage.press("ArrowRight");
  await expect(page.locator('.tm-card[aria-current="date"]')).toHaveAttribute("data-index", "2");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await stage.press("Escape");
  await expect(page.locator("#time-machine")).toBeHidden();
  await expect(page.locator("#daterail-trigger")).toBeFocused();
});

test("the gallery can jump across a long history and honors reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const longHistory = Array.from({ length: 120 }, (_, index) => ({
    ...dates[1],
    date: new Date(Date.UTC(2026, 7, 2 - index)).toISOString().slice(0, 10),
  }));
  await page.route("**/api/trips/dates?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(longHistory),
    }),
  );
  await page.goto("/browse");
  await page.locator("#daterail-trigger").click();
  const range = page.locator("#tm-range");
  await expect(range).toHaveAttribute("max", "119");
  await range.evaluate((element: HTMLInputElement) => {
    element.value = "119";
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator('.tm-card[aria-current="date"]')).toHaveAttribute("data-index", "119");
  const transition = await page
    .locator('.tm-card[data-index="119"]')
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(transition).toBe("0s");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
});
