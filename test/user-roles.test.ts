/**
 * 總管理員(owner)角色控管測試:
 *   - owner 可將 viewer 升為 admin、admin 降為 viewer
 *   - 一般管理員不能變更角色(403)
 *   - owner 帳號受保護:不可刪除、不可降級
 *   - 一般管理員不能刪除其他管理員;owner 可以
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "test-roles-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { makeAdminApp } = await import("./_appctx.js");
const { newSessionToken } = await import("../src/auth.js");

/** 建帳號 + session,回傳 cookie。 */
function addUser(db: any, id: number, username: string, role: string, isOwner = 0) {
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

/** makeAdminApp 的預設 admin(id=1)提升為 owner。 */
function makeOwnerApp() {
  return makeAdminApp(DATA).then(({ app, ctx, cookie }) => {
    ctx.db.prepare("UPDATE users SET is_owner = 1 WHERE id = 1").run();
    return { app, ctx, cookie };
  });
}

test("owner 可升降角色;owner 帳號不可被降級/刪除", async () => {
  const { app, ctx, cookie } = await makeOwnerApp();
  addUser(ctx.db, 2, "bob", "viewer");

  // 升為 admin
  const up = await app.inject({
    method: "PUT",
    url: "/api/users/2/role",
    headers: { cookie, "content-type": "application/json" },
    payload: { role: "admin" },
  });
  assert.equal(up.statusCode, 200);
  assert.equal((ctx.db.prepare("SELECT role FROM users WHERE id=2").get() as any).role, "admin");

  // 降回 viewer
  const down = await app.inject({
    method: "PUT",
    url: "/api/users/2/role",
    headers: { cookie, "content-type": "application/json" },
    payload: { role: "viewer" },
  });
  assert.equal(down.statusCode, 200);

  // 不能降級 owner 自己
  const demoteOwner = await app.inject({
    method: "PUT",
    url: "/api/users/1/role",
    headers: { cookie, "content-type": "application/json" },
    payload: { role: "viewer" },
  });
  assert.equal(demoteOwner.statusCode, 403);

  // 不能刪除 owner
  const delOwner = await app.inject({ method: "DELETE", url: "/api/users/1", headers: { cookie } });
  // 刪自己走的是「不能刪自己」400;用另一個帳號刪 owner 才是 403,見下個測試
  assert.equal(delOwner.statusCode, 400);

  await app.close();
});

test("一般管理員不能變更角色 / 不能刪管理員 / 不能刪 owner", async () => {
  const { app, ctx } = await makeOwnerApp(); // id=1 owner
  const adminCookie = addUser(ctx.db, 2, "carol", "admin"); // 一般管理員
  addUser(ctx.db, 3, "dave", "admin"); // 另一位管理員
  const viewerCookie = addUser(ctx.db, 4, "erin", "viewer");
  const viewerUpload = ctx.sessions.create({ id: 4, username: "erin" }, 600);

  // 一般管理員改角色 → 403(需 owner)
  const roleForbidden = await app.inject({
    method: "PUT",
    url: "/api/users/4/role",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    payload: { role: "admin" },
  });
  assert.equal(roleForbidden.statusCode, 403);

  // 一般管理員刪另一位管理員 → 403
  const delAdmin = await app.inject({ method: "DELETE", url: "/api/users/3", headers: { cookie: adminCookie } });
  assert.equal(delAdmin.statusCode, 403);

  // 一般管理員刪 owner → 403
  const delOwner = await app.inject({ method: "DELETE", url: "/api/users/1", headers: { cookie: adminCookie } });
  assert.equal(delOwner.statusCode, 403);

  // 有旅程的帳號不可直接刪除，否則影片會留在磁碟卻從一般 owner 清單消失。
  ctx.db.prepare(
    `INSERT INTO trips
      (trip_id, date, start_epoch, end_epoch, duration_sec, created_at, owner_id)
     VALUES ('erin-trip', '2026-08-03', 1, 2, 1, 1, 4)`,
  ).run();
  const blockedDelete = await app.inject({
    method: "DELETE", url: "/api/users/4", headers: { cookie: adminCookie },
  });
  assert.equal(blockedDelete.statusCode, 409);
  assert.equal(blockedDelete.json().trip_count, 1);
  assert.ok(ctx.sessions.get(viewerUpload.id), "拒絕刪帳號時不可先撤銷其上傳工作階段");

  // 旅程已由管理流程處理後，一般管理員可刪 viewer。
  ctx.db.prepare("DELETE FROM trips WHERE trip_id = 'erin-trip'").run();
  ctx.jobs.registerOwnerProcess(4);
  const retryBlockedDelete = await app.inject({
    method: "DELETE", url: "/api/users/4", headers: { cookie: adminCookie },
  });
  assert.equal(retryBlockedDelete.statusCode, 409, "事件重試期間不可刪除旅程擁有者");
  assert.ok(ctx.sessions.get(viewerUpload.id));
  ctx.jobs.unregisterOwnerProcess(4);
  const originalRemove = ctx.sessions.remove.bind(ctx.sessions);
  let releaseCleanup!: () => void;
  let cleanupStarted!: () => void;
  const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
  ctx.sessions.remove = async (id: string) => {
    await originalRemove(id);
    cleanupStarted();
    await cleanupGate;
  };
  const deleting = app.inject({ method: "DELETE", url: "/api/users/4", headers: { cookie: adminCookie } });
  await started;
  const replacement = await app.inject({
    method: "POST", url: "/api/upload-sessions", headers: { cookie: viewerCookie },
  });
  assert.equal(replacement.statusCode, 409, "刪帳清理期間舊 cookie 不可建立新的上傳憑證");
  releaseCleanup();
  const delViewer = await deleting;
  assert.equal(delViewer.statusCode, 200);
  assert.equal(delViewer.json().revoked_upload_sessions, 1);
  assert.equal(ctx.sessions.get(viewerUpload.id), undefined, "刪帳號後一次性 SFTP 憑證須立即失效");

  // 一般管理員不能新增管理員 → 403
  const createAdmin = await app.inject({
    method: "POST",
    url: "/api/users",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    payload: { username: "newadmin", password: "secret123", role: "admin" },
  });
  assert.equal(createAdmin.statusCode, 403);

  await app.close();
});
