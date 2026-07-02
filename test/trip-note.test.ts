/**
 * 旅程備註 API 測試:
 *   - 管理員 PUT 寫入 → GET 旅程含 note
 *   - viewer 不能寫(403)
 *   - 空字串清空(GET 回 note: "")
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "test-note-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { makeAdminApp } = await import("./_appctx.js");
const { newSessionToken } = await import("../src/auth.js");

function seedTrip(db: any, tripId = "2026-06-21/1") {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO trips (trip_id, date, day_order, start_epoch, end_epoch, duration_sec, created_at)
     VALUES (?, '2026-06-21', 1, ?, ?, 600, ?)`,
  ).run(tripId, now, now + 600, now);
  return tripId;
}

function addViewer(db: any) {
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, email, created_at) VALUES (2,'bob','h','viewer','',0)",
  ).run();
  const token = newSessionToken();
  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?,2,?,?)",
  ).run(token, Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000));
  return `session_token=${token}`;
}

test("admin can set a note and it appears on the trip", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  const tripId = seedTrip(ctx.db);

  const put = await app.inject({
    method: "PUT",
    url: `/api/trip-note/${tripId}`,
    headers: { cookie, "content-type": "application/json" },
    payload: { note: "下雨天，後鏡頭有水珠" },
  });
  assert.equal(put.statusCode, 200);

  const get = await app.inject({ method: "GET", url: `/api/trips/${tripId}`, headers: { cookie } });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().note, "下雨天，後鏡頭有水珠");
  assert.ok(get.json().note_updated_at > 0);

  await app.close();
});

test("viewer cannot write a note (403) but can read a public trip's note", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  const tripId = seedTrip(ctx.db);
  const viewerCookie = addViewer(ctx.db);
  // 新可見性模型:訪客僅能讀「自己的」或「他人公開的」旅程。
  // 這裡把該趟歸給 admin(id=1)並把 admin 設為公開,讓訪客得以讀取備註。
  ctx.db.prepare("UPDATE trips SET owner_id = 1 WHERE trip_id = ?").run(tripId);
  ctx.db.prepare("UPDATE users SET trips_public = 1 WHERE id = 1").run();

  await app.inject({
    method: "PUT",
    url: `/api/trip-note/${tripId}`,
    headers: { cookie, "content-type": "application/json" },
    payload: { note: "管理員寫的" },
  });

  const forbidden = await app.inject({
    method: "PUT",
    url: `/api/trip-note/${tripId}`,
    headers: { cookie: viewerCookie, "content-type": "application/json" },
    payload: { note: "訪客想寫" },
  });
  assert.equal(forbidden.statusCode, 403);

  const get = await app.inject({ method: "GET", url: `/api/trips/${tripId}`, headers: { cookie: viewerCookie } });
  assert.equal(get.json().note, "管理員寫的");

  await app.close();
});

test("empty note clears it", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  const tripId = seedTrip(ctx.db);

  await app.inject({
    method: "PUT",
    url: `/api/trip-note/${tripId}`,
    headers: { cookie, "content-type": "application/json" },
    payload: { note: "暫時的" },
  });
  await app.inject({
    method: "PUT",
    url: `/api/trip-note/${tripId}`,
    headers: { cookie, "content-type": "application/json" },
    payload: { note: "   " },
  });

  const get = await app.inject({ method: "GET", url: `/api/trips/${tripId}`, headers: { cookie } });
  assert.equal(get.json().note, "");

  await app.close();
});

test("PUT to a missing trip returns 404", async () => {
  const { app, cookie } = await makeAdminApp(DATA);
  const r = await app.inject({
    method: "PUT",
    url: `/api/trip-note/does-not-exist`,
    headers: { cookie, "content-type": "application/json" },
    payload: { note: "x" },
  });
  assert.equal(r.statusCode, 404);
  await app.close();
});
