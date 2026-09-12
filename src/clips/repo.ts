/**
 * 匯出片段(trip_clips)資料存取層 —— 唯一真相來源(比照 trips/repo.ts 集中 SQL 慣例)。
 *
 * 「片段」是非破壞性的另存:一趟旅程可產生多個獨立片段檔(front/rear/pip 版面),
 * 存於 <trip_dir>/clips/,原旅程不變。隨旅程刪除以 FK ON DELETE CASCADE 一併清除。
 */
import type { DB } from "../db.js";

export type ClipLayout = "front" | "rear" | "pip";
export type ClipQuality = "precise" | "fast";

/** DB 列(對應 trip_clips 全欄位)。 */
export interface ClipRow {
  id: number;
  trip_id: string;
  owner_id: number | null;
  label: string;
  start_sec: number;
  end_sec: number;
  layout: string;
  quality: string;
  /** pip 主畫面(front|rear);單鏡頭為 null。 */
  main_cam: string | null;
  file_path: string;
  size_bytes: number;
  duration_sec: number;
  created_at: number;
  /** 檢舉資料草稿(JSON 字串:plate/location/violation/desc);未填為 '{}'。 */
  report_json: string;
  /** 標記「已檢舉」的時間(epoch 秒);NULL=未檢舉。 */
  reported_at: number | null;
  source_start_epoch: number | null;
  source_end_epoch: number | null;
  source_version: string | null;
}

/** 新增片段所需欄位(id/created_at 由 DB/本層補齊)。 */
export interface NewClip {
  source_start_epoch?: number | null;
  source_end_epoch?: number | null;
  source_version?: string | null;
  trip_id: string;
  owner_id: number | null;
  label: string;
  start_sec: number;
  end_sec: number;
  layout: ClipLayout;
  quality: ClipQuality;
  main_cam: string | null;
  file_path: string;
  size_bytes: number;
  duration_sec: number;
}

const INSERT_SQL = `
INSERT INTO trip_clips
  (trip_id, owner_id, label, start_sec, end_sec, layout, quality, main_cam,
   file_path, size_bytes, duration_sec, created_at, source_start_epoch, source_end_epoch, source_version)
VALUES
  (@trip_id, @owner_id, @label, @start_sec, @end_sec, @layout, @quality, @main_cam,
   @file_path, @size_bytes, @duration_sec, @created_at, @source_start_epoch, @source_end_epoch, @source_version)
`;

/** 寫入一個片段,回傳含自增 id 的完整列。 */
export function insertClip(db: DB, c: NewClip): ClipRow {
  const created_at = Math.floor(Date.now() / 1000);
  const info = db.prepare(INSERT_SQL).run({ source_start_epoch:null, source_end_epoch:null, source_version:null, ...c, created_at });
  return getClip(db, Number(info.lastInsertRowid))!;
}

/** 取得單一片段;查無回 null。 */
export function getClip(db: DB, id: number): ClipRow | null {
  return (db.prepare("SELECT * FROM trip_clips WHERE id = ?").get(id) as ClipRow | undefined) ?? null;
}

/** 列出某趟旅程的所有片段(新到舊)。 */
export function listClipsForTrip(db: DB, tripId: string): ClipRow[] {
  return db
    .prepare("SELECT * FROM trip_clips WHERE trip_id = ? ORDER BY created_at DESC, id DESC")
    .all(tripId) as ClipRow[];
}

/** 片段列 + 來源旅程摘要(供片段頁一次列出)。 */
export interface ClipWithTrip extends ClipRow {
  date: string;
  day_order: number;
  /** 來源旅程的起始時間(epoch 秒);供前端換算片段的絕對時間(檢舉用)。 */
  trip_start_epoch: number;
}

/**
 * 列出檢視者可管理的所有片段(JOIN 旅程取 date/day_order/start_epoch)。
 * admin 看全部;一般使用者只看自己擁有旅程的片段(比照 canEditTrip)。
 */
export function listClipsForViewer(
  db: DB,
  viewer: { id: number; role: string },
): ClipWithTrip[] {
  const base = `
    SELECT c.*, t.date AS date, t.day_order AS day_order, t.start_epoch AS trip_start_epoch
      FROM trip_clips c
      JOIN trips t ON t.trip_id = c.trip_id`;
  const order = " ORDER BY c.created_at DESC, c.id DESC";
  if (viewer.role === "admin") {
    return db.prepare(base + order).all() as ClipWithTrip[];
  }
  return db.prepare(base + " WHERE t.owner_id = ?" + order).all(viewer.id) as ClipWithTrip[];
}

/** 刪除片段列(檔案由呼叫端負責移除)。 */
export function deleteClipRow(db: DB, id: number): void {
  db.prepare("DELETE FROM trip_clips WHERE id = ?").run(id);
}

/** 檢舉資料草稿(結構化;存成 report_json)。 */
export interface ClipReport {
  /** 被檢舉車輛牌照號碼。 */
  plate?: string;
  /** 違規地點(路名/路口)。 */
  location?: string;
  /** 違規事實(如:紅燈右轉)。 */
  violation?: string;
  /** 補充描述。 */
  desc?: string;
}

/** 更新片段的檢舉草稿與「已檢舉」標記(reportedAt 傳 null 清除標記)。 */
export function setClipReport(
  db: DB,
  id: number,
  report: ClipReport,
  reportedAt: number | null,
): void {
  db.prepare("UPDATE trip_clips SET report_json = ?, reported_at = ? WHERE id = ?").run(
    JSON.stringify(report),
    reportedAt,
    id,
  );
}
