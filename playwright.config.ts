import { defineConfig } from "@playwright/test";

const externalServer = Boolean(process.env.DASHCAM_E2E_BASE_URL);

export default defineConfig({
  workers: 1,
  timeout: 45_000,
  globalTeardown: "./test/ui-teardown.ts",
  use: {
    baseURL: process.env.DASHCAM_E2E_BASE_URL ?? "http://127.0.0.1:8181",
    launchOptions: process.env.DASHCAM_E2E_LOW_MEMORY
      ? {
          args: [
            "--js-flags=--max-old-space-size=64",
            "--renderer-process-limit=1",
            "--disable-gpu",
          ],
        }
      : {},
  },
  webServer: externalServer
    ? undefined
    : {
        command: "node --import tsx test/ui-server.ts",
        url: "http://127.0.0.1:8181/login",
        timeout: 120_000,
        reuseExistingServer: false,
      },
});
