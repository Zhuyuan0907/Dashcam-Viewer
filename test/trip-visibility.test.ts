/**
 * 旅程可見性 / 擁有權測試:
 *   - 訪客只看得到自己的 + 他人公開的旅程(dates / 單一 trip / 影片存取)
 *   - 私人旅程對非擁有者一律 404(不洩露存在)
 *   - 管理員可見全部
 *   - /api/trip-owners 依可見性列出可選擁有者
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "test-vis-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { makeAdminApp } = await import("./_appctx.js");
const { newSessionToken } = await import("../src/auth.js");

/** 建一趟旅程,指定擁有者。 */
function seedTrip(db: any, tripId: string, ownerId: number, date = "2026-06-21") {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO trips (trip_id, date, day_order, start_epoch, end_epoch, duration_sec, created_at, owner_id)
     VALUES (?, ?, 1, ?, ?, 600, ?, ?)`,
  ).run(tripId, date, now, now + 600, now, ownerId);
  return tripId;
}

/** 建一個 viewer 帳號 + session,回傳 { id, cookie }。 */
function addViewer(db: any, id: number, username: string, isPublic = 0) {
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, email, created_at, trips_public) VALUES (?,?,?,'viewer','',0,?)",
  ).run(id, username, "h", isPublic);
  const token = newSessionToken();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?,?,?,?)").run(
    token,
    id,
    Math.floor(Date.now() / 1000) + 3600,
    Math.floor(Date.now() / 1000),
  );
  return { id, cookie: `session_token=${token}` };
}

test("訪客看不到他人的私人旅程(dates 為空、單趟 404、影片 404)", async () => {
  const { app, ctx } = await makeAdminApp(DATA);
  const alice = addViewer(ctx.db, 2, "alice"); // 私人
  const bob = addViewer(ctx.db, 3, "bob");
  seedTrip(ctx.db, "2026-06-21/1", alice.id);

  // bob 以 owner=alice 查詢 → 403(無權)
  const datesForbidden = await app.inject({
    method: "GET",
    url: `/api/trips/dates?owner=${alice.id}`,
    headers: { cookie: bob.cookie },
  });
  assert.equal(datesForbidden.statusCode, 403);

  // bob 直接猜 tripId → 404
  const trip = await app.inject({
    method: "GET",
    url: `/api/trips/2026-06-21/1`,
    headers: { cookie: bob.cookie },
  });
  assert.equal(trip.statusCode, 404);

  // bob 猜影片路徑 → 404
  const video = await app.inject({
    method: "GET",
    url: `/video/2026-06-21%2F1/front`,
    headers: { cookie: bob.cookie },
  });
  assert.equal(video.statusCode, 404);

  await app.close();
});

test("公開旅程:他人可讀、且出現在 trip-owners 選單", async () => {
  const { app, ctx } = await makeAdminApp(DATA);
  const alice = addViewer(ctx.db, 2, "alice", 1); // 公開
  const bob = addViewer(ctx.db, 3, "bob");
  seedTrip(ctx.db, "2026-06-21/1", alice.id);

  const dates = await app.inject({
    method: "GET",
    url: `/api/trips/dates?owner=${alice.id}`,
    headers: { cookie: bob.cookie },
  });
  assert.equal(dates.statusCode, 200);
  assert.equal(dates.json().length, 1);

  // bob 的 owner 選單應包含 alice(公開)
  const owners = await app.inject({ method: "GET", url: `/api/trip-owners`, headers: { cookie: bob.cookie } });
  const names = owners.json().map((o: any) => o.username);
  assert.ok(names.includes("alice"));

  await app.close();
});

test("管理員可見任何人的旅程", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  const alice = addViewer(ctx.db, 2, "alice"); // 私人
  seedTrip(ctx.db, "2026-06-21/1", alice.id);

  const trip = await app.inject({
    method: "GET",
    url: `/api/trips/2026-06-21/1`,
    headers: { cookie }, // admin cookie
  });
  assert.equal(trip.statusCode, 200);

  const dates = await app.inject({
    method: "GET",
    url: `/api/trips/dates?owner=${alice.id}`,
    headers: { cookie },
  });
  assert.equal(dates.statusCode, 200);
  assert.equal(dates.json().length, 1);

  await app.close();
});

test("public_override:公開帳號可單獨隱藏某趟(override=0)", async () => {
  const { app, ctx } = await makeAdminApp(DATA);
  const alice = addViewer(ctx.db, 2, "alice", 1); // 帳號公開
  const bob = addViewer(ctx.db, 3, "bob");
  seedTrip(ctx.db, "2026-06-22/1", alice.id, "2026-06-22"); // 可見
  seedTrip(ctx.db, "2026-06-22/2", alice.id, "2026-06-22"); // 待隱藏
  ctx.db.prepare("UPDATE trips SET public_override = 0 WHERE trip_id = ?").run("2026-06-22/2");

  // bob 看該日:只剩 1 趟(隱藏的不計)
  const trips = await app.inject({
    method: "GET",
    url: `/api/trips?date=2026-06-22&owner=${alice.id}`,
    headers: { cookie: bob.cookie },
  });
  assert.equal(trips.statusCode, 200);
  assert.equal(trips.json().trips.length, 1);
  assert.equal(trips.json().trips[0].trip_id, "2026-06-22/1");

  // 直連被隱藏那趟 → 404;影片亦 404
  const hidden = await app.inject({ method: "GET", url: `/api/trips/2026-06-22/2`, headers: { cookie: bob.cookie } });
  assert.equal(hidden.statusCode, 404);
  const vid = await app.inject({ method: "GET", url: `/video/2026-06-22%2F2/front`, headers: { cookie: bob.cookie } });
  assert.equal(vid.statusCode, 404);

  await app.close();
});

test("public_override:私人帳號可單獨公開某趟(override=1)", async () => {
  const { app, ctx } = await makeAdminApp(DATA);
  const alice = addViewer(ctx.db, 2, "alice", 0); // 帳號私人
  const bob = addViewer(ctx.db, 3, "bob");
  seedTrip(ctx.db, "2026-06-23/1", alice.id, "2026-06-23");
  ctx.db.prepare("UPDATE trips SET public_override = 1 WHERE trip_id = ?").run("2026-06-23/1");

  // bob 可見該趟、alice 出現在 owner 選單
  const trip = await app.inject({ method: "GET", url: `/api/trips/2026-06-23/1`, headers: { cookie: bob.cookie } });
  assert.equal(trip.statusCode, 200);
  const owners = await app.inject({ method: "GET", url: `/api/trip-owners`, headers: { cookie: bob.cookie } });
  assert.ok(owners.json().some((o: any) => o.username === "alice"));

  await app.close();
});

test("canEditTrip:非擁有者/非管理員不能設定可見性或裁剪(403)", async () => {
  const { app, ctx } = await makeAdminApp(DATA);
  const alice = addViewer(ctx.db, 2, "alice", 1);
  const bob = addViewer(ctx.db, 3, "bob");
  seedTrip(ctx.db, "2026-06-24/1", alice.id, "2026-06-24");

  const vis = await app.inject({
    method: "PUT",
    url: `/api/trip-visibility/2026-06-24/1`,
    headers: { cookie: bob.cookie, "content-type": "application/json" },
    payload: { override: 0 },
  });
  assert.equal(vis.statusCode, 403);

  const trim = await app.inject({
    method: "POST",
    url: `/api/trip-trim/2026-06-24/1`,
    headers: { cookie: bob.cookie, "content-type": "application/json" },
    payload: { start: 0, end: 10 },
  });
  assert.equal(trim.statusCode, 403);

  // 擁有者可設定可見性
  const ok = await app.inject({
    method: "PUT",
    url: `/api/trip-visibility/2026-06-24/1`,
    headers: { cookie: alice.cookie, "content-type": "application/json" },
    payload: { override: 0 },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal((ctx.db.prepare("SELECT public_override o FROM trips WHERE trip_id=?").get("2026-06-24/1") as any).o, 0);

  await app.close();
});
