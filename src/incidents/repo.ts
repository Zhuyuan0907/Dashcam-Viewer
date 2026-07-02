/**
 * 事件(incident)資料存取層 —— 善後系統的持久記錄。
 *
 * 處理流程中的失敗(合併失敗、整趟略過、處理例外)會在此持久化,讓管理員事後仍能
 * 在維運頁追查原因並執行修復動作。失敗素材若被隔離保留,其路徑記於 quarantine_dir,
 * 供「重新合併」重試使用。
 */
import fs from "node:fs/promises";
import type { DB } from "../db.js";

export type IncidentKind = "merge_failed" | "trip_skipped" | "processing_error";
export type IncidentSeverity = "info" | "warn" | "error";
export type IncidentStatus = "open" | "resolved" | "dismissed";

export interface IncidentInput {
  session_id?: string | null;
  kind: IncidentKind;
  severity?: IncidentSeverity;
  trip_label?: string | null;
  title: string;
  detail?: string;
  /** 結構化內容;會被 JSON.stringify 存入 context_json。 */
  context?: Record<string, unknown>;
  quarantine_dir?: string | null;
}

export interface IncidentRow {
  id: number;
  created_at: number;
  session_id: string | null;
  kind: string;
  severity: string;
  trip_label: string | null;
  title: string;
  detail: string;
  context_json: string;
  quarantine_dir: string | null;
  status: string;
  resolved_at: number | null;
  resolved_by: number | null;
  resolution: string;
}

const INSERT_SQL = `
INSERT INTO incidents
  (created_at, session_id, kind, severity, trip_label, title, detail, context_json, quarantine_dir, status)
VALUES
  (@created_at, @session_id, @kind, @severity, @trip_label, @title, @detail, @context_json, @quarantine_dir, 'open')
`;

/** 記錄一筆事件,回傳新 id。 */
export function recordIncident(db: DB, input: IncidentInput): number {
  const info = db.prepare(INSERT_SQL).run({
    created_at: Math.floor(Date.now() / 1000),
    session_id: input.session_id ?? null,
    kind: input.kind,
    severity: input.severity ?? "error",
    trip_label: input.trip_label ?? null,
    title: input.title,
    detail: input.detail ?? "",
    context_json: JSON.stringify(input.context ?? {}),
    quarantine_dir: input.quarantine_dir ?? null,
  });
  return Number(info.lastInsertRowid);
}

export interface ListOptions {
  status?: IncidentStatus | "all";
  limit?: number;
  offset?: number;
}

export function listIncidents(
  db: DB,
  opts: ListOptions = {},
): { total: number; rows: IncidentRow[] } {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const offset = Math.max(0, opts.offset ?? 0);
  const filterOpen = opts.status && opts.status !== "all";
  if (filterOpen) {
    const rows = db
      .prepare("SELECT * FROM incidents WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
      .all(opts.status, limit, offset) as IncidentRow[];
    const total = (
      db.prepare("SELECT COUNT(*) AS c FROM incidents WHERE status = ?").get(opts.status) as { c: number }
    ).c;
    return { total, rows };
  }
  const rows = db
    .prepare("SELECT * FROM incidents ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
    .all(limit, offset) as IncidentRow[];
  const total = (db.prepare("SELECT COUNT(*) AS c FROM incidents").get() as { c: number }).c;
  return { total, rows };
}

/** 統計各狀態筆數(供前端徽章)。 */
export function incidentCounts(db: DB): { open: number; total: number } {
  const open = (
    db.prepare("SELECT COUNT(*) AS c FROM incidents WHERE status = 'open'").get() as { c: number }
  ).c;
  const total = (db.prepare("SELECT COUNT(*) AS c FROM incidents").get() as { c: number }).c;
  return { open, total };
}

export function getIncident(db: DB, id: number): IncidentRow | null {
  return (db.prepare("SELECT * FROM incidents WHERE id = ?").get(id) as IncidentRow | undefined) ?? null;
}

/** 標記事件已處理(resolved)或忽略(dismissed)。 */
export function resolveIncident(
  db: DB,
  id: number,
  opts: { status: "resolved" | "dismissed"; userId?: number | null; resolution?: string },
): void {
  db.prepare(
    "UPDATE incidents SET status = ?, resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?",
  ).run(opts.status, Math.floor(Date.now() / 1000), opts.userId ?? null, opts.resolution ?? "", id);
}

/** 清空某事件的隔離素材欄位(素材已刪或已重試成功)。 */
export function clearQuarantine(db: DB, id: number): void {
  db.prepare("UPDATE incidents SET quarantine_dir = NULL WHERE id = ?").run(id);
}

/**
 * 清理逾期的隔離素材:刪除 created_at 早於 cutoff 且仍有 quarantine_dir 的素材夾,
 * 清空欄位並把 resolution 標註。incident 本身保留為歷史。回傳清理的筆數。
 */
export async function sweepQuarantine(db: DB, maxAgeSec: number): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
  const rows = db
    .prepare("SELECT id, quarantine_dir FROM incidents WHERE quarantine_dir IS NOT NULL AND created_at < ?")
    .all(cutoff) as Array<{ id: number; quarantine_dir: string }>;
  let cleaned = 0;
  for (const r of rows) {
    await fs.rm(r.quarantine_dir, { recursive: true, force: true }).catch(() => {});
    db.prepare(
      "UPDATE incidents SET quarantine_dir = NULL, resolution = CASE WHEN resolution = '' THEN ? ELSE resolution END WHERE id = ?",
    ).run("素材已逾保留期限,自動清理", r.id);
    cleaned++;
  }
  return cleaned;
}
