import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import path from "node:path";

// 必須在載入會讀 config 的模組「之前」設好資料目錄
const DATA = mkdtempSync(path.join(os.tmpdir(), "ingest-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { ingestFlatFolder } = await import("../src/uploads/ingest.js");
const { UPLOAD_DIR, PREBUILT_DIR } = await import("../src/config.js");

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

test("把扁平/混合的 SFTP 資料夾分流成 F/R/NMEA + prebuilt", async () => {
  const sid = "sess0001";
  const root = path.join(UPLOAD_DIR, sid);
  const tripDir = path.join(root, "2026-06-04", "19.47-20.19 (32分)");
  await fs.mkdir(tripDir, { recursive: true });

  // raw 片段(直接丟在 root)
  await fs.writeFile(path.join(root, "FILE260611-194117-000000F.mp4"), "f");
  await fs.writeFile(path.join(root, "FILE260611-194117-000000R.mp4"), "r");
  await fs.writeFile(path.join(root, "FILE260611-194117-000000F.NMEA"), "n");
  // prebuilt(日期樹)
  await fs.writeFile(path.join(tripDir, "前鏡頭.mp4"), "pf");
  await fs.writeFile(path.join(tripDir, "後鏡頭.mp4"), "pr");
  // 格式不符
  await fs.writeFile(path.join(root, "readme.txt"), "x");

  const r = await ingestFlatFolder(sid);

  assert.equal(r.accepted, 5);
  assert.equal(r.uploadType, "mixed");
  assert.deepEqual(r.rawProfiles, ["mivue-mp20"]);
  assert.deepEqual(r.rejected, ["readme.txt"]);

  // raw 落點
  assert.ok(await fileExists(path.join(root, "F", "FILE260611-194117-000000F.mp4")));
  assert.ok(await fileExists(path.join(root, "R", "FILE260611-194117-000000R.mp4")));
  assert.ok(await fileExists(path.join(root, "NMEA", "FILE260611-194117-000000F.NMEA")));
  // prebuilt 落點(date 樹)
  assert.ok(
    await fileExists(path.join(PREBUILT_DIR, sid, "2026-06-04", "19.47-20.19 (32分)", "前鏡頭.mp4")),
  );

  await fs.rm(DATA, { recursive: true, force: true });
});
