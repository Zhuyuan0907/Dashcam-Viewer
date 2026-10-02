import { expect as baseExpect, test } from "@playwright/test";

// 動畫測試:在資源受限的機器上給彈簧動畫多一點時間定位
const expect = baseExpect.configure({ timeout: 15_000 });

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

test("desktop time machine stacks dated windows and travels with the trackpad", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/browse");
  await expect(page.locator("#date-list .drow")).toHaveCount(8);
  // 整頁固定一屏,只有日期軌與旅程區捲動;頁尾隱藏
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
  await page.locator(".tm-launch").click();
  await expect(page.locator("#time-machine")).toBeVisible();
  await expect(page.locator(".tm-card")).toHaveCount(8);
  await expect(page.locator('.tm-card[data-index="0"] .trip-card')).toHaveCount(2);
  await expect(page.locator(".tm-timeline li")).toHaveCount(8);
  await page.waitForTimeout(1500);   // 等進場動畫結束
  await page.locator("#tm-stage").hover({ position: { x: 40, y: 40 } });
  await page.mouse.wheel(0, 240);
  await expect(page.locator('.tm-card[aria-current="date"]')).toHaveAttribute("data-index", "1");
  await expect(page.locator('.tm-card[data-index="1"] .tm-empty')).toBeVisible();
  await expect(page.locator("#tm-title")).toContainText(String(Number(dates[1].date.slice(8))));
  // 已穿過的(較新)視窗朝觀看者飛出並淡去
  await expect
    .poll(() => page.locator('.tm-card[data-index="0"]').evaluate((el) => Number(getComputedStyle(el).opacity)))
    .toBeLessThan(0.05);
  await page.locator("#tm-open-day").click();
  await expect(page.locator("#time-machine")).toBeHidden();
  await expect(page.locator("#date-list .drow.active")).toHaveAttribute("data-date", dates[1].date);
  expect(new URL(page.url()).hash).toBe(`#${dates[1].date}`);
});

test("a trip in the front window opens that recording", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/browse");
  await page.locator(".tm-launch").click();
  const cards = page.locator('.tm-card[aria-current="date"] .trip-card');
  await expect(cards).toHaveCount(2);
  await cards.first().click();
  await expect(page).toHaveURL(/\/trip\//);
  await expect(page.locator("#page-main")).toBeVisible();
});

test("the timeline and arrows jump between dates", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/browse");
  await page.locator(".tm-launch").click();
  await expect(page.locator('.tm-card[aria-current="date"]')).toHaveAttribute("data-index", "0");
  await page.waitForTimeout(1500);   // 等進場動畫結束
  const tick = (await page.locator('.tm-timeline li[data-index="5"]').boundingBox())!;
  await page.mouse.click(tick.x + tick.width - 4, tick.y + tick.height / 2);
  await expect(page.locator('.tm-card[aria-current="date"]')).toHaveAttribute("data-index", "5");
  await expect(page.locator('.tm-timeline li[data-index="5"]')).toHaveClass(/is-current/);
  await page.locator("#tm-newer").click();
  await expect(page.locator('.tm-card[aria-current="date"]')).toHaveAttribute("data-index", "4");
  await page.locator("#tm-older").click();
  await page.locator("#tm-older").click();
  await expect(page.locator('.tm-card[aria-current="date"]')).toHaveAttribute("data-index", "6");
});

test("phone time machine supports drag, keyboard, and escape without page overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await page.goto("/browse");
  // 手機:日期改成橫向日期帶,整頁不捲動
  await expect(page.locator("#date-list .drow").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
  const launch = page.locator(".tm-launch");
  await launch.click();
  const stage = page.locator("#tm-stage");
  await expect(stage).toBeFocused();
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 30);
  await page.mouse.down();
  const before = await page.locator('.tm-card[data-index="0"]').evaluate((el) => el.style.transform);
  await page.mouse.move(box.x + box.width / 2, box.y + 150, { steps: 8 });
  const during = await page.locator('.tm-card[data-index="0"]').evaluate((el) => el.style.transform);
  expect(during).not.toBe(before);
  await page.mouse.up();
  await expect(page.locator('.tm-card[aria-current="date"]')).not.toHaveAttribute("data-index", "0");
  await page.waitForTimeout(1200);   // 等彈簧定位(甩動慣性可能多走幾天)
  const current = Number(await page.locator('.tm-card[aria-current="date"]').getAttribute("data-index"));
  // 甩動可能直接到最早一天,所以先往較新(↓)再回到原處(↑)
  await stage.press("ArrowDown");
  await expect(page.locator('.tm-card[aria-current="date"]')).toHaveAttribute("data-index", String(current - 1));
  await stage.press("ArrowUp");
  await expect(page.locator('.tm-card[aria-current="date"]')).toHaveAttribute("data-index", String(current));
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await stage.press("Escape");
  await expect(page.locator("#time-machine")).toBeHidden();
  await expect(launch).toBeFocused();
});

test("the time machine can jump across a long history and honors reduced motion", async ({ page }) => {
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
  await page.locator(".tm-launch").click();
  await expect(page.locator(".tm-timeline li")).toHaveCount(120);
  await page.locator("#tm-stage").press("End");
  await expect(page.locator('.tm-card[aria-current="date"]')).toHaveAttribute("data-index", "119");
  // 減少動態效果:立即定位,無中間影格
  const transform = await page
    .locator('.tm-card[data-index="119"]')
    .evaluate((element) => element.style.transform);
  expect(transform).toMatch(/translate3d\(-50%, 0(\.0+)?px, 0(\.0+)?px\)/);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
});
