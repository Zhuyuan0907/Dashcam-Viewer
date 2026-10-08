import { expect, test } from "@playwright/test";

test("visitors can read the app purpose and policies without a login redirect", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".public-hero")).toContainText("YouTube 備份服務");
    await expect(
      page.getByRole("heading", { name: "為什麼需要 Google／YouTube 授權？" }),
    ).toBeVisible();
    for (const route of ["/privacy", "/terms", "/youtube/privacy"]) {
      await page.goto(route);
      await expect(page).toHaveURL(new RegExp(`${route}$`));
      await expect(page.locator("h1")).toContainText(
        route === "/terms" ? "服務條款" : "隱私權政策",
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1);
    }
  }
  await page.locator(".public-header nav a[href='/about']").click();
  await expect(page.locator(".public-hero")).toBeVisible();
  await page.getByRole("link", { name: "登入管理影片" }).click();
  await expect(page.locator("#login-form")).toBeVisible();
  expect(errors).toEqual([]);
});

test("the app purpose and policy content are readable with JavaScript disabled", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await context.newPage();
  try {
    await page.goto("/");
    await expect(page.locator(".public-hero")).toContainText("YouTube 備份服務");
    await page.locator(".public-header a[href='/privacy']").click();
    await expect(page.locator("#collection")).toContainText("refresh token");
    await expect(page.locator("#deletion")).toContainText("第三方存取設定");
    await page.locator(".public-header a[href='/terms']").click();
    await expect(page.locator("h1")).toContainText("Terms of Service");
  } finally {
    await context.close();
  }
});
