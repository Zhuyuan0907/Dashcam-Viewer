import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { createDb } from "../src/db.js";
import { upsertTrip, getTrip, listTrips, listDates, deleteTrip, type TripInfo } from "../src/trips/repo.js";

function sampleTrip(over: Partial<TripInfo> = {}): TripInfo {
  return {
    trip_id: "pre|2026-06-04|194700",
    date: "2026-06-04",
    day_order: 1,
    start_epoch: 1_780_595_220,
    end_epoch: 1_780_597_140,
    duration_sec: 1920,
    segment_count: 32,
    emer_count: 18,
    has_front: true,
    has_rear: true,
    front_path: "/data/front.mp4",
    rear_path: "/data/rear.mp4",
    peak_gforce: 1.61,
    gforce_events: 0,
    ...over,
  };
}

async function tmpDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-"));
  return { db: createDb(path.join(dir, "t.db")), dir };
}

test("upsertTrip / getTrip 寫入與覆寫", async () => {
  const { db, dir } = await tmpDb();
  upsertTrip(db, sampleTrip(), "/data");
  const row = getTrip(db, "pre|2026-06-04|194700")!;
  assert.equal(row.has_front, 1);
  assert.equal(row.peak_gforce, 1.61);
  assert.equal(row.trip_dir, "/data");

  upsertTrip(db, sampleTrip({ peak_gforce: 2.2 }), "/data");
  assert.equal(getTrip(db, "pre|2026-06-04|194700")!.peak_gforce, 2.2);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM trips").get() as { c: number }).c, 1, "覆寫不應產生重複列");

  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("listTrips / listDates", async () => {
  const { db, dir } = await tmpDb();
  upsertTrip(db, sampleTrip({ trip_id: "a", date: "2026-06-04", start_epoch: 100 }));
  upsertTrip(db, sampleTrip({ trip_id: "b", date: "2026-06-04", start_epoch: 200 }));
  upsertTrip(db, sampleTrip({ trip_id: "c", date: "2026-06-05", start_epoch: 300 }));

  // 以管理員視角(可見全部,含 owner_id 為 null 的種子資料)。
  const admin = { id: 1, role: "admin" };
  const all = await listTrips(db, { viewer: admin, limit: 50, offset: 0 });
  assert.equal(all.total, 3);
  const oneDay = await listTrips(db, { date: "2026-06-04", viewer: admin, limit: 50, offset: 0 });
  assert.equal(oneDay.total, 2);
  const dates = listDates(db, null, admin);
  assert.equal(dates.length, 2);

  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("deleteTrip 移除列與磁碟目錄", async () => {
  const { db, dir } = await tmpDb();
  const tripDir = path.join(dir, "trip1");
  await fs.mkdir(tripDir, { recursive: true });
  await fs.writeFile(path.join(tripDir, "front.mp4"), "x");
  upsertTrip(db, sampleTrip({ trip_id: "t1" }), tripDir);

  assert.equal(await deleteTrip(db, "t1"), true);
  assert.equal(getTrip(db, "t1"), null);
  assert.equal(await fileExists(path.join(tripDir, "front.mp4")), false, "磁碟目錄應一併刪除");
  assert.equal(await deleteTrip(db, "nope"), false);

  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("upsertTrip 重覆寫入不得毀掉備註/匯出片段,也不清空可見性覆寫與裁剪還原資料", async () => {
  const { db, dir } = await tmpDb();
  const tid = "keep|1";
  upsertTrip(db, sampleTrip({ trip_id: tid }), "/data", 7);

  // 加上備註、匯出片段、公開覆寫、裁剪原始值(模擬使用者累積的狀態)。
  db.prepare(
    "INSERT INTO trip_notes (trip_id, note, updated_at, updated_by) VALUES (?,?,?,?)",
  ).run(tid, "重要:這段有擦撞", 1_700_000_000, 7);
  db.prepare(
    `INSERT INTO trip_clips (trip_id, owner_id, label, start_sec, end_sec, layout, quality, main_cam, file_path, size_bytes, duration_sec, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(tid, 7, "精華", 1, 5, "front", "precise", null, "/data/clips/x.mp4", 123, 4, 1_700_000_000);
  db.prepare(
    "UPDATE trips SET public_override = 1, orig_start_epoch = 100, orig_end_epoch = 200, orig_duration_sec = 100 WHERE trip_id = ?",
  ).run(tid);

  // 重新處理(重新 upsert 同一趟,例如分批補傳)。舊的 INSERT OR REPLACE 會 CASCADE 刪掉
  // note/clip 並把 override/orig_* 重置 —— 這裡驗證改用真 UPSERT 後這些都被保留。
  upsertTrip(db, sampleTrip({ trip_id: tid, peak_gforce: 2.9 }), "/data");

  const note = db.prepare("SELECT note FROM trip_notes WHERE trip_id=?").get(tid) as { note: string } | undefined;
  assert.equal(note?.note, "重要:這段有擦撞", "備註不應被 CASCADE 刪除");
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM trip_clips WHERE trip_id=?").get(tid) as { c: number }).c,
    1,
    "匯出片段不應被 CASCADE 刪除",
  );
  const row = getTrip(db, tid)!;
  assert.equal(row.public_override, 1, "public_override 應保留");
  assert.equal(row.orig_duration_sec, 100, "裁剪還原資料應保留");
  assert.equal(row.owner_id, 7, "既有 owner 應保留(COALESCE)");
  assert.equal(row.peak_gforce, 2.9, "其他欄位仍正常更新");

  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("deleteTrip:共用同一 trip_dir 的另一列存在時,不刪磁碟目錄", async () => {
  const { db, dir } = await tmpDb();
  const shared = path.join(dir, "shared");
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, "front.mp4"), "video");
  upsertTrip(db, sampleTrip({ trip_id: "A" }), shared);
  upsertTrip(db, sampleTrip({ trip_id: "B" }), shared); // 兩列共用同一目錄

  assert.equal(await deleteTrip(db, "A"), true);
  assert.equal(await fileExists(path.join(shared, "front.mp4")), true, "B 仍在,不可刪共用目錄");
  // 刪掉最後一列 → 目錄才真正清除
  assert.equal(await deleteTrip(db, "B"), true);
  assert.equal(await fileExists(path.join(shared, "front.mp4")), false, "最後一列刪除後目錄清除");

  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("SQL injection:惡意 trip_id 被當成資料,不破壞 table", async () => {
  const { db, dir } = await tmpDb();
  const evil = "'; DROP TABLE trips;--";
  upsertTrip(db, sampleTrip({ trip_id: evil }));
  // table 仍在,且該值被原樣存取
  const row = getTrip(db, evil);
  assert.ok(row, "惡意字串應被當作普通主鍵存入");
  assert.equal((db.prepare("SELECT COUNT(*) c FROM trips").get() as { c: number }).c, 1);

  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}
