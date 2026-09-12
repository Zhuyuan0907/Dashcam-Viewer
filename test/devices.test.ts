import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "devices-api-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { makeAdminApp } = await import("./_appctx.js");
const { newSessionToken } = await import("../src/auth.js");
const { SftpSessionManager } = await import("../src/sftp/sessions.js");

const JSON_HEADERS = { "content-type": "application/json" };

function addViewer(db: any, id: number, username: string): string {
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, email, created_at) VALUES (?,?,?,'viewer','',0)",
  ).run(id, username, "h");
  const token = newSessionToken();
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?,?,?,?)")
    .run(token, id, now + 3600, now);
  return `session_token=${token}`;
}

test("多裝置 CRUD、唯一預設值、跨帳號隔離與封存後歷史 session 快照", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  const otherCookie = addViewer(ctx.db, 2, "other");

  const create = (payload: Record<string, unknown>) => app.inject({
    method: "POST",
    url: "/api/account/devices",
    headers: { cookie, ...JSON_HEADERS },
    payload,
  });
  let response = await create({
    profile_key: "mivue-mp20",
    model: "MiVue MP20",
    nickname: "安全帽",
    note: "舊記錄器",
    show_on_trips: true,
  });
  assert.equal(response.statusCode, 201);
  const mivue = response.json().device;
  assert.equal(mivue.is_default, true, "第一台自動成為預設");

  response = await create({
    profile_key: "polaroid-ms279wg",
    model: "Polaroid MS279WG",
    nickname: "機車固定式",
    note: "前後雙鏡頭，固定安裝於機車車身（非安全帽）",
    show_on_trips: true,
    is_default: true,
  });
  assert.equal(response.statusCode, 201);
  const polaroid = response.json().device;

  let list = (await app.inject({ method: "GET", url: "/api/account/devices", headers: { cookie } })).json();
  assert.equal(list.devices.length, 2);
  assert.equal(list.devices.filter((device: any) => device.is_default).length, 1);
  assert.equal(list.devices.find((device: any) => device.id === polaroid.id).is_default, true);

  const forbidden = await app.inject({
    method: "PUT",
    url: `/api/account/devices/${polaroid.id}`,
    headers: { cookie: otherCookie, ...JSON_HEADERS },
    payload: { note: "偷改" },
  });
  assert.equal(forbidden.statusCode, 404);

  response = await app.inject({
    method: "POST",
    url: "/api/upload-sessions",
    headers: { cookie, ...JSON_HEADERS },
    payload: { device_id: polaroid.id },
  });
  assert.equal(response.statusCode, 200);
  const session = response.json();
  assert.equal(session.device.model, "Polaroid MS279WG");

  const rehydrated = new SftpSessionManager(ctx.db).get(session.id);
  assert.equal(rehydrated?.deviceId, polaroid.id);
  assert.equal(rehydrated?.deviceSnapshot?.note, "前後雙鏡頭，固定安裝於機車車身（非安全帽）");

  response = await app.inject({
    method: "DELETE",
    url: `/api/account/devices/${polaroid.id}`,
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200);
  list = (await app.inject({ method: "GET", url: "/api/account/devices", headers: { cookie } })).json();
  assert.equal(list.devices.length, 1);
  assert.equal(list.devices[0].id, mivue.id);
  assert.equal(list.devices[0].is_default, true);
  assert.equal(ctx.sessions.get(session.id)?.deviceSnapshot?.model, "Polaroid MS279WG");

  await ctx.sessions.remove(session.id);
  await app.close();
});

test("新增裝置前建立的工作階段需先選來源才能確認，但仍可正常取消", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  const first = await app.inject({ method: "POST", url: "/api/upload-sessions", headers: { cookie } });
  const second = await app.inject({ method: "POST", url: "/api/upload-sessions", headers: { cookie } });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(first.json().device ?? null, null);

  const created = await app.inject({
    method: "POST",
    url: "/api/account/devices",
    headers: { cookie, ...JSON_HEADERS },
    payload: {
      profile_key: "polaroid-ms279wg",
      model: "Polaroid MS279WG",
      nickname: "機車固定式",
      note: "車身前後雙鏡頭",
      show_on_trips: true,
    },
  });
  assert.equal(created.statusCode, 201);

  const confirm = await app.inject({
    method: "POST",
    url: `/api/upload-sessions/${first.json().id}/confirm`,
    headers: { cookie },
  });
  assert.equal(confirm.statusCode, 400);
  assert.match(confirm.json().detail, /選擇.*行車記錄器/);
  assert.equal(ctx.sessions.get(first.json().id)?.status, "active");

  const cancel = await app.inject({
    method: "DELETE",
    url: `/api/upload-sessions/${second.json().id}`,
    headers: { cookie },
  });
  assert.equal(cancel.statusCode, 200);
  assert.equal(ctx.sessions.get(second.json().id), undefined);

  await ctx.sessions.remove(first.json().id);
  await app.close();
});
