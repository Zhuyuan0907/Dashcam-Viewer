import { expect, test } from "@playwright/test";

const tripId = "v2|u:1|d:2|MS279WG-ui-test";
for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080], [390, 844]] as const) {
  test(`screens ${width}x${height}`, async ({ page, context }, info) => {
    await context.addCookies([
      { name: "session_token", value: "ui-device-test-session", domain: "127.0.0.1", path: "/" },
    ]);
    await page.setViewportSize({ width, height });
    await page.goto(`/trip/${encodeURIComponent(tripId)}`);
    await expect(page.locator("#page-main")).toBeVisible();
    await page.locator("#btn-play").click();
    await page.waitForTimeout(2500);
    await page.mouse.move(width / 2, 200);
    await page.screenshot({ path: info.outputPath(`trip-${width}.png`) });
    await page.locator(".note-open").click();
    await page.screenshot({ path: info.outputPath(`note-${width}.png`) });
    expect("screenshots captured").toBe("force artifact upload");
  });
}
