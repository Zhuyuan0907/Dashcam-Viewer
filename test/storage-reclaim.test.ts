/**
 * 儲存空間回收 API:被合併取代的來源旅程、中斷合併殘留夾、未登錄旅程(只列不刪)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "reclaim-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { makeAdminApp } = await import("./_appctx.js");
const { upsertTrip } = await import("../src/trips/repo.js");
const { TRIPS_DIR } = await import("../src/config.js");

const day = path.join(TRIPS_DIR, "by-user", "1", "by-device", "0", "2026-09-11");
const old = Date.now() / 1000 - 7200;

async function tripDir(name: string, bytes: number, extra: Record<string, string> = {}) {
  const dir = path.join(day, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "前鏡頭.mp4"), Buffer.alloc(bytes, 1));
  for (const [file, body] of Object.entries(extra)) await fs.writeFile(path.join(dir, file), body);
  await fs.utimes(dir, old, old);
  return dir;
}

function trip(id: string, dir: string, start: number) {
  return {
    trip_id: id,
    date: "2026-09-11",
    day_order: 1,
    start_epoch: start,
    end_epoch: start + 60,
    duration_sec: 60,
    segment_count: 1,
    emer_count: 0,
    has_front: true,
    has_rear: false,
    front_path: path.join(dir, "前鏡頭.mp4"),
    rear_path: null,
    peak_gforce: 0,
    gforce_events: 0,
  };
}

test("列出並回收被取代的來源旅程與中斷殘留，保留未登錄旅程", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  const merged = await tripDir("11.43-16.27 (合併)", 300);
  const source = await tripDir("11.43-14.20 (157分)", 200);
  const orphan = await tripDir("16.17-16.53 (36分)", 100);
  const unregistered = await tripDir("21.27-21.59 (32分)", 50, { "info.json": "{}" });
  upsertTrip(ctx.db, trip("merged", merged, 1000), merged, 1);
  upsertTrip(ctx.db, trip("source", source, 1000), source, 1);
  ctx.db.prepare("UPDATE trips SET superseded_by='merged' WHERE trip_id='source'").run();

  const report = await app.inject({ method: "GET", url: "/api/admin/storage/reclaimable", headers: { cookie } });
  assert.equal(report.statusCode, 200);
  const body = report.json() as { items: Array<{ id: string; kind: string; bytes: number; deletable: boolean }> };
  const kinds = Object.fromEntries(body.items.map((i) => [i.kind, i]));
  assert.equal(kinds.superseded?.bytes, 200);
  assert.equal(kinds.superseded?.deletable, true);
  assert.equal(kinds.orphan_dir?.bytes, 100);
  assert.equal(kinds.orphan_dir?.deletable, true);
  assert.equal(kinds.unregistered?.deletable, false);
  assert.equal(body.items.length, 3, "正式旅程不可被列入");

  const unconfirmed = await app.inject({
    method: "POST",
    url: "/api/admin/storage/reclaim",
    headers: { cookie },
    payload: { ids: body.items.map((i) => i.id) },
  });
  assert.equal(unconfirmed.statusCode, 400);

  const res = await app.inject({
    method: "POST",
    url: "/api/admin/storage/reclaim",
    headers: { cookie },
    payload: { ids: body.items.map((i) => i.id), confirm_delete: true },
  });
  const results = (res.json() as { results: Array<{ deleted: boolean }> }).results;
  assert.equal(results.filter((r) => r.deleted).length, 2);
  await assert.rejects(fs.stat(source));
  await assert.rejects(fs.stat(orphan));
  assert.ok((await fs.stat(merged)).isDirectory(), "合併後的旅程必須保留");
  assert.ok((await fs.stat(unregistered)).isDirectory(), "未登錄旅程只能重建，不可刪除");
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM trips WHERE trip_id='source'").get().n, 0);
  await app.close();
});

test("合併旅程影片缺失時保留來源旅程", async () => {
  await fs.rm(TRIPS_DIR, { recursive: true, force: true });
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  const merged = path.join(day, "missing (合併)");
  const source = await tripDir("08.00-09.00 (60分)", 10);
  upsertTrip(ctx.db, trip("merged2", merged, 2000), merged, 1);
  upsertTrip(ctx.db, trip("source2", source, 2000), source, 1);
  ctx.db.prepare("UPDATE trips SET superseded_by='merged2' WHERE trip_id='source2'").run();
  const report = (
    await app.inject({ method: "GET", url: "/api/admin/storage/reclaimable", headers: { cookie } })
  ).json() as { items: Array<{ kind: string; deletable: boolean }> };
  assert.deepEqual(
    report.items.map((i) => [i.kind, i.deletable]),
    [["superseded", false]],
  );
  await app.close();
});

test("非管理員不可使用儲存回收 API", async () => {
  const { app, ctx } = await makeAdminApp(DATA);
  ctx.db
    .prepare(
      "INSERT INTO users (id, username, password_hash, role, email, created_at) VALUES (2,'bob','h','viewer','',0)",
    )
    .run();
  ctx.db
    .prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES ('v',2,?,0)")
    .run(Math.floor(Date.now() / 1000) + 3600);
  const res = await app.inject({
    method: "GET",
    url: "/api/admin/storage/reclaimable",
    headers: { cookie: "session_token=v" },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});
