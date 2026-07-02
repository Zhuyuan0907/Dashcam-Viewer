/**
 * processBatch 合併結果判定的回歸測試。
 *
 * 背景:曾發生「上傳原始片段 → 伺服器 ffmpeg 合併」的旅程全部產生 0-byte 影片,
 * 卻仍被記成有效旅程(介面出現但無法播放)。根因是舊版以 `fileExists()`(只看檔案
 * 存在)判定 has_front/has_rear,忽略合併是否真的成功與輸出是否非空。
 *
 * 這裡用 ffmpeg 產生迷你片段做端對端驗證:
 *   - 有效片段 → 旅程 has_front/has_rear 為真,且輸出檔非空。
 *   - 無效片段(合併必失敗)→ 不寫入空旅程(不發出 tripInfo),不留下 0-byte 殘檔。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { processBatch, type ProgressEvent } from "../src/trips/organizer.js";

/** 偵測系統是否有 ffmpeg;沒有就跳過整個檔(本機測試需要)。 */
function hasFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

/** 用 lavfi 產生一支 1 秒的迷你 mp4。 */
function makeMp4(out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      "ffmpeg",
      ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=128x96:rate=10", "-pix_fmt", "yuv420p", "-y", out],
      { stdio: "ignore" },
    );
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
  });
}

async function collect(opts: { uploadDir: string; tripsDir: string }): Promise<ProgressEvent[]> {
  const events: ProgressEvent[] = [];
  for await (const ev of processBatch(opts)) events.push(ev);
  return events;
}

const ffmpegOk = await hasFfmpeg();

test(
  "有效片段:旅程標記為有影片且輸出非空",
  { skip: ffmpegOk ? false : "系統無 ffmpeg" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "merge-ok-"));
    const upload = path.join(root, "up");
    const trips = path.join(root, "trips");
    const base = "FILE240115-080000-001";
    for (const cam of ["F", "R"] as const) {
      const dir = path.join(upload, cam);
      await fs.mkdir(dir, { recursive: true });
      await makeMp4(path.join(dir, `${base}${cam}.mp4`));
    }

    const events = await collect({ uploadDir: upload, tripsDir: trips });
    const tripInfos = events.filter((e) => e.tripInfo).map((e) => e.tripInfo!);

    assert.equal(tripInfos.length, 1, "應產生一趟旅程");
    const info = tripInfos[0]!;
    assert.ok(info.has_front, "has_front 應為真");
    assert.ok(info.has_rear, "has_rear 應為真");
    assert.ok(info.front_path && info.rear_path, "應有前後鏡頭路徑");
    const frontSize = (await fs.stat(info.front_path!)).size;
    const rearSize = (await fs.stat(info.rear_path!)).size;
    assert.ok(frontSize > 0 && rearSize > 0, "合併輸出不可為 0 bytes");

    await fs.rm(root, { recursive: true, force: true });
  },
);

test(
  "無效片段:合併失敗時不寫入空旅程、不留 0-byte 殘檔",
  { skip: ffmpegOk ? false : "系統無 ffmpeg" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "merge-bad-"));
    const upload = path.join(root, "up");
    const trips = path.join(root, "trips");
    const base = "FILE240115-080000-001";
    // 檔名合規但內容不是有效影片 → ffmpeg 合併必失敗。
    for (const cam of ["F", "R"] as const) {
      const dir = path.join(upload, cam);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${base}${cam}.mp4`), "this is not a video");
    }

    const events = await collect({ uploadDir: upload, tripsDir: trips });
    const tripInfos = events.filter((e) => e.tripInfo);

    assert.equal(tripInfos.length, 0, "合併失敗不應寫入旅程");

    // 失敗事件應夾帶結構化 incident(供善後系統記錄)。
    const incidentEv = events.find((e) => e.incident);
    assert.ok(incidentEv, "應有夾帶 incident 的事件");
    assert.equal(incidentEv!.incident!.kind, "trip_skipped");
    assert.ok(incidentEv!.incident!.detail.length > 0, "incident 應有失敗原因");

    // trips 目錄不應殘留任何 .mp4(更不該有 0-byte 檔)。
    const leftovers: string[] = [];
    async function walk(d: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith(".mp4")) leftovers.push(full);
      }
    }
    await walk(trips);
    assert.equal(leftovers.length, 0, `不應殘留 mp4:${leftovers.join(", ")}`);

    await fs.rm(root, { recursive: true, force: true });
  },
);
