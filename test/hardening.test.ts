/**
 * 2026-07-06 第二輪審查修復的回歸測試:
 *   - DELETE /api/upload-sessions/:id 在 processing / 有連線時拒絕(素材保護)
 *   - upsertTrip 不重置已裁剪旅程的 start/end/duration(rebuild/重匯入座標系保護)
 *   - /api/setup 首位帳號自動成為總管理員(is_owner=1)
 *   - 管理員重設密碼 → 目標帳號既有 session 全數撤銷
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "hardening-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { makeAdminApp } = await import("./_appctx.js");
const { createDb } = await import("../src/db.js");
const { newSessionToken } = await import("../src/auth.js");
const { SftpSessionManager } = await import("../src/sftp/sessions.js");
const { SSERegistry } = await import("../src/uploads/sse.js");
const { SettingsStore } = await import("../src/settings/store.js");
const { JobRegistry } = await import("../src/jobs.js");
const { buildApp } = await import("../src/app.js");
const tripsRepo = await import("../src/trips/repo.js");

const J = { "content-type": "application/json" };

test("取消上傳工作階段:processing / 有連線 → 409,素材不被刪", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  const sid = (await app.inject({ method: "POST", url: "/api/upload-sessions", headers: { cookie } })).json().id;

  ctx.sessions.setStatus(sid, "processing");
  let r = await app.inject({ method: "DELETE", url: `/api/upload-sessions/${sid}`, headers: { cookie } });
  assert.equal(r.statusCode, 409, "處理中不可取消");
  assert.ok(ctx.sessions.get(sid), "session 應仍存在");

  ctx.sessions.setStatus(sid, "active");
  ctx.sessions.connOpened(sid);
  r = await app.inject({ method: "DELETE", url: `/api/upload-sessions/${sid}`, headers: { cookie } });
  assert.equal(r.statusCode, 409, "有連線在傳輸不可取消");

  ctx.sessions.connClosed(sid);
  r = await app.inject({ method: "DELETE", url: `/api/upload-sessions/${sid}`, headers: { cookie } });
  assert.equal(r.statusCode, 200, "閒置時可正常取消");
  await app.close();
});

test("upsertTrip:已裁剪旅程重匯入不得重置起訖/時長(orig_* 與播放檔座標保持一致)", async () => {
  const db = createDb(path.join(DATA, "trim-upsert.db"));
  const info: import("../src/trips/repo.js").TripInfo = {
    trip_id: "t1", date: "2026-07-06", day_order: 1,
    start_epoch: 1000, end_epoch: 1600, duration_sec: 600,
    segment_count: 3, emer_count: 0, has_front: true, has_rear: false,
    front_path: "/x/f.mp4", rear_path: null, peak_gforce: 0, gforce_events: 0,
  };
  tripsRepo.upsertTrip(db, info, "/x");
  // 裁剪成 1100..1400(300 秒)
  tripsRepo.applyTrim(db, "t1", {
    prevStart: 1000, prevEnd: 1600, prevDur: 600,
    newStart: 1100, newEnd: 1400, newDur: 300,
  });
  // rebuild/重匯入會帶「裁剪前」的 info.json 再 upsert 一次
  tripsRepo.upsertTrip(db, info, "/x");
  const row = tripsRepo.getTrip(db, "t1")!;
  assert.equal(row.start_epoch, 1100, "裁剪後座標不得被重匯入蓋回");
  assert.equal(row.end_epoch, 1400);
  assert.equal(row.duration_sec, 300);
  assert.equal(row.orig_start_epoch, 1000, "orig_* 保留");
  assert.equal(row.segment_count, 3, "其餘欄位照常更新");
  // 未裁剪的旅程仍應正常更新座標
  tripsRepo.clearTrim(db, "t1", { start: 1000, end: 1600, dur: 600 });
  tripsRepo.upsertTrip(db, { ...info, start_epoch: 900 }, "/x");
  assert.equal(tripsRepo.getTrip(db, "t1")!.start_epoch, 900);
  db.close();
});

test("/api/setup:首位帳號自動成為總管理員(is_owner=1)", async () => {
  const db = createDb(path.join(DATA, "setup.db"));
  const ctx = {
    db,
    sessions: new SftpSessionManager(db),
    sse: new SSERegistry(),
    settings: new SettingsStore(db),
    jobs: new JobRegistry(),
  };
  const app = await buildApp(ctx);
  const r = await app.inject({
    method: "POST", url: "/api/setup", headers: J,
    payload: { username: "boss", password: "secret123" },
  });
  assert.equal(r.statusCode, 200);
  const row = db.prepare("SELECT is_owner, role FROM users WHERE username='boss'").get() as {
    is_owner: number; role: string;
  };
  assert.equal(row.role, "admin");
  assert.equal(row.is_owner, 1, "首位帳號必須是總管理員,否則 owner-only 操作永遠無人可執行");
  await app.close();
});

test("管理員重設他人密碼 → 目標帳號既有 session 全數撤銷", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  // 建 viewer + 兩個活躍 session
  ctx.db.prepare(
    "INSERT INTO users (id, username, password_hash, role, email, created_at) VALUES (2,'bob','h','viewer','',0)",
  ).run();
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 2; i++) {
    ctx.db.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?,2,?,?)")
      .run(newSessionToken(), now + 3600, now);
  }
  const before = (ctx.db.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id=2").get() as { c: number }).c;
  assert.equal(before, 2);

  const r = await app.inject({
    method: "POST", url: "/api/users/2/password", headers: { cookie, ...J },
    payload: { password: "newpass123" },
  });
  assert.equal(r.statusCode, 200);
  const after = (ctx.db.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id=2").get() as { c: number }).c;
  assert.equal(after, 0, "重設密碼必須撤銷既有登入(奪回帳號控制權)");
  await app.close();
});
