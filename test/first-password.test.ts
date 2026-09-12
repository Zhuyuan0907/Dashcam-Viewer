/**
 * 「首次登入須改密碼」+ 免密碼建立帳號流程:
 *   - 管理員可建立空密碼 + must_change_password 的帳號
 *   - 該帳號以空白密碼登入成功、回傳 must_change_password:1;非空密碼失敗
 *   - POST /api/account/first-password 設新密碼後清旗標;之後只有新密碼可登入
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "test-firstpw-"));
process.env.DASHCAM_DATA_DIR = DATA;
process.env.DASHCAM_LOGIN_RATE_MAX = "100"; // 測試多次登入,拉高速率上限

const { makeAdminApp } = await import("./_appctx.js");

test("免密碼帳號 + 首次強制改密碼完整流程", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);

  // 1) 建立「勾選須改密碼 + 空密碼」帳號
  const create = await app.inject({
    method: "POST",
    url: "/api/users",
    headers: { cookie, "content-type": "application/json" },
    payload: { username: "alice", password: "", role: "viewer", must_change_password: true },
  });
  assert.equal(create.statusCode, 200);
  const row = ctx.db
    .prepare("SELECT password_hash, must_change_password FROM users WHERE username='alice'")
    .get() as { password_hash: string; must_change_password: number };
  assert.equal(row.must_change_password, 1);
  assert.equal(row.password_hash, "");

  // 2) 空白密碼登入成功、回傳 must_change_password:1
  const loginBlank = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "content-type": "application/json" },
    payload: { username: "alice", password: "" },
  });
  assert.equal(loginBlank.statusCode, 200);
  assert.equal(JSON.parse(loginBlank.body).must_change_password, 1);
  const sess = loginBlank.cookies.find((c) => c.name === "session_token");
  assert.ok(sess, "登入應設定 session cookie");
  const aliceCookie = `session_token=${sess!.value}`;

  // 非空密碼登入失敗
  const loginWrong = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "content-type": "application/json" },
    payload: { username: "alice", password: "whatever" },
  });
  assert.equal(loginWrong.statusCode, 400);

  // 3) 首次設定新密碼 → 清旗標
  const setPw = await app.inject({
    method: "POST",
    url: "/api/account/first-password",
    headers: { cookie: aliceCookie, "content-type": "application/json" },
    payload: { next: "newpass123" },
  });
  assert.equal(setPw.statusCode, 200);
  assert.equal(
    (ctx.db.prepare("SELECT must_change_password FROM users WHERE username='alice'").get() as {
      must_change_password: number;
    }).must_change_password,
    0,
  );

  // 之後:新密碼可登入(must_change_password:0)、空白密碼失效
  const loginNew = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "content-type": "application/json" },
    payload: { username: "alice", password: "newpass123" },
  });
  assert.equal(loginNew.statusCode, 200);
  assert.equal(JSON.parse(loginNew.body).must_change_password, 0);

  const loginBlankAfter = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "content-type": "application/json" },
    payload: { username: "alice", password: "" },
  });
  assert.equal(loginBlankAfter.statusCode, 400);

  // first-password 對已完成的帳號 → 400(旗標為 0)
  const setAgain = await app.inject({
    method: "POST",
    url: "/api/account/first-password",
    headers: { cookie: aliceCookie, "content-type": "application/json" },
    payload: { next: "another123" },
  });
  assert.equal(setAgain.statusCode, 400);

  await app.close();
});

test("未勾選須改密碼時,建立帳號仍需密碼 ≥6", async () => {
  const { app, cookie } = await makeAdminApp(DATA);
  const bad = await app.inject({
    method: "POST",
    url: "/api/users",
    headers: { cookie, "content-type": "application/json" },
    payload: { username: "bob", password: "", role: "viewer" },
  });
  assert.equal(bad.statusCode, 400);
  await app.close();
});
