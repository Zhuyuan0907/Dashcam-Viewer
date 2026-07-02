import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "cfgapi-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { makeAdminApp } = await import("./_appctx.js");

test("GET /api/config 公開、形狀正確", async () => {
  const { app } = await makeAdminApp(DATA);
  const r = await app.inject({ method: "GET", url: "/api/config" }); // 無 cookie
  assert.equal(r.statusCode, 200, "公開端點免認證");
  const j = r.json();
  assert.ok(j.brand && j.behavior && j.defaults);
  assert.equal(j.brand.title, "行車記錄");
  assert.equal(j.ui, undefined, "UI 字串不再經 /api/config 外送(改 server-side 注入)");
  await app.close();
});

test("PUT /api/admin/settings 後 GET /api/config 反映變更", async () => {
  const { app, cookie } = await makeAdminApp(DATA);
  const put = await app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    headers: { cookie, "content-type": "application/json" },
    payload: { site_title: "我的行車", units: "mi" },
  });
  assert.equal(put.statusCode, 200);

  const cfg = (await app.inject({ method: "GET", url: "/api/config" })).json();
  assert.equal(cfg.brand.title, "我的行車");
  assert.equal(cfg.behavior.units, "mi");
  await app.close();
});

test("admin 端點未登入回 401", async () => {
  const { app } = await makeAdminApp(DATA);
  const r = await app.inject({ method: "GET", url: "/api/admin/settings" });
  assert.equal(r.statusCode, 401);
  await app.close();
});
