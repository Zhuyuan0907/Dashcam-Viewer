import { expect, test } from "@playwright/test";

const tripId = "v2|u:1|d:2|MS279WG-ui-test";

test.beforeEach(async ({ context, page }) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await context.addCookies([
    { name: "session_token", value: "ui-device-test-session", domain: "127.0.0.1", path: "/" },
  ]);
});

async function expectNoPageOverflow(page: import("@playwright/test").Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
}

test("the home calendar scrolls inside its own panel on a narrow phone", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".cal-grid .heat-cell").first()).toBeVisible();
  await expectNoPageOverflow(page);
  const calendar = await page.locator(".cal-scroll").evaluate((element) => ({
    content: element.scrollWidth,
    viewport: element.clientWidth,
  }));
  expect(calendar.content).toBeGreaterThan(calendar.viewport);
});

test("home headline comes from riding data and is never cut off on laptop screens", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#home-title")).toContainText(/騎了|上一趟|旅程/);
  await expect(page.locator(".feature")).toBeVisible();
  await expectNoPageOverflow(page);
  for (const [width, height] of [[1440, 900], [1366, 768], [1280, 720], [1920, 1080], [1024, 768]]) {
    await page.setViewportSize({ width, height });
    await page.reload();
    await expect(page.locator(".feature")).toBeVisible();
    // 一屏式:頁面不捲動,所有可見區塊都完整落在視窗內
    expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
    const bottom = await page.evaluate(() =>
      Math.max(...[...document.querySelectorAll(".home-hero, .feature, .latest-facts, .panel-box, .quick")]
        .filter((el) => el.getClientRects().length && getComputedStyle(el).display !== "none")
        .map((el) => el.getBoundingClientRect().bottom)),
    );
    expect(bottom, `${width}x${height}`).toBeLessThanOrEqual(height);
    await expect(page.locator("#app-footer")).toBeHidden();
  }
  // 窄桌面視窗改回一般捲動,不鎖住頁面
  await page.setViewportSize({ width: 900, height: 700 });
  await page.reload();
  await expect(page.locator(".feature")).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe("hidden");
});

test("trip heading and metadata stay readable at 320px", async ({ page }) => {
  await page.goto("/trip/" + encodeURIComponent(tripId));
  await expect(page.locator("#page-main")).toBeVisible();
  await expectNoPageOverflow(page);
  const layout = await page.evaluate(() => {
    const title = document.querySelector<HTMLElement>("#trip-title")!;
    const lineHeight = Number.parseFloat(getComputedStyle(title).lineHeight);
    const chips = [...document.querySelectorAll<HTMLElement>("#info-strip .chip")];
    return {
      titleLines: title.getBoundingClientRect().height / lineHeight,
      chipLines: chips.flatMap((chip) =>
        [...chip.children].map((child) => {
          const range = document.createRange();
          range.selectNodeContents(child);
          return new Set(
            [...range.getClientRects()]
              .filter((rect) => rect.width > 0)
              .map((rect) => Math.round(rect.top)),
          ).size;
        }),
      ),
    };
  });
  expect(layout.titleLines).toBeLessThan(1.2);
  expect(Math.max(...layout.chipLines)).toBe(1);
});

test("one exported clip fits the narrow card without page overflow", async ({ page }) => {
  await page.route("**/api/clips?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: 42,
          trip_id: tripId,
          date: "2026-08-02",
          day_order: 1,
          label: "雨中穿越路口時前後鏡頭都有記錄到的畫面",
          start_sec: 100,
          end_sec: 110,
          duration_sec: 10,
          layout: "front",
          quality: "precise",
          size_bytes: 12_000_000,
          report: {},
          reported_at: null,
        },
      ]),
    }),
  );
  await page.goto("/clips");
  await expect(page.locator(".clip-card")).toHaveCount(1);
  await expectNoPageOverflow(page);
  await expect(page.locator(".clip-edit")).toBeVisible();
});

test("upload instructions are compact while exact filenames remain accessible", async ({
  page,
}) => {
  await page.goto("/upload");
  await expect(page.locator("#how-card")).toBeVisible();
  await expect(page.locator(".upload-format-details")).not.toHaveAttribute("open");
  const intro = page.locator("#upload-intro");
  const introLines = await intro.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
  expect(introLines).toBe(1);
  await page.locator(".upload-format-details summary").click();
  await expect(page.locator(".upload-format-details")).toHaveAttribute("open");
  await expectNoPageOverflow(page);
  const example = await page
    .locator(".upload-format-list code")
    .first()
    .evaluate((element) => ({
      content: element.scrollWidth,
      viewport: element.clientWidth,
    }));
  expect(example.content).toBeGreaterThan(example.viewport);
});
