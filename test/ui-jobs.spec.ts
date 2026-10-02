import { expect, test, type Page } from "@playwright/test";

const baseURL = process.env.DASHCAM_E2E_BASE_URL ?? "http://127.0.0.1:8181";
const token = process.env.DASHCAM_E2E_SESSION_TOKEN ?? "ui-device-test-session";
const created = Date.UTC(2026, 8, 27, 10, 0, 0);

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
  await page.route("**/api/jobs?*", async (route) =>
    route.fulfill({
      json: route.request().url().includes("offset=0")
        ? [
            {
              id: "job-1",
              type: "import",
              target: "session-1",
              status: "succeeded",
              stage: "succeeded",
              progress: 100,
              message: "完成，已整理 2 趟旅程",
              created_at: created,
              updated_at: created + 60_000,
              result: { stage: "done" },
              can_cancel: false,
              can_retry: false,
            },
          ]
        : [],
    }),
  );
  await page.route("**/api/jobs/job-1/events", async (route) =>
    route.fulfill({
      json: [
        {
          id: 1,
          stage: "scan",
          message: "找到 8 組拍攝片段",
          progress: 10,
          done: null,
          total: null,
          created_at: created,
        },
        {
          id: 2,
          stage: "merge",
          message: "前鏡頭完成",
          progress: 80,
          done: 1,
          total: 2,
          created_at: created + 30_000,
        },
        {
          id: 3,
          stage: "succeeded",
          message: "完成，已整理 2 趟旅程",
          progress: 100,
          done: null,
          total: null,
          created_at: created + 60_000,
        },
      ],
    }),
  );
}

for (const [name, width, height] of [
  ["desktop", 1280, 800],
  ["mobile", 390, 844],
] as const) {
  test(`${name}: background jobs show saved steps without horizontal overflow`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await setup(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/jobs");
    await expect(page.getByRole("heading", { name: "背景作業" })).toBeVisible();
    await expect(page.locator(".job-card")).toHaveCount(1);
    await page.locator(".job-card").click();
    // 結構化紀錄:階段、重點數據、步驟;原始紀錄收合在最後
    await expect(page.locator(".jobs-detail .jl-step")).toHaveCount(2);
    await expect(page.locator(".jobs-detail .jl-fact").first()).toContainText("8");
    await expect(page.locator(".jobs-detail").getByText("找到 8 組拍攝片段")).toBeVisible();
    await page.locator(".jobs-detail .jl-raw summary").click();
    await expect(page.locator(".jobs-detail .jl-raw li")).toHaveCount(3);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath(`jobs-${name}.png`), fullPage: true });
  });
}
