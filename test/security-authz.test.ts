/**
 * 授權/隔離的安全回歸測試(本次審查修復):
 *   A1 一般管理員不得重設 owner / 其他 admin 的密碼(否則竄改後登入接管、提權)。
 *   A3 must_change_password 帳號在改密碼前,除白名單外的 API 一律 403(伺服器端強制)。
 *   A6 /api/trips/stats 只回檢視者可見範圍,不洩漏含私人旅程的全站彙總。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "test-authz-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { makeAdminApp } = await import("./_appctx.js");
const { newSessionToken } = await import("../src/auth.js");

/* eslint-disable @typescript-eslint/no-explicit-any */
function addUser(db: any, id: number, username: string, role: string, isOwner = 0): string {
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, email, created_at, is_owner) VALUES (?,?,?,?,'',0,?)",
  ).run(id, username, "h", role, isOwner);
  const token = newSessionToken();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?,?,?,?)").run(
    token,
    id,
    Math.floor(Date.now() / 1000) + 3600,
    Math.floor(Date.now() / 1000),
  );
  return `session_token=${token}`;
}

function makeOwnerApp() {
  return makeAdminApp(DATA).then(({ app, ctx, cookie }) => {
    ctx.db.prepare("UPDATE users SET is_owner = 1 WHERE id = 1").run();
    return { app, ctx, cookie };
  });
}

test("A1:一般管理員不得重設 owner 或其他 admin 的密碼(可重設 viewer)", async () => {
  const { app, ctx } = await makeOwnerApp(); // id=1 owner
  const adminCookie = addUser(ctx.db, 2, "carol", "admin");
  addUser(ctx.db, 3, "dave", "admin");
  addUser(ctx.db, 4, "erin", "viewer");

  // 重設 owner 密碼 → 403(關鍵提權路徑)
  const resetOwner = await app.inject({
    method: "POST",
    url: "/api/users/1/password",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    payload: { password: "hijacked123" },
  });
  assert.equal(resetOwner.statusCode, 403);

  // 重設另一位 admin 密碼 → 403
  const resetAdmin = await app.inject({
    method: "POST",
    url: "/api/users/3/password",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    payload: { password: "hijacked123" },
  });
  assert.equal(resetAdmin.statusCode, 403);

  // 重設 viewer 密碼 → 200(正常維運)
  const resetViewer = await app.inject({
    method: "POST",
    url: "/api/users/4/password",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    payload: { password: "goodpass123" },
  });
  assert.equal(resetViewer.statusCode, 200);

  await app.close();
});

test("A3:must_change_password 帳號在改密碼前,一般 API 一律 403(first-password 例外)", async () => {
  const { app, ctx } = await makeAdminApp(DATA);
  // 建一個 must_change_password 帳號 + session
  ctx.db
    .prepare(
      "INSERT INTO users (id, username, password_hash, role, email, created_at, must_change_password) VALUES (9,'pending','','viewer','',0,1)",
    )
    .run();
  const token = newSessionToken();
  ctx.db
    .prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?,9,?,?)")
    .run(token, Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000));
  const cookie = `session_token=${token}`;

  // 一般 API(建立上傳工作階段)→ 403(被伺服器端強制擋下,而非僅靠前端導向)
  const blocked = await app.inject({
    method: "POST",
    url: "/api/upload-sessions",
    headers: { cookie },
  });
  assert.equal(blocked.statusCode, 403);

  // first-password(白名單)→ 允許進入(200)
  const setPw = await app.inject({
    method: "POST",
    url: "/api/account/first-password",
    headers: { cookie, "content-type": "application/json" },
    payload: { next: "brandnew123" },
  });
  assert.equal(setPw.statusCode, 200);

  // 改完密碼後 → 一般 API 恢復可用
  const ok = await app.inject({ method: "POST", url: "/api/upload-sessions", headers: { cookie } });
  assert.equal(ok.statusCode, 200);

  await app.close();
});

test("A6:/api/trips/stats 一般使用者只算自己可見的旅程,不含他人私人旅程", async () => {
  const { app, ctx, cookie: adminCookie } = await makeAdminApp(DATA);
  const bobCookie = addUser(ctx.db, 20, "bob", "viewer");
  addUser(ctx.db, 21, "carol", "viewer"); // carol 私人(trips_public 預設 0)

  const mk = (tid: string, owner: number, dur: number) =>
    ctx.db
      .prepare(
        `INSERT INTO trips (trip_id, date, day_order, start_epoch, end_epoch, duration_sec,
           segment_count, emer_count, has_front, has_rear, peak_gforce, gforce_events, created_at, owner_id)
         VALUES (?, '2026-02-02', 1, 0, ?, ?, 1, 0, 1, 1, 0, 0, 0, ?)`,
      )
      .run(tid, dur, dur, owner);
  mk("bob1", 20, 100); // bob 自己的
  mk("carol1", 21, 999); // carol 的私人旅程(bob 不該看到)

  const res = await app.inject({ method: "GET", url: "/api/trips/stats", headers: { cookie: bobCookie } });
  assert.equal(res.statusCode, 200);
  const stats = JSON.parse(res.body);
  assert.equal(stats.total_trips, 1, "bob 只看到自己的 1 趟");
  assert.equal(stats.total_sec, 100, "不含 carol 私人旅程的時長");

  // 管理員(同一 DB 的 id=1)仍看全站(2 趟)
  const resAdmin = await app.inject({ method: "GET", url: "/api/trips/stats", headers: { cookie: adminCookie } });
  const statsAdmin = JSON.parse(resAdmin.body);
  assert.equal(statsAdmin.total_trips, 2, "管理員看到全站 2 趟");

  await app.close();
});
