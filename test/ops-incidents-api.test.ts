/**
 * 維運事件 API 測試:管理員守衛、列表/標記、重試(隔離素材重合)、缺素材拒絕。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";

const DATA = mkdtempSync(path.join(os.tmpdir(), "ops-inc-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { makeAdminApp } = await import("./_appctx.js");
const { newSessionToken } = await import("../src/auth.js");
const { recordIncident, getIncident } = await import("../src/incidents/repo.js");

function hasFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}
function makeMp4(out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      "ffmpeg",
      ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=128x96:rate=10", "-pix_fmt", "yuv420p", "-y", out],
      { stdio: "ignore" },
    );
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
  });
}
/** 在 ctx.db 建一個 viewer 帳號 + session,回傳其 cookie。 */
function viewerCookie(db: import("../src/db.js").DB): string {
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, email, created_at) VALUES (2,'bob','h','viewer','',0)",
  ).run();
  const tok = newSessionToken();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?,2,?,?)").run(
    tok,
    Math.floor(Date.now() / 1000) + 3600,
    Math.floor(Date.now() / 1000),
  );
  return `session_token=${tok}`;
}

const ffmpegOk = await hasFfmpeg();

test("非管理員存取事件 API 回 403", async () => {
  const { app, ctx } = await makeAdminApp(DATA);
  const cookie = viewerCookie(ctx.db);
  const r = await app.inject({ method: "GET", url: "/api/admin/incidents", headers: { cookie } });
  assert.equal(r.statusCode, 403);
  await app.close();
});

test("列表 + 標記已解決", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  const id = recordIncident(ctx.db, { kind: "trip_skipped", title: "壞旅程", detail: "boom" });
  const list = (await app.inject({ method: "GET", url: "/api/admin/incidents", headers: { cookie } })).json();
  assert.equal(list.counts.open, 1);
  assert.ok(list.incidents.find((i: { id: number }) => i.id === id));

  const res = await app.inject({
    method: "POST",
    url: `/api/admin/incidents/${id}/resolve`,
    headers: { cookie, "content-type": "application/json" },
    payload: { status: "dismissed", note: "不重要" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(getIncident(ctx.db, id)!.status, "dismissed");
  await app.close();
});

test("重試:缺隔離素材回 400", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  const id = recordIncident(ctx.db, { kind: "trip_skipped", title: "無素材", quarantine_dir: null });
  const r = await app.inject({ method: "POST", url: `/api/admin/incidents/${id}/retry`, headers: { cookie } });
  assert.equal(r.statusCode, 400);
  await app.close();
});

test(
  "重試:對隔離素材重合成功 → 事件 resolved 且素材移除",
  { skip: ffmpegOk ? false : "系統無 ffmpeg" },
  async () => {
    const { app, ctx, cookie } = await makeAdminApp(DATA);
    // 準備隔離素材:F/R 各一段有效 mp4。
    const qdir = path.join(DATA, "quarantine", "retry-ok");
    const base = "FILE240115-080000-001";
    for (const cam of ["F", "R"] as const) {
      const d = path.join(qdir, cam);
      await fs.mkdir(d, { recursive: true });
      await makeMp4(path.join(d, `${base}${cam}.mp4`));
    }
    const id = recordIncident(ctx.db, {
      kind: "trip_skipped",
      title: "待重試",
      quarantine_dir: qdir,
    });

    const r = await app.inject({ method: "POST", url: `/api/admin/incidents/${id}/retry`, headers: { cookie } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().status, "started");

    // 重試是背景 SSE 流程;輪詢事件狀態直到 resolved(ffmpeg 對迷你片段很快)。
    let resolved = false;
    for (let i = 0; i < 50; i++) {
      await new Promise((res) => setTimeout(res, 100));
      if (getIncident(ctx.db, id)!.status === "resolved") {
        resolved = true;
        break;
      }
    }
    assert.equal(resolved, true, "重試後事件應變 resolved");
    assert.equal(getIncident(ctx.db, id)!.quarantine_dir, null, "成功後素材欄位應清空");
    assert.equal((await fs.stat(qdir).then(() => true).catch(() => false)), false, "素材夾應被刪除");
    // 應在 trips 表產生一趟旅程。
    const trips = ctx.db.prepare("SELECT COUNT(*) AS c FROM trips").get() as { c: number };
    assert.ok(trips.c >= 1);
    await app.close();
  },
);
