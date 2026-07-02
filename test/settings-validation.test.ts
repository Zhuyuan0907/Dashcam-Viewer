import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "setval-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { makeAdminApp } = await import("./_appctx.js");

async function putSettings(app: any, cookie: string, body: Record<string, unknown>) {
  return app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    headers: { cookie, "content-type": "application/json" },
    payload: body,
  });
}

test("拒絕未知設定鍵", async () => {
  const { app, cookie } = await makeAdminApp(DATA);
  const r = await putSettings(app, cookie, { evil_key: 1 });
  assert.equal(r.statusCode, 400);
  await app.close();
});

test("拒絕含 CSS 注入字元的 login_bg", async () => {
  const { app, cookie } = await makeAdminApp(DATA);
  const r = await putSettings(app, cookie, { login_bg: "red; } body{display:none" });
  assert.equal(r.statusCode, 400);
  await app.close();
});

test("拒絕越界整數", async () => {
  const { app, cookie } = await makeAdminApp(DATA);
  assert.equal((await putSettings(app, cookie, { sftp_port: 99999 })).statusCode, 400);
  assert.equal((await putSettings(app, cookie, { default_gap_min: 0 })).statusCode, 400);
  await app.close();
});

test("拒絕 javascript: 連結", async () => {
  const { app, cookie } = await makeAdminApp(DATA);
  const r = await putSettings(app, cookie, {
    links: [{ label: "x", href: "javascript:alert(1)" }],
  });
  assert.equal(r.statusCode, 400);
  await app.close();
});

test("拒絕非圖片 / 過大 data-URL 的 icon", async () => {
  const { app, cookie } = await makeAdminApp(DATA);
  // 非 data:image
  assert.equal((await putSettings(app, cookie, { icon_data_url: "data:text/html;base64,AAAA" })).statusCode, 400);
  // 過大(>256KB 解碼) base64
  const big = "data:image/png;base64," + "A".repeat(400 * 1024);
  assert.equal((await putSettings(app, cookie, { icon_data_url: big })).statusCode, 400);
  await app.close();
});

test("接受合法設定", async () => {
  const { app, cookie } = await makeAdminApp(DATA);
  const r = await putSettings(app, cookie, {
    site_title: "Dash",
    units: "mi",
    sftp_port: 2022,
    default_gap_min: 20,
    links: [{ label: "GitHub", href: "https://github.com/x" }],
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.json()));
  await app.close();
});
