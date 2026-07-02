/**
 * incidents repo 測試:記錄 / 列表 / 詳情 / 標記 / 隔離素材逾期清理。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "inc-repo-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { createDb } = await import("../src/db.js");
const {
  recordIncident,
  listIncidents,
  getIncident,
  resolveIncident,
  incidentCounts,
  sweepQuarantine,
} = await import("../src/incidents/repo.js");

function freshDb() {
  return createDb(path.join(DATA, `inc${Math.random().toString(36).slice(2)}.db`));
}

test("record / list / counts / get / resolve", () => {
  const db = freshDb();
  const id = recordIncident(db, {
    session_id: "s1",
    kind: "trip_skipped",
    severity: "error",
    trip_label: "2026-06-17 21:06～22:16",
    title: "旅程合併失敗",
    detail: "前鏡頭:moov atom not found",
    context: { segment_count: 22 },
  });
  assert.ok(id > 0);

  const open = listIncidents(db, { status: "open" });
  assert.equal(open.total, 1);
  assert.equal(open.rows[0]!.title, "旅程合併失敗");

  const counts = incidentCounts(db);
  assert.equal(counts.open, 1);
  assert.equal(counts.total, 1);

  const got = getIncident(db, id)!;
  assert.equal(got.kind, "trip_skipped");
  assert.equal(JSON.parse(got.context_json).segment_count, 22);

  resolveIncident(db, id, { status: "resolved", userId: 1, resolution: "已重試" });
  assert.equal(getIncident(db, id)!.status, "resolved");
  assert.equal(listIncidents(db, { status: "open" }).total, 0);
  assert.equal(listIncidents(db, { status: "all" }).total, 1);
});

test("sweepQuarantine 清掉逾期素材夾並清空欄位", async () => {
  const db = freshDb();
  const qdir = path.join(DATA, "q-old");
  fs.mkdirSync(qdir, { recursive: true });
  fs.writeFileSync(path.join(qdir, "x.txt"), "data");

  const id = recordIncident(db, {
    kind: "merge_failed",
    title: "舊事件",
    quarantine_dir: qdir,
  });
  // 把 created_at 設成很久以前,讓它落入清理範圍。
  db.prepare("UPDATE incidents SET created_at = ? WHERE id = ?").run(
    Math.floor(Date.now() / 1000) - 100_000,
    id,
  );

  const cleaned = await sweepQuarantine(db, 86_400); // 保留 1 天
  assert.equal(cleaned, 1);
  assert.equal(fs.existsSync(qdir), false, "素材夾應被刪除");
  const after = getIncident(db, id)!;
  assert.equal(after.quarantine_dir, null, "quarantine_dir 應清空");
  assert.match(after.resolution, /逾保留期限/);
});

test("sweepQuarantine 不動未逾期素材", async () => {
  const db = freshDb();
  const qdir = path.join(DATA, "q-fresh");
  fs.mkdirSync(qdir, { recursive: true });
  const id = recordIncident(db, { kind: "merge_failed", title: "新事件", quarantine_dir: qdir });
  const cleaned = await sweepQuarantine(db, 86_400);
  assert.equal(cleaned, 0);
  assert.equal(fs.existsSync(qdir), true);
  assert.equal(getIncident(db, id)!.quarantine_dir, qdir);
});
