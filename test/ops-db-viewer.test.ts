/**
 * 唯讀 DB 檢視器測試:列表 / 分頁 / 未知表拒絕 / 敏感欄位遮蔽。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "ops-db-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { makeAdminApp } = await import("./_appctx.js");

test("GET /api/admin/db/tables 列出表 + 筆數 + 遮蔽欄位", async () => {
  const { app, cookie } = await makeAdminApp(DATA);
  const r = await app.inject({ method: "GET", url: "/api/admin/db/tables", headers: { cookie } });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  const names = j.tables.map((t: { name: string }) => t.name);
  assert.ok(names.includes("users") && names.includes("incidents"), "應含 users / incidents");
  const users = j.tables.find((t: { name: string }) => t.name === "users");
  assert.ok(users.columns.includes("password_hash"));
  assert.ok(users.redacted.includes("password_hash"), "users 應標記 password_hash 為遮蔽");
  assert.equal(typeof users.count, "number");
  await app.close();
});

test("GET /api/admin/db/rows 遮蔽 users.password_hash", async () => {
  const { app, cookie } = await makeAdminApp(DATA);
  const r = await app.inject({
    method: "GET",
    url: "/api/admin/db/rows?table=users",
    headers: { cookie },
  });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.ok(j.rows.length >= 1);
  assert.equal(j.rows[0].password_hash, "••• redacted", "密碼雜湊必須被遮蔽");
  assert.notEqual(j.rows[0].username, "••• redacted", "非敏感欄位不應被遮蔽");
  await app.close();
});

test("GET /api/admin/db/rows 分頁 limit/offset", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  // 塞 3 筆 incidents
  const { recordIncident } = await import("../src/incidents/repo.js");
  for (let i = 0; i < 3; i++) recordIncident(ctx.db, { kind: "merge_failed", title: `e${i}` });
  const r = await app.inject({
    method: "GET",
    url: "/api/admin/db/rows?table=incidents&limit=2&offset=0",
    headers: { cookie },
  });
  const j = r.json();
  assert.equal(j.total, 3);
  assert.equal(j.rows.length, 2);
  assert.equal(j.limit, 2);
  await app.close();
});

test("GET /api/admin/db/rows 未知表回 400", async () => {
  const { app, cookie } = await makeAdminApp(DATA);
  const r = await app.inject({
    method: "GET",
    url: "/api/admin/db/rows?table=sqlite_master",
    headers: { cookie },
  });
  assert.equal(r.statusCode, 400);
  const r2 = await app.inject({
    method: "GET",
    url: "/api/admin/db/rows?table=users;DROP",
    headers: { cookie },
  });
  assert.equal(r2.statusCode, 400);
  await app.close();
});

test("db 檢視端點需要管理員(未登入 401)", async () => {
  const { app } = await makeAdminApp(DATA);
  const r = await app.inject({ method: "GET", url: "/api/admin/db/tables" });
  assert.equal(r.statusCode, 401);
  await app.close();
});
