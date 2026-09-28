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

test("all home slogans fit a phone and a refresh avoids the previous one", async ({ page }) => {
  await page.addInitScript(() => {
    const draw = sessionStorage.getItem("uiHeroDraw");
    if (draw !== null) Math.random = () => Number(draw);
  });
  await page.goto("/");
  const seen = new Set<string>();
  for (let index = 0; index < 20; index++) {
    await page.evaluate(
      (draw) => {
        sessionStorage.setItem("dashcam.hero.last", "__other_slogan__");
        sessionStorage.setItem("uiHeroDraw", String(draw));
      },
      (index + 0.1) / 20,
    );
    await page.reload();
    const layout = await page.locator("#hero-title").evaluate((title) => {
      const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
      const tops = new Set<number>();
      for (let node; (node = walker.nextNode()); ) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width > 0) tops.add(Math.round(rect.top));
        }
      }
      return { text: title.textContent!.trim(), lines: tops.size };
    });
    expect(layout.lines, layout.text).toBeLessThanOrEqual(2);
    await expectNoPageOverflow(page);
    seen.add(layout.text);
  }
  expect(seen.size).toBe(20);
  await page.setViewportSize({ width: 1440, height: 900 });
  for (let index = 0; index < 20; index++) {
    await page.evaluate(
      (draw) => {
        sessionStorage.setItem("dashcam.hero.last", "__other_slogan__");
        sessionStorage.setItem("uiHeroDraw", String(draw));
      },
      (index + 0.1) / 20,
    );
    await page.reload();
    await expectNoPageOverflow(page);
    const sub = await page.locator("#hero-sub").evaluate((element) => ({
      lines:
        element.getBoundingClientRect().height /
        Number.parseFloat(getComputedStyle(element).lineHeight),
      left: element.getBoundingClientRect().left,
    }));
    expect(sub.lines).toBeLessThan(2.2);
    expect(sub.left - (await page.locator("#hero-title").boundingBox())!.x).toBeGreaterThan(150);
  }
  await page.evaluate(() => {
    sessionStorage.removeItem("dashcam.hero.last");
    sessionStorage.setItem("uiHeroDraw", "0");
  });
  await page.reload();
  const first = await page.locator("#hero-title").textContent();
  await page.reload();
  expect(await page.locator("#hero-title").textContent()).not.toBe(first);
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
