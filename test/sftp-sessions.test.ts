import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import { mkdtempSync, existsSync } from "node:fs";
import path from "node:path";

const DATA = mkdtempSync(path.join(os.tmpdir(), "sftpsess-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { createDb } = await import("../src/db.js");
const { SftpSessionManager } = await import("../src/sftp/sessions.js");
const { UPLOAD_DIR } = await import("../src/config.js");

let dbSeq = 0;
function setup() {
  const db = createDb(path.join(DATA, `t${dbSeq++}.db`));
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, email, created_at) VALUES (1,'alice','h','admin','',0)",
  ).run();
  return new SftpSessionManager(db);
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

test("create 建立資料夾、username 格式、idleSec、listForUser 範圍", () => {
  const mgr = setup();
  const s = mgr.create({ id: 1, username: "alice" }, 600);
  assert.match(s.id, /^[0-9a-f]{8}$/);
  assert.ok(s.password.length >= 16);
  assert.equal(s.idleSec, 600);
  assert.ok(existsSync(path.join(UPLOAD_DIR, s.id)), "應建立 session 資料夾");
  assert.equal(mgr.sftpUsername(s), `alice.${s.id}`);
  assert.equal(mgr.listForUser(1).length, 1);
  assert.equal(mgr.listForUser(2).length, 0, "不應看到別人的 session");
});

test("findExpired:逐 session idle、有連線不回收、processing 給寬限、不限時(0)不回收", () => {
  const mgr = setup();
  const s = mgr.create({ id: 1, username: "alice" }, 600);

  // 閒置超過自身 idleSec → 回收
  mgr.get(s.id)!.lastActivity = nowSec() - 700;
  assert.deepEqual(mgr.findExpired(), [s.id], "無連線且閒置超門檻應回收");

  mgr.connOpened(s.id); // 會把 lastActivity 設為 now
  assert.deepEqual(mgr.findExpired(), [], "有進行中連線不應回收");
  mgr.connClosed(s.id);
  mgr.get(s.id)!.lastActivity = nowSec() - 700;
  assert.deepEqual(mgr.findExpired(), [s.id]);

  // processing 殘留:給 max(idleSec*4,3600) 寬限;短閒置不回收
  mgr.setStatus(s.id, "processing");
  mgr.get(s.id)!.lastActivity = nowSec() - 700;
  assert.deepEqual(mgr.findExpired(), [], "processing 短閒置不應回收");

  // 不限時(idleSec=0)的 active 永不回收,即使閒置很久
  mgr.setStatus(s.id, "active");
  mgr.get(s.id)!.idleSec = 0;
  mgr.get(s.id)!.lastActivity = nowSec() - 999999;
  assert.deepEqual(mgr.findExpired(), [], "不限時的 active 不應回收");
});

test("touch 累加檔數/位元組;remove 刪資料夾與列", async () => {
  const mgr = setup();
  const s = mgr.create({ id: 1, username: "alice" }, 600);
  mgr.touch(s.id, { bytes: 1000, files: 2 });
  mgr.touch(s.id, { bytes: 500, files: 1 });
  const got = mgr.get(s.id)!;
  assert.equal(got.totalBytes, 1500);
  assert.equal(got.fileCount, 3);

  await mgr.remove(s.id);
  assert.equal(mgr.get(s.id), undefined);
  assert.equal(mgr.listForUser(1).length, 0);
  assert.ok(!existsSync(path.join(UPLOAD_DIR, s.id)), "資料夾應被刪除");
});

test("rehydrate:新 manager 從 DB 載回既有 session", () => {
  const db = createDb(path.join(DATA, "rehydrate.db"));
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, email, created_at) VALUES (1,'bob','h','admin','',0)",
  ).run();
  const m1 = new SftpSessionManager(db);
  const s = m1.create({ id: 1, username: "bob" }, 600);

  const m2 = new SftpSessionManager(db); // 模擬重啟
  const got = m2.get(s.id);
  assert.ok(got, "重啟後仍應看到 session");
  assert.equal(got!.conns, 0, "重啟後連線數歸零");
});

test("beginRevokeForUser:傳輸中拒絕；刪帳臨界區阻止建立新憑證", async () => {
  const mgr = setup();
  const first = mgr.create({ id: 1, username: "alice" }, 600);
  const second = mgr.create({ id: 1, username: "alice" }, 600);
  mgr.connOpened(first.id);

  assert.deepEqual(await mgr.beginRevokeForUser(1), { ok: false, removed: 0 });
  assert.ok(mgr.get(first.id));
  assert.ok(mgr.get(second.id));

  mgr.connClosed(first.id);
  assert.deepEqual(await mgr.beginRevokeForUser(1), { ok: true, removed: 2 });
  assert.equal(mgr.get(first.id), undefined);
  assert.equal(mgr.get(second.id), undefined);
  assert.ok(!existsSync(path.join(UPLOAD_DIR, first.id)));
  assert.ok(!existsSync(path.join(UPLOAD_DIR, second.id)));
  assert.throws(
    () => mgr.create({ id: 1, username: "alice" }, 600),
    /帳號正在刪除/,
    "檔案清理完成到 users 列刪除前仍不可建立新憑證",
  );
  mgr.finishRevokeForUser(1);
  assert.ok(mgr.create({ id: 1, username: "alice" }, 600));
});
