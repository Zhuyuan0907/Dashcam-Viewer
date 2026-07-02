import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { parseInfoTxt, importPrebuiltTrips } from "../src/trips/prebuilt.js";
import type { TripInfo } from "../src/trips/repo.js";

test("parseInfoTxt 支援全形與半形分隔符", () => {
  const meta = parseInfoTxt(
    ["日期      : 2026-06-04", "開始時間  : 2026-06-04 19:47:00", "總時長：32m 00s"].join("\n"),
  );
  assert.equal(meta["日期"], "2026-06-04");
  assert.equal(meta["開始時間"], "2026-06-04 19:47:00");
  assert.equal(meta["總時長"], "32m 00s");
});

// 真實資料結構:18 趟(複刻使用者上傳的內容)
const FIXTURE: Record<string, string[]> = {
  "2026-06-04": ["19.47-20.19 (32分)", "22.46-23.10 (24分)", "23.30-23.50 (20分)"],
  "2026-06-05": ["18.22-18.58 (36分)"],
  "2026-06-06": ["03.44-04.08 (24分)"],
  "2026-06-07": ["19.42-20.01 (19分)", "20.27-20.46 (19分)", "22.01-22.25 (24分)", "23.34-23.50 (16分)"],
  "2026-06-08": ["20.53-21.16 (24分)", "22.46-23.18 (32分)", "23.36-23.59 (23分)"],
  "2026-06-09": ["20.05-20.30 (25分)", "21.21-21.39 (18分)", "22.06-22.21 (15分)", "23.36-23.57 (21分)"],
  "2026-06-11": ["00.34-01.08 (34分)", "02.51-03.13 (22分)"],
};

async function buildFixture(root: string, nestUnder = ""): Promise<void> {
  for (const [date, trips] of Object.entries(FIXTURE)) {
    for (const trip of trips) {
      const dir = path.join(root, nestUnder, date, trip);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "前鏡頭.mp4"), "FRONT");
      await fs.writeFile(path.join(dir, "後鏡頭.mp4"), "REAR");
      await fs.writeFile(
        path.join(dir, "資訊.txt"),
        ["日期: " + date, "片段數: 12 段", "緊急片段: 3 個", "最高G-force: 1.61g", "高G事件: 0 次"].join("\n"),
      );
      // macOS 垃圾,應被忽略
      await fs.writeFile(path.join(dir, "._前鏡頭.mp4"), "junk");
    }
  }
}

test("importPrebuiltTrips:端到端匯入全部 18 趟(複刻 bug 重現)", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "prebuilt-"));
  const src = path.join(work, "src");
  const trips = path.join(work, "trips");
  await buildFixture(src);

  const imported: TripInfo[] = [];
  for await (const ev of importPrebuiltTrips(src, { tripsDir: trips, mode: "copy" })) {
    if (ev.tripInfo) imported.push(ev.tripInfo);
  }

  assert.equal(imported.length, 18, "應匯入全部 18 趟");

  // day_order 每日從 1 重新計
  const byDate = new Map<string, number[]>();
  for (const t of imported) {
    const arr = byDate.get(t.date) ?? [];
    arr.push(t.day_order);
    byDate.set(t.date, arr);
  }
  assert.deepEqual(byDate.get("2026-06-04"), [1, 2, 3]);
  assert.deepEqual(byDate.get("2026-06-07"), [1, 2, 3, 4]);

  // trip_id 格式、檔案實際複製過去、有 front/rear
  for (const t of imported) {
    assert.match(t.trip_id, /^pre\|\d{4}-\d{2}-\d{2}\|\d{6}$/);
    assert.equal(t.has_front, true);
    assert.equal(t.has_rear, true);
    assert.ok(t.front_path && (await fileExists(t.front_path)), "front.mp4 應已複製");
  }

  await fs.rm(work, { recursive: true, force: true });
});

test("importPrebuiltTrips:recursive 找出巢狀日期夾", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "prebuilt-nest-"));
  const src = path.join(work, "src");
  const trips = path.join(work, "trips");
  await buildFixture(src, "Dashcam/轉檔後旅程");

  // 非遞迴:找不到(日期夾被埋在子目錄)
  let flat = 0;
  for await (const ev of importPrebuiltTrips(src, { tripsDir: trips, mode: "copy", recursive: false })) {
    if (ev.tripInfo) flat++;
  }
  assert.equal(flat, 0);

  // 遞迴:全部找到
  let deep = 0;
  for await (const ev of importPrebuiltTrips(src, { tripsDir: trips, mode: "copy", recursive: true })) {
    if (ev.tripInfo) deep++;
  }
  assert.equal(deep, 18);

  await fs.rm(work, { recursive: true, force: true });
});

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}
