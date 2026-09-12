/**
 * 瀏覽器直傳(HTTP)測試:
 *   - POST /check 檔名預檢(raw / prebuilt / reject / 不安全路徑)
 *   - PUT /files/* 串流寫入(落地內容、計數、覆寫校正)
 *   - 路徑穿越 / .part 副檔名 / 非本人 session / processing 中 → 拒絕
 *   - GET /files 列表、DELETE /files/* 刪除與計數回退
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { PassThrough } from "node:stream";

const DATA = mkdtempSync(path.join(os.tmpdir(), "upload-http-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { makeAdminApp } = await import("./_appctx.js");
const { newSessionToken } = await import("../src/auth.js");

const J = { "content-type": "application/json" };
const BIN = { "content-type": "application/octet-stream" };

async function createSession(app: any, cookie: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/api/upload-sessions", headers: { cookie } });
  assert.equal(r.statusCode, 200);
  return r.json().id;
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

test("POST /check:分類 raw / prebuilt / reject,不安全路徑一律 reject", async () => {
  const { app, cookie } = await makeAdminApp(DATA);
  const sid = await createSession(app, cookie);
  const r = await app.inject({
    method: "POST", url: `/api/upload-sessions/${sid}/check`, headers: { cookie, ...J },
    payload: {
      paths: [
        "FILE260706-120000-000123F.mp4",
        "FILE260706-120000-000123F.NMEA",
        "2026-07-06/front.mp4",
        "not-a-dashcam-file.txt",
        "../etc/passwd",
        "a/../../b.mp4",
      ],
    },
  });
  assert.equal(r.statusCode, 200);
  const acts = new Map(r.json().results.map((x: any) => [x.path, x.action]));
  assert.equal(acts.get("FILE260706-120000-000123F.mp4"), "raw");
  assert.equal(acts.get("FILE260706-120000-000123F.NMEA"), "raw");
  assert.equal(acts.get("2026-07-06/front.mp4"), "prebuilt");
  assert.equal(acts.get("not-a-dashcam-file.txt"), "reject");
  assert.equal(acts.get("../etc/passwd"), "reject");
  assert.equal(acts.get("a/../../b.mp4"), "reject");
  await app.close();
});

test("PUT /files/*:寫入落地、計數累加;覆寫校正計數不重複", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  const sid = await createSession(app, cookie);
  const name = "FILE260706-120000-000123F.mp4";

  const put = (body: string) =>
    app.inject({
      method: "PUT", url: `/api/upload-sessions/${sid}/files/${name}`,
      headers: { cookie, ...BIN }, payload: Buffer.from(body),
    });

  let r = await put("hello-video-bytes");
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().size, 17);
  const onDisk = await fsp.readFile(path.join(DATA, "uploads", sid, name), "utf8");
  assert.equal(onDisk, "hello-video-bytes");

  let s = ctx.sessions.get(sid)!;
  assert.equal(s.fileCount, 1);
  assert.equal(s.totalBytes, 17);

  // 覆寫同名檔:大小改變、檔數不變
  r = await put("xy");
  assert.equal(r.statusCode, 200);
  s = ctx.sessions.get(sid)!;
  assert.equal(s.fileCount, 1, "覆寫不重複計數");
  assert.equal(s.totalBytes, 2, "覆寫後扣掉舊檔大小");

  // 子資料夾(prebuilt 樹)也可寫
  r = await app.inject({
    method: "PUT", url: `/api/upload-sessions/${sid}/files/2026-07-06/front.mp4`,
    headers: { cookie, ...BIN }, payload: Buffer.from("abc"),
  });
  assert.equal(r.statusCode, 200);
  assert.equal(
    await fsp.readFile(path.join(DATA, "uploads", sid, "2026-07-06", "front.mp4"), "utf8"),
    "abc",
  );

  // GET /files 列表
  const list = (
    await app.inject({ method: "GET", url: `/api/upload-sessions/${sid}/files`, headers: { cookie } })
  ).json().files;
  assert.deepEqual(
    list.map((f: any) => f.path).sort(),
    ["2026-07-06/front.mp4", name].sort(),
  );

  // DELETE 檔案 → 計數回退、實體檔移除
  r = await app.inject({
    method: "DELETE", url: `/api/upload-sessions/${sid}/files/${name}`, headers: { cookie },
  });
  assert.equal(r.statusCode, 200);
  s = ctx.sessions.get(sid)!;
  assert.equal(s.fileCount, 1);
  assert.equal(s.totalBytes, 3);
  await assert.rejects(fsp.stat(path.join(DATA, "uploads", sid, name)));
  // 再刪一次 → 404(不重複扣計數)
  r = await app.inject({
    method: "DELETE", url: `/api/upload-sessions/${sid}/files/${name}`, headers: { cookie },
  });
  assert.equal(r.statusCode, 404);

  await app.close();
});

test("PUT /files/*:路徑穿越、.part、他人 session、processing 中 → 拒絕", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  const bob = addViewer(ctx.db, 2, "bob");
  const sid = await createSession(app, cookie);

  // 路徑穿越(URL 編碼的 ../)
  let r = await app.inject({
    method: "PUT", url: `/api/upload-sessions/${sid}/files/..%2Fescape.mp4`,
    headers: { cookie, ...BIN }, payload: Buffer.from("x"),
  });
  assert.equal(r.statusCode, 400);
  await assert.rejects(fsp.stat(path.join(DATA, "uploads", "escape.mp4")), "不可寫出 session 夾");

  // 保留副檔名 .part(避免與暫存檔互撞)
  r = await app.inject({
    method: "PUT", url: `/api/upload-sessions/${sid}/files/a.mp4.part`,
    headers: { cookie, ...BIN }, payload: Buffer.from("x"),
  });
  assert.equal(r.statusCode, 400);

  // 非本人 session → 404(不可探測他人 sid)
  r = await app.inject({
    method: "PUT", url: `/api/upload-sessions/${sid}/files/ok.mp4`,
    headers: { cookie: bob.cookie, ...BIN }, payload: Buffer.from("x"),
  });
  assert.equal(r.statusCode, 404);

  // processing 中 → 400
  ctx.sessions.setStatus(sid, "processing");
  r = await app.inject({
    method: "PUT", url: `/api/upload-sessions/${sid}/files/ok.mp4`,
    headers: { cookie, ...BIN }, payload: Buffer.from("x"),
  });
  assert.equal(r.statusCode, 400);
  ctx.sessions.setStatus(sid, "active");

  await app.close();
});

test("HTTP 傳輸一開始就鎖住工作階段，確認與取消不可穿過非同步寫入", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  const sid = await createSession(app, cookie);
  const body = new PassThrough();
  body.write(Buffer.from("first-chunk"));
  const uploading = app.inject({
    method: "PUT",
    url: `/api/upload-sessions/${sid}/files/FILE260706-120000-000123F.mp4`,
    headers: { cookie, ...BIN },
    payload: body,
  });

  const deadline = Date.now() + 2_000;
  while (ctx.sessions.get(sid)?.conns !== 1 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(ctx.sessions.get(sid)?.conns, 1, "路由進入任何 await 前就應登記傳輸中");

  let r = await app.inject({
    method: "POST",
    url: `/api/upload-sessions/${sid}/confirm`,
    headers: { cookie },
  });
  assert.equal(r.statusCode, 409);
  r = await app.inject({ method: "DELETE", url: `/api/upload-sessions/${sid}`, headers: { cookie } });
  assert.equal(r.statusCode, 409);

  body.end(Buffer.from("-last-chunk"));
  const completed = await uploading;
  assert.equal(completed.statusCode, 200);
  assert.equal(ctx.sessions.get(sid)?.conns, 0);

  r = await app.inject({ method: "DELETE", url: `/api/upload-sessions/${sid}`, headers: { cookie } });
  assert.equal(r.statusCode, 200);
  await assert.rejects(fsp.stat(path.join(DATA, "uploads", sid)));
  await app.close();
});
