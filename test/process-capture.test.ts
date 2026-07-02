/**
 * startProcessing 的失敗擷取 + 隔離測試:
 *   原始片段合併失敗時,應記錄 incident、把原始素材隔離保留(而非刪除),供日後重試。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "proc-cap-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { makeAdminApp } = await import("./_appctx.js");
const { startProcessing } = await import("../src/routes/process.js");
const { listIncidents } = await import("../src/incidents/repo.js");
const { UPLOAD_DIR, QUARANTINE_DIR } = await import("../src/config.js");

test("合併失敗 → 記錄 incident 並隔離保留原始素材", async () => {
  const { ctx } = await makeAdminApp(DATA);
  const sid = "capsid";
  const base = "FILE240115-080000-001";
  // 在上傳 session 夾放「檔名合規但內容無效」的片段 → 合併必失敗。
  for (const cam of ["F", "R"] as const) {
    const d = path.join(UPLOAD_DIR, sid, cam);
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, `${base}${cam}.mp4`), "not a video");
  }

  // ingestFlatFolder 對此結構會判定為 raw;測試直接放好 F/R,故明確傳 "raw"。
  startProcessing(ctx, sid, 15, "raw");

  // 等待背景處理完成(輪詢 incidents 出現)。
  let inc = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const { rows } = listIncidents(ctx.db, { status: "all" });
    if (rows.length > 0) {
      inc = rows[0];
      break;
    }
  }
  assert.ok(inc, "應記錄一筆 incident");
  assert.equal(inc!.session_id, sid);
  assert.ok(inc!.quarantine_dir, "應有隔離素材路徑");

  // 隔離夾應存在且含原始素材;原上傳夾應已被搬走。
  const qdir = path.join(QUARANTINE_DIR, sid);
  assert.equal(inc!.quarantine_dir, qdir);
  assert.equal(await fs.stat(qdir).then(() => true).catch(() => false), true, "隔離夾應存在");
  assert.equal(
    await fs.stat(path.join(qdir, "F", `${base}F.mp4`)).then(() => true).catch(() => false),
    true,
    "原始片段應被保留在隔離夾",
  );
  assert.equal(
    await fs.stat(path.join(UPLOAD_DIR, sid)).then(() => true).catch(() => false),
    false,
    "原上傳夾應已被搬移(不再存在)",
  );
});
