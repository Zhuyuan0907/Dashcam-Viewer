/**
 * 旅程資料存取層 — 唯一真相來源。
 *
 * 舊 Python 版把同一段 `INSERT OR REPLACE INTO trips (...)` 抄了 4 次
 * (start_process / _import_prebuilt_trips / rebuild_db / import_prebuilt.py)。
 * 這裡集中成 upsertTrip(),其餘流程一律呼叫它。
 */
import fs from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import type { DB } from "../db.js";
import { TRIPS_DIR } from "../config.js";

/** 一趟旅程的完整資料(對應 DB 欄位與 info.json)。 */
export interface TripInfo {
  trip_id: string;
  date: string;
  day_order: number;
  start_epoch: number;
  end_epoch: number;
  duration_sec: number;
  segment_count: number;
  emer_count: number;
  has_front: boolean;
  has_rear: boolean;
  front_path: string | null;
  rear_path: string | null;
  peak_gforce: number;
  gforce_events: number;
}

/** DB 列(has_* 為 0/1,另含 trip_dir/created_at/owner_id/可見性/裁剪原始值)。 */
export interface TripRow extends Omit<TripInfo, "has_front" | "has_rear"> {
  has_front: number;
  has_rear: number;
  trip_dir: string | null;
  created_at: number;
  owner_id: number | null;
  /** 單一旅程公開覆寫:NULL=跟隨帳號、0=不公開、1=公開。 */
  public_override: number | null;
  orig_start_epoch: number | null;
  orig_end_epoch: number | null;
  orig_duration_sec: number | null;
}

const UPSERT_SQL = `
INSERT OR REPLACE INTO trips
  (trip_id, date, day_order, start_epoch, end_epoch,
   duration_sec, segment_count, emer_count,
   has_front, has_rear, front_path, rear_path,
   peak_gforce, gforce_events, trip_dir, created_at, owner_id)
VALUES
  (@trip_id, @date, @day_order, @start_epoch, @end_epoch,
   @duration_sec, @segment_count, @emer_count,
   @has_front, @has_rear, @front_path, @rear_path,
   @peak_gforce, @gforce_events, @trip_dir, @created_at, @owner_id)
`;

/**
 * 寫入(或覆寫)一趟旅程。
 * @param tripDir 該趟的磁碟目錄;省略時依 date 與 info 推算。
 * @param ownerId 旅程擁有者 user id;省略/未提供時沿用既有列的 owner_id(避免 rebuild/重處理清空歸屬)。
 */
export function upsertTrip(
  db: DB,
  info: TripInfo,
  tripDir?: string | null,
  ownerId?: number | null,
): void {
  // INSERT OR REPLACE 會整列覆寫,故若本次未指定 owner,先沿用既有 owner_id。
  let owner = ownerId ?? null;
  if (ownerId === undefined) {
    const existing = db.prepare("SELECT owner_id FROM trips WHERE trip_id = ?").get(info.trip_id) as
      | { owner_id: number | null }
      | undefined;
    owner = existing?.owner_id ?? null;
  }
  db.prepare(UPSERT_SQL).run({
    trip_id: info.trip_id,
    date: info.date,
    day_order: info.day_order,
    start_epoch: info.start_epoch,
    end_epoch: info.end_epoch,
    duration_sec: info.duration_sec,
    segment_count: info.segment_count,
    emer_count: info.emer_count,
    has_front: info.has_front ? 1 : 0,
    has_rear: info.has_rear ? 1 : 0,
    front_path: info.front_path,
    rear_path: info.rear_path,
    peak_gforce: info.peak_gforce,
    gforce_events: info.gforce_events,
    trip_dir: tripDir ?? null,
    created_at: Math.floor(Date.now() / 1000),
    owner_id: owner,
  });
}

/** 存取請求者的最小欄位(供可見性判斷)。 */
export interface Viewer {
  id: number;
  role: string;
}

/** 某帳號的 trips_public(0/1);查無回 0。 */
function ownerTripsPublic(db: DB, ownerId: number): number {
  const row = db.prepare("SELECT trips_public FROM users WHERE id = ?").get(ownerId) as
    | { trips_public: number }
    | undefined;
  return row?.trips_public ?? 0;
}

/**
 * 請求者是否可觀看「單一旅程」。
 *   - 管理員:一律可見。
 *   - 擁有者本人:可見。
 *   - 其他人:有效公開值 = public_override ?? 帳號 trips_public,為 1 才可見。
 */
export function canViewTrip(
  db: DB,
  viewer: Viewer,
  trip: { owner_id: number | null; public_override: number | null },
): boolean {
  if (viewer.role === "admin") return true;
  if (trip.owner_id !== null && trip.owner_id === viewer.id) return true;
  if (trip.owner_id === null) return false;
  const eff = trip.public_override ?? ownerTripsPublic(db, trip.owner_id);
  return eff === 1;
}

/** 請求者是否可編輯(裁剪 / 設定可見性)某旅程:擁有者本人或管理員。 */
export function canEditTrip(db: DB, viewer: Viewer, trip: { owner_id: number | null }): boolean {
  if (viewer.role === "admin") return true;
  return trip.owner_id !== null && trip.owner_id === viewer.id;
}

/**
 * 請求者是否可瀏覽某擁有者的旅程清單(dates/list 的 gate)。
 *   - 管理員 / 本人:是。
 *   - 其他人:該擁有者需存在「至少一趟可見旅程」(考量 per-trip override)。
 */
export function canBrowseOwner(db: DB, viewer: Viewer, ownerId: number | null): boolean {
  if (viewer.role === "admin") return true;
  if (ownerId !== null && ownerId === viewer.id) return true;
  if (ownerId === null) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM trips t JOIN users u ON u.id = t.owner_id
        WHERE t.owner_id = ? AND COALESCE(t.public_override, u.trips_public) = 1 LIMIT 1`,
    )
    .get(ownerId);
  return !!row;
}

/** 可選的旅程擁有者(供 browse 使用者選單)。 */
export interface OwnerOption {
  id: number;
  username: string;
  /** 顯示名稱(display_name 或 fallback username)。 */
  name: string;
  is_self: boolean;
}

/**
 * 列出請求者可瀏覽的旅程擁有者:自己(若有旅程)永遠在列,其餘為
 *   - 管理員:所有「有旅程」的使用者;
 *   - 一般使用者:trips_public=1 且有旅程的使用者。
 * 依「自己優先、其餘照 username」排序。
 */
export function listOwners(db: DB, viewer: Viewer): OwnerOption[] {
  const rows = db
    .prepare(
      `SELECT u.id AS id, u.username AS username, u.display_name AS display_name
         FROM users u
        WHERE EXISTS (SELECT 1 FROM trips t WHERE t.owner_id = u.id)
        ORDER BY u.username COLLATE NOCASE`,
    )
    .all() as Array<{ id: number; username: string; display_name: string | null }>;
  const out: OwnerOption[] = [];
  for (const r of rows) {
    // 可見規則(含 per-trip override)集中在 canBrowseOwner。
    if (canBrowseOwner(db, viewer, r.id)) {
      out.push({
        id: r.id,
        username: r.username,
        name: r.display_name || r.username,
        is_self: r.id === viewer.id,
      });
    }
  }
  // 自己排最前
  out.sort((a, b) => (a.is_self === b.is_self ? 0 : a.is_self ? -1 : 1));
  return out;
}

export function getTrip(db: DB, tripId: string): TripRow | null {
  return (db.prepare("SELECT * FROM trips WHERE trip_id = ?").get(tripId) as TripRow | undefined) ?? null;
}

/** 一趟旅程的備註(單一、可編輯)。 */
export interface TripNote {
  note: string;
  updated_at: number;
  updated_by: number | null;
}

/** 取得旅程備註;無則回 null。 */
export function getTripNote(db: DB, tripId: string): TripNote | null {
  return (
    (db
      .prepare("SELECT note, updated_at, updated_by FROM trip_notes WHERE trip_id = ?")
      .get(tripId) as TripNote | undefined) ?? null
  );
}

/** 設定旅程備註;空字串(去前後空白後)→刪除該列。 */
export function setTripNote(db: DB, tripId: string, note: string, userId: number): void {
  if (note.trim() === "") {
    db.prepare("DELETE FROM trip_notes WHERE trip_id = ?").run(tripId);
    return;
  }
  db.prepare(
    `INSERT INTO trip_notes (trip_id, note, updated_at, updated_by)
     VALUES (@trip_id, @note, @updated_at, @updated_by)
     ON CONFLICT(trip_id) DO UPDATE SET
       note = excluded.note,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run({
    trip_id: tripId,
    note,
    updated_at: Math.floor(Date.now() / 1000),
    updated_by: userId,
  });
}

/** 旅程的影片總位元組(前+後鏡頭實際檔案)。檔案不存在以 0 計。 */
export function tripBytes(row: Pick<TripRow, "front_path" | "rear_path">): number {
  let bytes = 0;
  for (const p of [row.front_path, row.rear_path]) {
    if (!p) continue;
    try {
      bytes += statSync(p).size;
    } catch {
      /* 檔案遺失,略過 */
    }
  }
  return bytes;
}

export type TripRowWithBytes = TripRow & { bytes: number };

/** 單一檔案大小(非阻塞);缺失/null 以 0 計。 */
async function fileBytes(p: string | null): Promise<number> {
  if (!p) return 0;
  try {
    return (await fs.stat(p)).size;
  } catch {
    return 0;
  }
}

/**
 * 是否需套用 per-trip 可見性過濾:擁有者本人或管理員 → 否(看全部);其他人 → 是。
 * 回傳可直接嵌入 SQL 的片段:{ join, cond }(cond 已含 owner 條件)。
 */
function visibilityScope(
  viewer: Viewer,
  ownerId: number | null,
): { join: string; cond: string } {
  const seeAll = viewer.role === "admin" || (ownerId !== null && ownerId === viewer.id);
  if (seeAll) return { join: "", cond: "t.owner_id IS ?" };
  return {
    join: "JOIN users u ON u.id = t.owner_id",
    cond: "t.owner_id IS ? AND COALESCE(t.public_override, u.trips_public) = 1",
  };
}

export async function listTrips(
  db: DB,
  opts: { date?: string | null; ownerId?: number | null; viewer: Viewer; limit: number; offset: number },
): Promise<{ total: number; trips: TripRowWithBytes[] }> {
  const owner = opts.ownerId ?? null;
  const { join, cond } = visibilityScope(opts.viewer, owner);
  const dateCond = opts.date ? " AND t.date = ?" : "";
  const params: Array<unknown> = [owner];
  if (opts.date) params.push(opts.date);
  const order = opts.date ? "t.start_epoch ASC" : "t.start_epoch DESC";

  const rows = db
    .prepare(
      `SELECT t.* FROM trips t ${join} WHERE ${cond}${dateCond} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .all(...params, opts.limit, opts.offset) as TripRow[];
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM trips t ${join} WHERE ${cond}${dateCond}`).get(...params) as {
      c: number;
    }
  ).c;

  // 非阻塞 stat,平行取大小(避免在 async handler 內做同步 I/O 卡住 event loop)。
  const trips = await Promise.all(
    rows.map(async (r) => ({ ...r, bytes: (await fileBytes(r.front_path)) + (await fileBytes(r.rear_path)) })),
  );
  return { total, trips };
}

export function listDates(
  db: DB,
  ownerId: number | null,
  viewer: Viewer,
): Array<Record<string, unknown>> {
  const { join, cond } = visibilityScope(viewer, ownerId ?? null);
  return db
    .prepare(
      `SELECT t.date            AS date,
              COUNT(*)          AS trip_count,
              SUM(t.duration_sec) AS total_sec,
              SUM(t.emer_count)   AS emer_count,
              MAX(t.peak_gforce)  AS max_gforce,
              SUM(t.gforce_events) AS gforce_events,
              MIN(t.start_epoch)  AS first_start
         FROM trips t ${join} WHERE ${cond}
        GROUP BY t.date ORDER BY t.date DESC`,
    )
    .all(ownerId ?? null) as Array<Record<string, unknown>>;
}

/** 管理員檔案總管:所有旅程(含擁有者帳號 + 大小),依 start_epoch 由新到舊。 */
export async function listTripsForFiles(
  db: DB,
): Promise<Array<TripRow & { bytes: number; owner_username: string | null }>> {
  const rows = db
    .prepare(
      `SELECT t.*, COALESCE(u.display_name, u.username) AS owner_username
         FROM trips t LEFT JOIN users u ON u.id = t.owner_id
        ORDER BY t.start_epoch DESC`,
    )
    .all() as Array<TripRow & { owner_username: string | null }>;
  return Promise.all(
    rows.map(async (r) => ({
      ...r,
      bytes: (await fileBytes(r.front_path)) + (await fileBytes(r.rear_path)),
    })),
  );
}

export function overallStats(db: DB): Record<string, unknown> {
  return (
    (db
      .prepare(
        `SELECT COUNT(*)             AS total_trips,
                COUNT(DISTINCT date) AS total_days,
                SUM(duration_sec)    AS total_sec,
                MAX(peak_gforce)     AS max_gforce,
                SUM(gforce_events)   AS total_gevents,
                SUM(emer_count)      AS total_emer
           FROM trips`,
      )
      .get() as Record<string, unknown>) ?? {}
  );
}

/** 刪除一趟旅程(含磁碟目錄)。回傳是否存在並刪除成功。 */
export async function deleteTrip(db: DB, tripId: string): Promise<boolean> {
  const row = db.prepare("SELECT trip_dir FROM trips WHERE trip_id = ?").get(tripId) as
    | { trip_dir: string | null }
    | undefined;
  if (!row) return false;
  if (row.trip_dir) {
    await fs.rm(row.trip_dir, { recursive: true, force: true });
  }
  db.prepare("DELETE FROM trips WHERE trip_id = ?").run(tripId);
  return true;
}

/** 從磁碟上所有 info.json 重建 DB。回傳成功匯入數。 */
export async function rebuildFromDisk(db: DB): Promise<number> {
  const infoFiles = await findInfoJsons(TRIPS_DIR);
  let count = 0;
  for (const file of infoFiles.sort()) {
    try {
      const info = JSON.parse(await fs.readFile(file, "utf-8")) as Partial<TripInfo>;
      if (!info.trip_id || !info.date) continue;
      upsertTrip(
        db,
        {
          trip_id: info.trip_id,
          date: info.date,
          day_order: info.day_order ?? 1,
          start_epoch: info.start_epoch ?? 0,
          end_epoch: info.end_epoch ?? 0,
          duration_sec: info.duration_sec ?? 0,
          segment_count: info.segment_count ?? 0,
          emer_count: info.emer_count ?? 0,
          has_front: Boolean(info.has_front),
          has_rear: Boolean(info.has_rear),
          front_path: info.front_path ?? null,
          rear_path: info.rear_path ?? null,
          peak_gforce: info.peak_gforce ?? 0,
          gforce_events: info.gforce_events ?? 0,
        },
        path.dirname(file),
      );
      count++;
    } catch {
      continue;
    }
  }
  return count;
}

async function findInfoJsons(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name === "info.json") out.push(full);
    }
  }
  await walk(root);
  return out;
}
