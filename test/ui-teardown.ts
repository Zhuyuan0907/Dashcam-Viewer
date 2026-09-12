import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export default async function teardown(): Promise<void> {
  if (process.env.DASHCAM_E2E_BASE_URL) return;
  await fs.rm(path.join(os.tmpdir(), "dashcam-ui-e2e"), { recursive: true, force: true });
}
