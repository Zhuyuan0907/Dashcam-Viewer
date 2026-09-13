import { expect, test, type Locator } from "@playwright/test";

const palettes = {
  harbor: "rgb(229, 235, 230)",
  terracotta: "rgb(236, 223, 206)",
  slate: "rgb(220, 226, 239)",
};

async function expectField(field: Locator, background: string) {
  await expect(field).toHaveCSS("background-color", background);
  await expect(field).toHaveCSS("border-radius", "10px");
  const contrast = await field.evaluate((element) => {
    const css = getComputedStyle(element);
    const luminance = (color: string) => {
      const channels = color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map((c) => {
          const value = c / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const a = luminance(css.color),
      b = luminance(css.backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
}

for (const width of [1440, 390]) {
  test(`transparent header and tinted account controls across palettes at ${width}px`, async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { name: "session_token", value: "ui-device-test-session", domain: "127.0.0.1", path: "/" },
    ]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/account");
    await expect(page.locator("#acct-display")).toHaveValue("UI 驗收");
    for (const [palette, background] of Object.entries(palettes)) {
      await page.evaluate((p) => (window as any).DashcamThemes.apply(p), palette);
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(page.locator(".hdr")).not.toHaveClass(/is-scrolled/);
      await expect(page.locator(".hdr")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(page.locator(".hdr")).toHaveCSS("box-shadow", "none");
      await expectField(page.locator("#acct-display"), background);
      await expectField(page.locator("#acct-camera"), background);
      await expect(page.locator("#acct-camera")).not.toHaveCSS("background-image", "none");
      await expect(page.locator("#acct-camera option").first()).toHaveCSS(
        "background-color",
        background,
      );
      await expect(page.locator("#acct-username")).toBeDisabled();
      await expect(page.locator("#acct-username")).toHaveCSS("border-top-style", "dashed");
      await page.locator("#acct-display").focus();
      await expect(page.locator("#acct-display")).toHaveCSS("outline-width", "3px");
      await page.evaluate(() => window.scrollTo(0, 500));
      await expect(page.locator(".hdr")).toHaveClass(/is-scrolled/);
      await expect(page.locator(".hdr")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(page.locator(".hdr-brand")).not.toHaveCSS("color", "rgb(255, 255, 255)");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1);
    }
    if (width < 860) {
      await page.locator(".hdr-burger").click();
      await expect(page.locator(".m-drawer")).toBeVisible();
      await expect(page.locator(".m-drawer")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await page.locator(".m-close").click();
      await expect(page.locator(".m-drawer")).toBeHidden();
    } else {
      await expect(page.locator(".user-chip")).toContainText("UI 驗收");
      await expect(page.locator(".user-chip")).toHaveCSS("color", "rgb(39, 45, 70)");
    }
    await page.locator("#device-add").click();
    await expectField(page.locator("#device-note"), palettes.slate);
    await page.locator("#device-modal-close").click();
    await page.evaluate(() => {
      (window as any).DashcamThemes.apply("harbor");
      window.scrollTo(0, 0);
    });
    await expect(page.locator(".hdr")).not.toHaveClass(/is-scrolled/);
    await page.screenshot({ path: `test-results/theme-account-${width}.png` });
  });

  test(`editor fields and zoom remain usable at ${width}px`, async ({ page, context }) => {
    await context.addCookies([
      { name: "session_token", value: "ui-device-test-session", domain: "127.0.0.1", path: "/" },
    ]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/trip/" + encodeURIComponent("v2|u:1|d:2|MS279WG-ui-test"));
    await page.locator("#edit-btn").click();
    const zoom = page.getByRole("combobox", { name: "時間軸倍率" });
    for (const [palette, background] of Object.entries(palettes)) {
      await page.evaluate((p) => (window as any).DashcamThemes.apply(p), palette);
      for (const field of [
        page.locator("#sel-start-input"),
        page.locator("#sel-end-input"),
        zoom,
        page.locator("#clip-label"),
      ]) {
        await expectField(field, background);
      }
    }
    await page.locator("#sel-start-input").fill("0.125");
    await page.locator("#sel-start-input").press("Tab");
    await expect(page.locator("#sel-start-input")).toHaveValue("0.125");
    await zoom.selectOption("2");
    await expect(page.locator("#clip-timeline")).toHaveAttribute("style", /width: 200%/);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `test-results/theme-editor-${width}.png`, fullPage: true });
  });
}

test("dark login retains translucent fields and readable input text", async ({ page }) => {
  await page.goto("/login");
  for (const palette of Object.keys(palettes)) {
    await page.evaluate((p) => (window as any).DashcamThemes.apply(p), palette);
    await expect(page.locator("#username")).toHaveCSS(
      "background-color",
      "rgba(255, 255, 255, 0.07)",
    );
    await expect(page.locator("#username")).toHaveCSS("color", "rgb(255, 255, 255)");
    await page.locator("#password").focus();
    await expect(page.locator("#password")).toHaveCSS(
      "background-color",
      "rgba(255, 255, 255, 0.12)",
    );
  }
});
