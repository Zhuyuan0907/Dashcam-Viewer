import { expect, test } from "@playwright/test";

const tripId = "v2|u:1|d:2|MS279WG-ui-test";
for (const [width, height] of [[1440, 900], [1366, 768], [390, 844]] as const) {
  test(`screens ${width}x${height}`, async ({ page, context }, info) => {
    await context.addCookies([
      { name: "session_token", value: "ui-device-test-session", domain: "127.0.0.1", path: "/" },
    ]);
    await page.setViewportSize({ width, height });
    await page.goto(`/trip/${encodeURIComponent(tripId)}`);
    await expect(page.locator("#page-main")).toBeVisible();
    await page.locator("#btn-play").click();
    await page.waitForTimeout(1500);
    const track = (await page.locator("#track").boundingBox())!;
    await page.mouse.move(track.x + track.width * 0.6, track.y + track.height / 2);
    await page.waitForTimeout(400);
    await page.screenshot({ path: info.outputPath(`trip-${width}.png`) });
    if (width > 700) {
      await page.locator("#btn-settings").click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: info.outputPath(`settings-${width}.png`) });
      await page.keyboard.press("Escape");
    }
    await page.locator(".note-open").click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: info.outputPath(`note-${width}.png`) });
    expect("screenshots captured").toBe("force artifact upload");
  });
}
