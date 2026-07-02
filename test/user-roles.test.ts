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
  addUser(ctx.db, 4, "erin", "viewer");

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

  // 一般管理員刪 viewer → 200
  const delViewer = await app.inject({ method: "DELETE", url: "/api/users/4", headers: { cookie: adminCookie } });
  assert.equal(delViewer.statusCode, 200);

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
