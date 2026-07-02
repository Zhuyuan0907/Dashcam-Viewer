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
