/** 旅程 API DTO:不公開內部檔案路徑，並依快照設定控制裝置資訊可見性。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "test-trip-dto-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { makeAdminApp } = await import("./_appctx.js");
const { newSessionToken } = await import("../src/auth.js");

const LIST_KEYS = [
  "bytes",
  "date",
  "day_order",
  "device",
  "duration_sec",
  "emer_count",
  "end_epoch",
  "gforce_events",
  "has_front",
  "has_rear",
  "owner_id",
  "peak_gforce",
  "public_override",
  "segment_count",
  "start_epoch",
  "trimmed",
  "trip_id",
].sort();

const SINGLE_KEYS = [...LIST_KEYS, "note", "note_updated_at", "trimming", "timeline"].sort();
const DEVICE_KEYS = ["model", "nickname", "note", "profile_key", "show_on_trips"].sort();

function addViewer(db: any, id: number, username: string, isPublic = 0) {
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, email, created_at, trips_public) VALUES (?,?,?,'viewer','',0,?)",
  ).run(id, username, "h", isPublic);
  const token = newSessionToken();
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?,?,?,?)").run(
    token,
    id,
    now + 3600,
    now,
  );
  return { id, cookie: `session_token=${token}` };
}

function snapshot(showOnTrips: boolean) {
  return JSON.stringify({
    v: 1,
    profile_key: "polaroid-ms279wg",
    model: "Polaroid MS279WG",
    nickname: "機車前後鏡頭",
    note: "車身固定安裝",
    show_on_trips: showOnTrips,
    legacy_inferred: true,
  });
}

function seedTrip(
  db: any,
  tripId: string,
  ownerId: number,
  order: number,
  deviceSnapshot: string | null,
  deviceId: number | null = null,
) {
  const start = 1_780_000_000 + order * 1_000;
  db.prepare(
    `INSERT INTO trips
      (trip_id, date, day_order, start_epoch, end_epoch, duration_sec,
       segment_count, emer_count, has_front, has_rear, front_path, rear_path,
       peak_gforce, gforce_events, trip_dir, created_at, owner_id, public_override,
       orig_start_epoch, orig_end_epoch, orig_duration_sec, device_id, device_snapshot)
     VALUES
      (?, '2026-08-03', ?, ?, ?, 600,
       2, 1, 1, 1, '/private/front.mp4', '/private/rear.mp4',
       2.1, 3, '/private/trip-dir', ?, ?, NULL,
       ?, ?, 900, ?, ?)`,
  ).run(tripId, order, start, start + 600, start, ownerId, start - 100, start + 800, deviceId, deviceSnapshot);
}

function assertTripDto(value: Record<string, unknown>, single = false) {
  assert.deepEqual(Object.keys(value).sort(), single ? SINGLE_KEYS : LIST_KEYS);
  assert.equal(value.trimmed, true);
  for (const key of [
    "front_path",
    "rear_path",
    "trip_dir",
    "device_id",
    "device_snapshot",
    "created_at",
    "orig_start_epoch",
    "orig_end_epoch",
    "orig_duration_sec",
  ]) {
    assert.equal(Object.hasOwn(value, key), false, `${key} must not be exposed`);
  }
  if (value.device) {
    assert.deepEqual(Object.keys(value.device as Record<string, unknown>).sort(), DEVICE_KEYS);
  }
}

test("owner/admin 的清單與單趟回應只含安全 DTO，且可見未公開裝置快照", async () => {
  const { app, ctx, cookie: adminCookie } = await makeAdminApp(DATA);
  const alice = addViewer(ctx.db, 2, "alice");
  const tripId = "2026-08-03/1";
  seedTrip(ctx.db, tripId, alice.id, 1, snapshot(false));
  ctx.db.prepare(
    "INSERT INTO trip_notes (trip_id, note, updated_at, updated_by) VALUES (?, '測試備註', 123, ?)",
  ).run(tripId, alice.id);

  const list = await app.inject({
    method: "GET",
    url: "/api/trips?date=2026-08-03",
    headers: { cookie: alice.cookie },
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().total, 1);
  const listed = list.json().trips[0] as Record<string, unknown>;
  assertTripDto(listed);
  assert.deepEqual(listed.device, {
    profile_key: "polaroid-ms279wg",
    model: "Polaroid MS279WG",
    nickname: "機車前後鏡頭",
    note: "車身固定安裝",
    show_on_trips: false,
  });

  for (const cookie of [alice.cookie, adminCookie]) {
    const single = await app.inject({
      method: "GET",
      url: `/api/trips/${tripId}`,
      headers: { cookie },
    });
    assert.equal(single.statusCode, 200);
    const body = single.json() as Record<string, unknown>;
    assertTripDto(body, true);
    assert.equal((body.device as Record<string, unknown>).show_on_trips, false);
    assert.equal(body.note, "測試備註");
    assert.equal(body.note_updated_at, 123);
  }

  await app.close();
});

test("其他觀看者只能看到 show_on_trips=true 的安全裝置資訊", async () => {
  const { app, ctx } = await makeAdminApp(DATA);
  const alice = addViewer(ctx.db, 2, "alice", 1);
  const bob = addViewer(ctx.db, 3, "bob");
  seedTrip(ctx.db, "2026-08-03/1", alice.id, 1, snapshot(false));
  seedTrip(ctx.db, "2026-08-03/2", alice.id, 2, snapshot(true));
  seedTrip(ctx.db, "2026-08-03/3", alice.id, 3, "{malformed-json");

  const list = await app.inject({
    method: "GET",
    url: `/api/trips?date=2026-08-03&owner=${alice.id}`,
    headers: { cookie: bob.cookie },
  });
  assert.equal(list.statusCode, 200);
  const trips = list.json().trips as Array<Record<string, unknown>>;
  assert.equal(trips.length, 3);
  trips.forEach((trip) => assertTripDto(trip));
  const byId = new Map(trips.map((trip) => [trip.trip_id, trip]));
  assert.equal(byId.get("2026-08-03/1")?.device, null);
  assert.deepEqual(byId.get("2026-08-03/2")?.device, {
    profile_key: "polaroid-ms279wg",
    model: "Polaroid MS279WG",
    nickname: "機車前後鏡頭",
    note: "車身固定安裝",
    show_on_trips: true,
  });
  assert.equal(byId.get("2026-08-03/3")?.device, null);

  for (const [tripId, expectedDevice] of [
    ["2026-08-03/1", null],
    ["2026-08-03/2", true],
    ["2026-08-03/3", null],
  ] as const) {
    const single = await app.inject({ method: "GET", url: `/api/trips/${tripId}`, headers: { cookie: bob.cookie } });
    assert.equal(single.statusCode, 200);
    const body = single.json() as Record<string, unknown>;
    assertTripDto(body, true);
    if (expectedDevice === true) {
      assert.equal((body.device as Record<string, unknown>).model, "Polaroid MS279WG");
    } else {
      assert.equal(body.device, null);
    }
  }

  await app.close();
});

test("裝置分享開關即時套用舊旅程，但顯示內容仍使用上傳當下快照", async () => {
  const { app, ctx } = await makeAdminApp(DATA);
  const alice = addViewer(ctx.db, 2, "alice", 1);
  const bob = addViewer(ctx.db, 3, "bob");
  const now = Math.floor(Date.now() / 1000);
  const inserted = ctx.db.prepare(
    `INSERT INTO dashcam_devices
      (user_id, profile_key, model, nickname, note, show_on_trips, is_default, created_at, updated_at)
     VALUES (?, 'polaroid-ms279wg', '後來改名的型號', '', '', 0, 1, ?, ?)`,
  ).run(alice.id, now, now);
  const deviceId = Number(inserted.lastInsertRowid);
  seedTrip(ctx.db, "2026-08-03/live-privacy", alice.id, 1, snapshot(true), deviceId);

  const hidden = await app.inject({
    method: "GET",
    url: "/api/trips/2026-08-03/live-privacy",
    headers: { cookie: bob.cookie },
  });
  assert.equal(hidden.statusCode, 200);
  assert.equal(hidden.json().device, null);

  ctx.db.prepare("UPDATE dashcam_devices SET show_on_trips = 1 WHERE id = ?").run(deviceId);
  const visible = await app.inject({
    method: "GET",
    url: "/api/trips/2026-08-03/live-privacy",
    headers: { cookie: bob.cookie },
  });
  assert.equal(visible.statusCode, 200);
  assert.deepEqual(visible.json().device, {
    profile_key: "polaroid-ms279wg",
    model: "Polaroid MS279WG",
    nickname: "機車前後鏡頭",
    note: "車身固定安裝",
    show_on_trips: true,
  });

  await app.close();
});
