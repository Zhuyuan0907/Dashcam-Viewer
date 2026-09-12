import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DATA = await fs.mkdtemp(path.join(os.tmpdir(), "rebuild-device-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { createDb } = await import("../src/db.js");
const { rebuildFromDisk, syncTripInfoDeviceMetadata } = await import("../src/trips/repo.js");

function snapshot() {
  return {
    v: 1 as const,
    profile_key: "polaroid-ms279wg" as const,
    model: "Polaroid MS279WG",
    nickname: "機車固定式",
    note: "前後雙鏡頭，固定於車身",
    show_on_trips: true,
  };
}

function tripInfo(tripId: string, dir: string, deviceId: number | null) {
  return {
    trip_id: tripId,
    date: "2026-08-03",
    day_order: 1,
    start_epoch: 1_786_000_000,
    end_epoch: 1_786_000_180,
    duration_sec: 180,
    segment_count: 1,
    emer_count: 0,
    has_front: true,
    has_rear: true,
    front_path: path.join(dir, "前鏡頭.mp4"),
    rear_path: path.join(dir, "後鏡頭.mp4"),
    peak_gforce: 0,
    gforce_events: 0,
    owner_id: 1,
    owner_username: "owner",
    device_id: deviceId,
    device: snapshot(),
  };
}

test("空庫重建遇到不存在的 device_id 時仍匯入旅程並保留快照", async () => {
  const db = createDb(path.join(DATA, "rebuild.db"));
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, email, created_at) VALUES (1, 'owner', 'h', 'admin', '', 0)",
  ).run();
  const dir = path.join(DATA, "trips", "by-user", "1", "legacy");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "info.json"), JSON.stringify(tripInfo("missing-device", dir, 999)));

  assert.equal(await rebuildFromDisk(db), 1);
  const row = db.prepare("SELECT device_id, device_snapshot FROM trips WHERE trip_id = ?")
    .get("missing-device") as { device_id: number | null; device_snapshot: string };
  assert.equal(row.device_id, null);
  assert.equal(JSON.parse(row.device_snapshot).model, "Polaroid MS279WG");

  const mismatchedDir = path.join(DATA, "trips", "by-user", "1", "mismatched-owner");
  await fs.mkdir(mismatchedDir, { recursive: true });
  await fs.writeFile(
    path.join(mismatchedDir, "info.json"),
    JSON.stringify({ ...tripInfo("mismatched-owner", mismatchedDir, null), owner_username: "previous-owner" }),
  );
  await rebuildFromDisk(db);
  const mismatched = db.prepare("SELECT owner_id FROM trips WHERE trip_id = ?")
    .get("mismatched-owner") as { owner_id: number | null };
  assert.equal(mismatched.owner_id, null, "數字 ID 相同但帳號名稱不同時不可錯綁私人旅程");
  db.close();
});

test("metadata 同步補寫 owner／裝置快照且可重複執行", async () => {
  const db = createDb(path.join(DATA, "sync.db"));
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, email, created_at) VALUES (1, 'owner', 'h', 'admin', '', 0)",
  ).run();
  const now = Math.floor(Date.now() / 1000);
  const inserted = db.prepare(
    `INSERT INTO dashcam_devices
      (user_id, profile_key, model, nickname, note, show_on_trips, is_default, created_at, updated_at)
     VALUES (1, 'polaroid-ms279wg', 'Polaroid MS279WG', '機車固定式', '前後雙鏡頭，固定於車身', 1, 1, ?, ?)`,
  ).run(now, now);
  const deviceId = Number(inserted.lastInsertRowid);
  const dir = path.join(DATA, "trips", "by-user", "1", "sync-trip");
  await fs.mkdir(dir, { recursive: true });
  const info = tripInfo("sync-trip", dir, null);
  delete (info as Partial<typeof info>).owner_id;
  delete (info as Partial<typeof info>).device_id;
  delete (info as Partial<typeof info>).device;
  await fs.writeFile(path.join(dir, "info.json"), JSON.stringify(info));

  db.prepare(
    `INSERT INTO trips
      (trip_id, date, day_order, start_epoch, end_epoch, duration_sec, segment_count, emer_count,
       has_front, has_rear, front_path, rear_path, peak_gforce, gforce_events, trip_dir, created_at,
       owner_id, device_id, device_snapshot)
     VALUES (?, ?, 1, ?, ?, 180, 1, 0, 1, 1, ?, ?, 0, 0, ?, ?, 1, ?, ?)`,
  ).run(
    "sync-trip", "2026-08-03", 1_786_000_000, 1_786_000_180,
    path.join(dir, "前鏡頭.mp4"), path.join(dir, "後鏡頭.mp4"), dir, now,
    deviceId, JSON.stringify(snapshot()),
  );

  assert.deepEqual(await syncTripInfoDeviceMetadata(db), { scanned: 1, updated: 1, failed: 0 });
  const written = JSON.parse(await fs.readFile(path.join(dir, "info.json"), "utf8"));
  assert.equal(written.owner_id, 1);
  assert.equal(written.owner_username, "owner");
  assert.equal(written.device_id, deviceId);
  assert.equal(written.device.note, "前後雙鏡頭，固定於車身");
  assert.deepEqual(await syncTripInfoDeviceMetadata(db), { scanned: 1, updated: 0, failed: 0 });
  db.close();
});

test("metadata 同步拒絕覆寫共用目錄，避免不同旅程互相污染", async () => {
  const db = createDb(path.join(DATA, "shared-dir.db"));
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, email, created_at) VALUES (1, 'owner', 'h', 'admin', '', 0)",
  ).run();
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, email, created_at) VALUES (2, 'other', 'h', 'viewer', '', 0)",
  ).run();
  const now = Math.floor(Date.now() / 1000);
  const dir = path.join(DATA, "trips", "shared-dir");
  await fs.mkdir(dir, { recursive: true });
  const original = tripInfo("first-trip", dir, null);
  await fs.writeFile(path.join(dir, "info.json"), JSON.stringify(original));

  const insert = db.prepare(
    `INSERT INTO trips
      (trip_id, date, day_order, start_epoch, end_epoch, duration_sec, segment_count, emer_count,
       has_front, has_rear, front_path, rear_path, peak_gforce, gforce_events, trip_dir, created_at,
       owner_id, device_id, device_snapshot)
     VALUES (?, '2026-08-03', 1, ?, ?, 180, 1, 0, 1, 1, ?, ?, 0, 0, ?, ?, ?, NULL, NULL)`,
  );
  insert.run(
    "first-trip", 1_786_000_000, 1_786_000_180,
    path.join(dir, "前鏡頭.mp4"), path.join(dir, "後鏡頭.mp4"), dir, now, 1,
  );
  insert.run(
    "second-trip", 1_786_000_200, 1_786_000_380,
    path.join(dir, "前鏡頭.mp4"), path.join(dir, "後鏡頭.mp4"), dir, now, 2,
  );

  assert.deepEqual(await syncTripInfoDeviceMetadata(db), { scanned: 2, updated: 0, failed: 2 });
  const unchanged = JSON.parse(await fs.readFile(path.join(dir, "info.json"), "utf8"));
  assert.equal(unchanged.trip_id, "first-trip");
  assert.equal(unchanged.owner_id, 1);
  assert.equal(unchanged.owner_username, "owner");
  db.close();
});

test("metadata 目錄暫時不存在時回報失敗，避免啟動流程誤設完成標記", async () => {
  const db = createDb(path.join(DATA, "missing-dir.db"));
  const missing = path.join(DATA, "trips", "temporarily-unavailable");
  db.prepare(
    `INSERT INTO trips
      (trip_id, date, start_epoch, end_epoch, duration_sec, front_path, trip_dir, created_at)
     VALUES ('missing-dir', '2026-08-03', 1, 2, 1, ?, ?, 1)`,
  ).run(path.join(missing, "前鏡頭.mp4"), missing);
  assert.deepEqual(await syncTripInfoDeviceMetadata(db), { scanned: 1, updated: 0, failed: 1 });
  db.close();
});
