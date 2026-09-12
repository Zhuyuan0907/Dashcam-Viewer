/**
 * 整趟裁剪(routes/edit.ts)端到端測試 —— 系統唯一會永久改寫使用者原始影片的破壞性操作,
 * 原本除了 403 授權外零覆蓋。用 ffmpeg 產生迷你 mp4 驗證:
 *   1. 首次裁剪成功:播放檔變短、.orig 備份保留、DB orig_* 寫入。
 *   2. 還原:播放檔恢復原長、DB orig_* 清空。
 *   3. 第二鏡頭失敗的原子 rollback:任一鏡頭失敗時「兩個播放檔都不動」、.orig 清除、DB 未變。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "test-edit-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { makeAdminApp } = await import("./_appctx.js");
const { ensureDataDirs } = await import("../src/db.js");

function hasFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

/** 產生一支長度 sec 秒的迷你 mp4。 */
function makeMp4(out: string, sec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      "ffmpeg",
      ["-v", "error", "-f", "lavfi", "-i", `testsrc=duration=${sec}:size=128x96:rate=10`, "-pix_fmt", "yuv420p", "-y", out],
      { stdio: "ignore" },
    );
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}`))));
  });
}

function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true, () => false);
}

/** 輪詢直到條件成立或逾時。 */
async function waitFor(cond: () => boolean, timeoutMs = 30_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("等待逾時");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const ffmpegOk = await hasFfmpeg();

/** 建一趟旅程(front/rear 各一支 mp4)並插入 DB 列;回傳 { tripId, dir, front, rear }。 */
async function makeTrip(
  ctx: { db: import("../src/db.js").DB },
  tripId: string,
  frontSec: number,
  rearContent: "video" | "corrupt",
): Promise<{ tripId: string; dir: string; front: string; rear: string }> {
  ensureDataDirs();
  const dir = path.join(DATA, "trips", "2026-01-01", `${tripId}`);
  await fs.mkdir(dir, { recursive: true });
  const front = path.join(dir, "front.mp4");
  const rear = path.join(dir, "rear.mp4");
  await makeMp4(front, frontSec);
  if (rearContent === "video") await makeMp4(rear, frontSec);
  else await fs.writeFile(rear, "this is not a video");
  const start = 1_700_000_000;
  ctx.db
    .prepare(
      `INSERT INTO trips (trip_id, date, day_order, start_epoch, end_epoch, duration_sec,
         segment_count, emer_count, has_front, has_rear, front_path, rear_path,
         peak_gforce, gforce_events, trip_dir, created_at, owner_id)
       VALUES (?, '2026-01-01', 1, ?, ?, ?, 1, 0, 1, 1, ?, ?, 0, 0, ?, ?, 1)`,
    )
    .run(tripId, start, start + frontSec, frontSec, front, rear, dir, start);
  return { tripId, dir, front, rear };
}

test(
  "首次裁剪成功 → 播放檔變短、.orig 保留、DB orig_* 寫入;還原後回復",
  { skip: ffmpegOk ? false : "系統無 ffmpeg" },
  async () => {
    const { app, ctx, cookie } = await makeAdminApp(DATA);
    const t = await makeTrip(ctx, "edit-ok", 6, "video");

    const res = await app.inject({
      method: "POST",
      url: "/api/trip-trim/" + encodeURIComponent(t.tripId),
      headers: { cookie, "content-type": "application/json" },
      payload: { start: 1, end: 4 }, // 取 3 秒
    });
    assert.equal(res.statusCode, 200);

    await waitFor(() => !ctx.jobs.hasTrim(t.tripId));

    const row = ctx.db.prepare("SELECT * FROM trips WHERE trip_id=?").get(t.tripId) as {
      duration_sec: number;
      orig_duration_sec: number | null;
    };
    assert.equal(row.duration_sec, 3, "裁剪後 duration 應為 3");
    assert.equal(row.orig_duration_sec, 6, "orig_duration 應保留原長 6");
    assert.ok(await exists(path.join(t.dir, "front.orig.mp4")), ".orig 備份應保留");
    assert.ok(await exists(t.front), "播放檔應存在");
    assert.ok(!(await exists(path.join(t.dir, "front.trim.tmp.mp4"))), "不應殘留 .trim.tmp");

    // 還原
    const del = await app.inject({
      method: "DELETE",
      url: "/api/trip-trim/" + encodeURIComponent(t.tripId),
      headers: { cookie },
    });
    assert.equal(del.statusCode, 200);
    const row2 = ctx.db.prepare("SELECT * FROM trips WHERE trip_id=?").get(t.tripId) as {
      duration_sec: number;
      orig_duration_sec: number | null;
    };
    assert.equal(row2.orig_duration_sec, null, "還原後 orig_* 應清空");
    assert.equal(row2.duration_sec, 6, "還原後 duration 回復為 6");

    await app.close();
  },
);

test(
  "第二鏡頭失敗 → 原子 rollback:兩播放檔都不動、.orig 清除、DB 未變",
  { skip: ffmpegOk ? false : "系統無 ffmpeg" },
  async () => {
    const { app, ctx, cookie } = await makeAdminApp(DATA);
    const t = await makeTrip(ctx, "edit-fail", 6, "corrupt"); // rear 是壞檔,第二鏡頭必失敗
    const frontBefore = (await fs.stat(t.front)).size;

    const res = await app.inject({
      method: "POST",
      url: "/api/trip-trim/" + encodeURIComponent(t.tripId),
      headers: { cookie, "content-type": "application/json" },
      payload: { start: 1, end: 4 },
    });
    assert.equal(res.statusCode, 200);

    await waitFor(() => !ctx.jobs.hasTrim(t.tripId));

    const row = ctx.db.prepare("SELECT * FROM trips WHERE trip_id=?").get(t.tripId) as {
      duration_sec: number;
      orig_duration_sec: number | null;
    };
    // 失敗時 DB 不得被更新(仍為原值),前後播放檔都不得被覆蓋。
    assert.equal(row.orig_duration_sec, null, "失敗不應寫入 orig_*");
    assert.equal(row.duration_sec, 6, "失敗不應改動 duration");
    assert.equal((await fs.stat(t.front)).size, frontBefore, "front 播放檔不應被改動");
    assert.ok(!(await exists(path.join(t.dir, "front.orig.mp4"))), "首次裁剪失敗應刪除剛建的 .orig");
    assert.ok(!(await exists(path.join(t.dir, "front.trim.tmp.mp4"))), "不應殘留 .trim.tmp");

    await app.close();
  },
);
