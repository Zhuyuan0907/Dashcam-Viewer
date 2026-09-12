/**
 * 匯出片段(trip_clips)測試:
 *   1) buildClipArgs 純函式(三種模式的 ffmpeg 參數形狀 + 守衛),不 spawn ffmpeg
 *   2) clips/repo CRUD + FK ON DELETE CASCADE(隨旅程刪除一併清空)
 *   3) 路由授權/驗證(app.inject,只走拒絕/授權路徑 + 直接以 SQL 種入片段驗證 list/delete/download)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { mkdtempSync } from "node:fs";

// 測試資料目錄:務必在載入任何 src 模組(config.ts 於 import 時讀 env)之前設定,
// 否則 TRIPS_DIR / withinTrips 會綁到預設路徑,導致下載測試因沙箱檢查而 404。
const DATA = mkdtempSync(path.join(os.tmpdir(), "clips-api-"));
process.env.DASHCAM_DATA_DIR = DATA;

// ── (1) buildClipArgs 純函式 ─────────────────────────────────────────────────
const { buildClipArgs } = await import("../src/media/ffmpeg.js");

test("buildClipArgs:front 精確 = libx264 重編碼,-ss 在 -i 前,無 filter", () => {
  const a = buildClipArgs({
    mainInput: "/m.mp4", output: "/o.mp4", startSec: 5, durSec: 10, layout: "front", quality: "precise",
  });
  assert.equal(a[0], "-y");
  assert.ok(a.indexOf("-ss") < a.indexOf("-i"), "-ss 應在 -i 前");
  assert.ok(a.includes("libx264"));
  assert.ok(!a.includes("copy"), "精確模式不應是 -c copy");
  assert.ok(!a.includes("-filter_complex"));
  assert.equal(a[a.length - 1], "/o.mp4");
});

test("buildClipArgs:front 快速 = -c copy 無損 remux,非 libx264", () => {
  const a = buildClipArgs({
    mainInput: "/m.mp4", output: "/o.mp4", startSec: 0, durSec: 8, layout: "front", quality: "fast",
  });
  assert.ok(a.includes("copy"));
  assert.ok(!a.includes("libx264"));
  assert.ok(a.indexOf("-ss") < a.indexOf("-i"));
});

test("buildClipArgs:rear 精確用給定的 rear 來源", () => {
  const a = buildClipArgs({
    mainInput: "/rear.mp4", output: "/o.mp4", startSec: 1, durSec: 2, layout: "rear", quality: "precise",
  });
  assert.ok(a.includes("/rear.mp4"));
  assert.ok(a.includes("libx264"));
});

test("buildClipArgs:pip = 雙輸入 overlay(兩個 -ss/-i、右上角小窗、可選音訊、偶數縮放)", () => {
  const p = buildClipArgs({
    mainInput: "/m.mp4", pipInput: "/p.mp4", output: "/o.mp4",
    startSec: 5, durSec: 10, layout: "pip", quality: "precise",
  });
  assert.equal(p.filter((x) => x === "-ss").length, 2, "pip 兩路各一個 -ss");
  assert.equal(p.filter((x) => x === "-i").length, 2, "pip 兩路輸入");
  const fc = p[p.indexOf("-filter_complex") + 1];
  assert.ok(fc.includes("overlay=W-w-24:24"), "右上內縮 24px");
  assert.ok(fc.includes("trunc(iw/6)*2"), "偶數維度縮放");
  assert.ok(fc.includes("format=yuv420p"), "保證可播像素格式");
  assert.ok(p.includes("[v]") && p.includes("0:a?"), "映射合成視訊 + 可選主畫面音訊");
  assert.ok(p.includes("libx264"));
});

test("buildClipArgs:pip 拒絕快速模式、且必須有第二路輸入", () => {
  assert.throws(() =>
    buildClipArgs({
      mainInput: "/m.mp4", pipInput: "/p.mp4", output: "/o.mp4",
      startSec: 0, durSec: 5, layout: "pip", quality: "fast",
    }),
  );
  assert.throws(() =>
    buildClipArgs({
      mainInput: "/m.mp4", output: "/o.mp4",
      startSec: 0, durSec: 5, layout: "pip", quality: "precise",
    }),
  );
});

// ── (2) clips/repo CRUD + FK CASCADE ─────────────────────────────────────────
const { createDb } = await import("../src/db.js");
const clipsRepo = await import("../src/clips/repo.js");
const tripsRepo = await import("../src/trips/repo.js");

function seedTripInfo(tripId: string): tripsRepo.TripInfo {
  return {
    trip_id: tripId, date: "2026-07-04", day_order: 1,
    start_epoch: 1_000, end_epoch: 1_600, duration_sec: 600,
    segment_count: 1, emer_count: 0, has_front: true, has_rear: true,
    front_path: null, rear_path: null, peak_gforce: 0, gforce_events: 0,
  };
}

function newClip(tripId: string, over: Partial<clipsRepo.NewClip> = {}): clipsRepo.NewClip {
  return {
    trip_id: tripId, owner_id: 1, label: "", start_sec: 0, end_sec: 5,
    layout: "front", quality: "precise", main_cam: null,
    file_path: "/x/clip.mp4", size_bytes: 100, duration_sec: 5, ...over,
  };
}

test("clips/repo:insert / get / list(DESC) / delete", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "clips-repo-"));
  const db = createDb(path.join(dir, "t.db"));
  tripsRepo.upsertTrip(db, seedTripInfo("t1"), path.join(dir, "t1"));

  const c1 = clipsRepo.insertClip(db, newClip("t1", { label: "a" }));
  assert.ok(c1.id > 0);
  assert.equal(c1.label, "a");
  assert.equal(clipsRepo.getClip(db, c1.id)!.trip_id, "t1");

  const c2 = clipsRepo.insertClip(db, newClip("t1", { label: "b", layout: "pip", main_cam: "front" }));
  const list = clipsRepo.listClipsForTrip(db, "t1");
  assert.equal(list.length, 2);
  assert.equal(list[0]!.id, c2.id, "最新的排在最前(DESC)");

  clipsRepo.deleteClipRow(db, c1.id);
  assert.equal(clipsRepo.getClip(db, c1.id), null);
  assert.equal(clipsRepo.listClipsForTrip(db, "t1").length, 1);

  db.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

test("clips/repo:刪除旅程 → 片段列 FK CASCADE 一併清除", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "clips-fk-"));
  const db = createDb(path.join(dir, "t.db"));
  const tripDir = path.join(dir, "trip");
  await fsp.mkdir(tripDir, { recursive: true });
  tripsRepo.upsertTrip(db, seedTripInfo("t1"), tripDir);
  clipsRepo.insertClip(db, newClip("t1"));
  clipsRepo.insertClip(db, newClip("t1"));
  assert.equal(clipsRepo.listClipsForTrip(db, "t1").length, 2);

  await tripsRepo.deleteTrip(db, "t1");
  assert.equal(clipsRepo.listClipsForTrip(db, "t1").length, 0, "CASCADE 應清空片段");

  db.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

// ── (3) 路由授權/驗證(app.inject);DATA / env 已在檔案最上方設定 ─────────────
const { makeAdminApp } = await import("./_appctx.js");
const { newSessionToken } = await import("../src/auth.js");

function seedTripRow(db: any, tripId: string, ownerId: number, durationSec = 600) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO trips (trip_id, date, day_order, start_epoch, end_epoch, duration_sec, created_at, owner_id)
     VALUES (?, '2026-07-04', 1, ?, ?, ?, ?, ?)`,
  ).run(tripId, now, now + durationSec, durationSec, now, ownerId);
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
const J = { "content-type": "application/json" };

test("POST /api/trip-clips:非擁有者 → 403;不存在的旅程 → 404", async () => {
  const { app, ctx } = await makeAdminApp(DATA);
  const bob = addViewer(ctx.db, 2, "bob");
  seedTripRow(ctx.db, "c1", 1); // admin 擁有

  const forbidden = await app.inject({
    method: "POST", url: "/api/trip-clips/c1", headers: { cookie: bob.cookie, ...J },
    payload: { start: 0, end: 5, layout: "front", quality: "precise" },
  });
  assert.equal(forbidden.statusCode, 403);

  const notFound = await app.inject({
    method: "POST", url: "/api/trip-clips/nope", headers: { cookie: bob.cookie, ...J },
    payload: { start: 0, end: 5, layout: "front", quality: "precise" },
  });
  assert.equal(notFound.statusCode, 404);
  await app.close();
});

test("POST /api/trip-clips:各種無效輸入 → 400(皆在 spawn 前擋下)", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  seedTripRow(ctx.db, "c1", 1, 600);
  const post = (payload: any) =>
    app.inject({ method: "POST", url: "/api/trip-clips/c1", headers: { cookie, ...J }, payload });

  assert.equal((await post({ start: 5, end: 5, layout: "front", quality: "precise" })).statusCode, 400, "end<=start");
  assert.equal((await post({ start: 0, end: 0.5, layout: "front", quality: "precise" })).statusCode, 400, "不足 1 秒");
  assert.equal((await post({ start: 0, end: 999, layout: "front", quality: "precise" })).statusCode, 400, "超出長度");
  assert.equal((await post({ start: 0, end: 5, layout: "bogus", quality: "precise" })).statusCode, 400, "版面錯誤");
  assert.equal((await post({ start: 0, end: 5, layout: "front", quality: "bogus" })).statusCode, 400, "畫質錯誤");
  assert.equal((await post({ start: 0, end: 5, layout: "pip", quality: "fast" })).statusCode, 400, "pip 不支援 fast");
  // 合法範圍但旅程無來源鏡頭(front_path 為 NULL)→ 400(仍不會 spawn ffmpeg)
  assert.equal((await post({ start: 0, end: 5, layout: "front", quality: "precise" })).statusCode, 400, "無來源鏡頭");
  await app.close();
});

test("GET /api/trip-clip-events/<未知 job> → 404", async () => {
  const { app, cookie } = await makeAdminApp(DATA);
  const r = await app.inject({
    method: "GET", url: "/api/trip-clip-events/00000000-0000-0000-0000-000000000000",
    headers: { cookie },
  });
  assert.equal(r.statusCode, 404);
  await app.close();
});

test("list / download / delete + 路由排序不互撞", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  const bob = addViewer(ctx.db, 2, "bob");
  seedTripRow(ctx.db, "c1", 1);

  // 空清單 200 [](證明 GET /api/trip-clips/* 命中列表 handler,未被下載/事件路由攔截)
  const empty = await app.inject({ method: "GET", url: "/api/trip-clips/c1", headers: { cookie } });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), []);

  // 下載不存在片段 → 404(證明 /api/trip-clip-download/:id 是另一個 handler,無 radix 衝突)
  const dl404 = await app.inject({ method: "GET", url: "/api/trip-clip-download/999", headers: { cookie } });
  assert.equal(dl404.statusCode, 404);

  // 直接以 SQL 種入一個片段(真實檔案落在 TRIPS_DIR 內以通過 withinTrips)
  const filePath = path.join(DATA, "trips", "c1-clip.mp4");
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, "FAKEMP4DATA");
  const now = Math.floor(Date.now() / 1000);
  const info = ctx.db
    .prepare(
      `INSERT INTO trip_clips (trip_id, owner_id, label, start_sec, end_sec, layout, quality, file_path, size_bytes, duration_sec, created_at)
       VALUES ('c1', 1, 'demo', 0, 5, 'front', 'precise', ?, 11, 5, ?)`,
    )
    .run(filePath, now);
  const clipId = Number(info.lastInsertRowid);
  const rename = (auth:string,label:unknown)=>app.inject({method:'PATCH',url:`/api/trip-clip/${clipId}`,headers:{cookie:auth},payload:{label}});
  assert.equal((await rename(bob.cookie,'not yours')).statusCode,404);
  assert.equal((await rename(cookie,'x'.repeat(121))).statusCode,400);
  assert.equal((await rename(cookie,'New label')).statusCode,200);
  const search = await app.inject({method:'GET',url:'/api/clips?q=New&limit=1',headers:{cookie}});
  assert.equal(search.json()[0].label,'New label');
  assert.equal((await app.inject({method:'GET',url:'/api/clips?offset=1',headers:{cookie}})).json().length,0);

  // 列表回傳該片段,但不外洩絕對 file_path
  const list = await app.inject({ method: "GET", url: "/api/trip-clips/c1", headers: { cookie } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 1);
  assert.equal(list.json()[0].file_path, undefined, "不應外洩絕對路徑");

  // 非擁有者不可列出 / 下載 / 刪除
  assert.equal((await app.inject({ method: "GET", url: "/api/trip-clips/c1", headers: { cookie: bob.cookie } })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: `/api/trip-clip-download/${clipId}`, headers: { cookie: bob.cookie } })).statusCode, 403);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/trip-clip/${clipId}`, headers: { cookie: bob.cookie } })).statusCode, 403);

  // 擁有者下載 → 200 attachment
  const dl = await app.inject({ method: "GET", url: `/api/trip-clip-download/${clipId}`, headers: { cookie } });
  assert.equal(dl.statusCode, 200);
  assert.equal(dl.headers["content-type"], "video/mp4");
  assert.ok(String(dl.headers["content-disposition"]).includes("attachment"));

  // 擁有者刪除 → 200,檔案移除、列表清空
  const del = await app.inject({ method: "DELETE", url: `/api/trip-clip/${clipId}`, headers: { cookie } });
  assert.equal(del.statusCode, 200);
  assert.equal(fs.existsSync(filePath), false, "檔案應被刪除");
  assert.equal((await app.inject({ method: "GET", url: "/api/trip-clips/c1", headers: { cookie } })).json().length, 0);
  await app.close();
});
