import { expect, test } from "@playwright/test";

const baseURL = process.env.DASHCAM_E2E_BASE_URL ?? "http://127.0.0.1:8181";
const token = process.env.DASHCAM_E2E_SESSION_TOKEN ?? "ui-device-test-session";

test("cloud backup: the owner stores a key, picks a trip and manages the queue", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "session_token",
      value: token,
      domain: new URL(baseURL).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  // 先暫停佇列：測試全程不會連到真的儲存服務。
  const paused = await page.request.post(`${baseURL}/api/cloud-backup/pause`, {
    data: { paused: true },
  });
  expect(paused.ok()).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(`${baseURL}/ops`);
  await page.locator('.console-tab[data-pane="cloud"]').click();
  // 尚未設定金鑰的擁有者直接看到設定。
  await expect(page.locator("#cbk-settings")).toBeVisible();
  await expect(page.locator("#cbk-banner")).toContainText("尚未設定 API 金鑰");
  await page.locator("#cbk-key").fill("short");
  await page.locator("#cbk-key-save").click();
  await expect(page.locator("#cbk-notice")).toContainText("格式不正確");
  await page.locator("#cbk-key").fill("cpk_ui_test_key_0123456789");
  await page.locator("#cbk-key-save").click();
  await expect(page.locator("#cbk-key-state")).toContainText("結尾 6789");
  await expect(page.locator("#cbk-key")).toHaveValue("");

  await page.locator('[data-cbk="pick"]').click();
  const trip = page.locator(".cbk-trip:not(.is-done)").first();
  await expect(trip).toContainText("未備份");
  await trip.locator("input").check();
  await expect(page.locator("#cbk-sel-text")).toContainText("已選 1 趟");
  await page.locator("#cbk-enqueue").click();
  await expect(page.locator("#cbk-notice")).toContainText(/已加入 \d+ 個檔案/);

  await page.locator('[data-cbk="progress"]').click();
  await expect(page.locator("#cbk-banner")).toContainText("備份已暫停");
  await expect(page.locator("#cbk-jobs .ytm-row").first()).toContainText("等待中");
  await page.locator("#cbk-jobs .ytm-row").first().click();
  await expect(page.locator("#cbk-detail")).toContainText("雲端檔名");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#cbk-cancel-queued").click();
  await expect(page.locator("#cbk-jobs")).toContainText("目前沒有等待中的備份");

  await page.locator('[data-cbk="settings"]').click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#cbk-key-remove").click();
  await expect(page.locator("#cbk-key-state")).toContainText("尚未設定");
  expect(errors).toEqual([]);
});
