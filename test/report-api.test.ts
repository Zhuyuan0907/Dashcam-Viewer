/**
 * 檢舉資料草稿 API 測試(PUT /api/trip-clip-report/:clipId):
 *   - 儲存/回讀草稿欄位(plate/location/violation/desc)與長度截斷
 *   - reported 標記:蓋章保留最早時間、可清除、未帶不動
 *   - 授權:非旅程擁有者 403、不存在 404
 *   - /api/clips 帶出 report / reported_at / trip_start_epoch(供前端換算絕對時間)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "report-api-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { makeAdminApp } = await import("./_appctx.js");
const { newSessionToken } = await import("../src/auth.js");
const clipsRepo = await import("../src/clips/repo.js");

const J = { "content-type": "application/json" };

function seedTripRow(db: any, tripId: string, ownerId: number, startEpoch = 1_752_000_000) {
  db.prepare(
    `INSERT INTO trips (trip_id, date, day_order, start_epoch, end_epoch, duration_sec, created_at, owner_id)
     VALUES (?, '2026-07-06', 1, ?, ?, 600, ?, ?)`,
  ).run(tripId, startEpoch, startEpoch + 600, startEpoch, ownerId);
}

function seedClip(db: any, tripId: string): number {
  return clipsRepo.insertClip(db, {
    trip_id: tripId, owner_id: 1, label: "", start_sec: 30, end_sec: 45,
    layout: "front", quality: "fast", main_cam: null,
    file_path: "/x/clip.mp4", size_bytes: 100, duration_sec: 15,
  }).id;
}

function addViewer(db: any, id: number, username: string) {
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, email, created_at) VALUES (?,?,?,'viewer','',0)",
  ).run(id, username, "h");
  const token = newSessionToken();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?,?,?,?)").run(
    token, id, Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000),
  );
  return { id, cookie: `session_token=${token}` };
}

test("報告草稿:儲存、截斷、reported 蓋章/清除", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  seedTripRow(ctx.db, "r1", 1);
  const clipId = seedClip(ctx.db, "r1");

  // 儲存草稿(超長 plate 會被截到 20 字)
  const longPlate = "A".repeat(50);
  let r = await app.inject({
    method: "PUT", url: `/api/trip-clip-report/${clipId}`, headers: { cookie, ...J },
    payload: { plate: longPlate, location: " 中山路口 ", violation: "闖紅燈", desc: "由南往北" },
  });
  assert.equal(r.statusCode, 200);
  let body = r.json();
  assert.equal(body.report.plate, "A".repeat(20), "plate 截斷至 20");
  assert.equal(body.report.location, "中山路口", "去前後空白");
  assert.equal(body.reported_at, null, "未帶 reported 不蓋章");

  // 蓋章
  r = await app.inject({
    method: "PUT", url: `/api/trip-clip-report/${clipId}`, headers: { cookie, ...J },
    payload: { plate: "ABC-1234", reported: true },
  });
  body = r.json();
  const stamp = body.reported_at;
  assert.ok(typeof stamp === "number" && stamp > 0, "reported=true 應寫入時間");

  // 再存一次(不帶 reported)→ 保留原時間戳
  r = await app.inject({
    method: "PUT", url: `/api/trip-clip-report/${clipId}`, headers: { cookie, ...J },
    payload: { plate: "ABC-1234", location: "民族路口", reported: true },
  });
  assert.equal(r.json().reported_at, stamp, "重複蓋章保留最早時間");

  // 清除標記
  r = await app.inject({
    method: "PUT", url: `/api/trip-clip-report/${clipId}`, headers: { cookie, ...J },
    payload: { reported: false },
  });
  assert.equal(r.json().reported_at, null, "reported=false 清除標記");

  await app.close();
});

test("報告草稿:授權(非擁有者 403)與不存在(404)", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  const bob = addViewer(ctx.db, 2, "bob");
  seedTripRow(ctx.db, "r2", 1); // admin 擁有
  const clipId = seedClip(ctx.db, "r2");

  const forbidden = await app.inject({
    method: "PUT", url: `/api/trip-clip-report/${clipId}`, headers: { cookie: bob.cookie, ...J },
    payload: { plate: "X" },
  });
  assert.equal(forbidden.statusCode, 403);

  const notFound = await app.inject({
    method: "PUT", url: "/api/trip-clip-report/99999", headers: { cookie, ...J },
    payload: { plate: "X" },
  });
  assert.equal(notFound.statusCode, 404);

  const badId = await app.inject({
    method: "PUT", url: "/api/trip-clip-report/abc", headers: { cookie, ...J },
    payload: { plate: "X" },
  });
  assert.equal(badId.statusCode, 404);
  await app.close();
});

test("/api/clips 帶出 report / reported_at / trip_start_epoch", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  const startEpoch = 1_760_000_000;
  seedTripRow(ctx.db, "r3", 1, startEpoch);
  const clipId = seedClip(ctx.db, "r3");
  await app.inject({
    method: "PUT", url: `/api/trip-clip-report/${clipId}`, headers: { cookie, ...J },
    payload: { plate: "ABC-1234", violation: "闖紅燈", reported: true },
  });

  const list = (await app.inject({ method: "GET", url: "/api/clips", headers: { cookie } })).json();
  const c = list.find((x: any) => x.id === clipId);
  assert.ok(c, "片段應在清單中");
  assert.equal(c.trip_start_epoch, startEpoch, "帶出旅程起始 epoch 供換算絕對時間");
  assert.equal(c.report.plate, "ABC-1234");
  assert.equal(c.report.violation, "闖紅燈");
  assert.ok(c.reported_at > 0);
  await app.close();
});
