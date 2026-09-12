/**
 * 旅程資料存取層 — 唯一真相來源。
 *
 * 舊 Python 版把同一段 `INSERT OR REPLACE INTO trips (...)` 抄了 4 次
 * (start_process / _import_prebuilt_trips / rebuild_db / import_prebuilt.py)。
 * 這裡集中成 upsertTrip(),其餘流程一律呼叫它。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { DB } from "../db.js";
import { TRIPS_DIR } from "../config.js";
import {
  parseDeviceSnapshot,
  serializeDeviceSnapshot,
  type DashcamDeviceSnapshot,
} from "../devices/repo.js";
import { withinTrips } from "../util/paths.js";
import { readTimeline, sliceTimeline, type Timeline } from "../media/timeline.js";

/** 一趟旅程的完整資料(對應 DB 欄位與 info.json)。 */
export interface TripInfo {
  timeline?: Timeline;
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
  /** 寫進 info.json 供空庫重建;舊資料可省略。 */
  owner_id?: number | null;
  /** owner_id 是可重建／可重用的代理鍵；以不可變 username 驗證身分避免錯綁帳號。 */
  owner_username?: string | null;
  device_id?: number | null;
  device?: DashcamDeviceSnapshot | null;
}

/** DB 列(has_* 為 0/1,另含 trip_dir/created_at/owner_id/可見性/裁剪原始值)。 */
export interface TripRow
  extends Omit<TripInfo, "has_front" | "has_rear" | "owner_id" | "device_id" | "device"> {
  timeline_json?: string | null;
  trim_offset_sec?: number;
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
  device_id: number | null;
  device_snapshot: string | null;
}

// 真正的 UPSERT(ON CONFLICT DO UPDATE),而非 INSERT OR REPLACE。
// 關鍵差異:INSERT OR REPLACE 會「刪列再插入」,連鎖觸發 trip_notes / trip_clips 的
// ON DELETE CASCADE(備註、匯出片段全毀),並把未列出的欄位(public_override、orig_*)
// 重置回預設。改用 ON CONFLICT DO UPDATE 只更新處理流程實際知道的欄位:
//   - 不動 created_at(保留初次建立時間)。
//   - 不動 public_override / orig_*(保留可見性覆寫與裁剪還原資料)。
//   - owner_id 用 COALESCE 保留既有歸屬(既有為 NULL 才採用新值,例如 ops 重試補歸屬)。
//   - 已裁剪的旅程(orig_duration_sec 非 NULL):保留現有 start/end/duration —— rebuild/重匯入
//     帶來的是「裁剪前」的 info.json 值,直接覆寫會讓播放檔(已裁剪)與 DB 座標系錯位,
//     再次裁剪/匯出片段會切錯內容。
//   - 不觸發 CASCADE → 備註與匯出片段安然保留。
const UPSERT_SQL = `
INSERT INTO trips
  (trip_id, date, day_order, start_epoch, end_epoch,
   duration_sec, segment_count, emer_count,
   has_front, has_rear, front_path, rear_path,
   peak_gforce, gforce_events, trip_dir, created_at, owner_id, device_id, device_snapshot)
VALUES
  (@trip_id, @date, @day_order, @start_epoch, @end_epoch,
   @duration_sec, @segment_count, @emer_count,
   @has_front, @has_rear, @front_path, @rear_path,
   @peak_gforce, @gforce_events, @trip_dir, @created_at, @owner_id, @device_id, @device_snapshot)
ON CONFLICT(trip_id) DO UPDATE SET
  date          = excluded.date,
  day_order     = excluded.day_order,
  start_epoch   = CASE WHEN trips.orig_duration_sec IS NULL THEN excluded.start_epoch ELSE trips.start_epoch END,
  end_epoch     = CASE WHEN trips.orig_duration_sec IS NULL THEN excluded.end_epoch ELSE trips.end_epoch END,
  duration_sec  = CASE WHEN trips.orig_duration_sec IS NULL THEN excluded.duration_sec ELSE trips.duration_sec END,
  segment_count = excluded.segment_count,
  emer_count    = excluded.emer_count,
  has_front     = excluded.has_front,
  has_rear      = excluded.has_rear,
  front_path    = excluded.front_path,
  rear_path     = excluded.rear_path,
  peak_gforce   = excluded.peak_gforce,
  gforce_events = excluded.gforce_events,
  trip_dir      = excluded.trip_dir,
  owner_id      = COALESCE(trips.owner_id, excluded.owner_id),
  device_id     = COALESCE(trips.device_id, excluded.device_id),
  device_snapshot = COALESCE(trips.device_snapshot, excluded.device_snapshot)
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
  let owner = ownerId ?? info.owner_id ?? null;
  if (ownerId === undefined) {
    const existing = db
      .prepare("SELECT owner_id FROM trips WHERE trip_id = ?")
      .get(info.trip_id) as { owner_id: number | null } | undefined;
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
    device_id: info.device_id ?? null,
    device_snapshot: serializeDeviceSnapshot(info.device ?? null),
  });
  if (info.timeline)
    db.prepare(
      "UPDATE trips SET timeline_json=? WHERE trip_id=? AND orig_duration_sec IS NULL",
    ).run(JSON.stringify(info.timeline), info.trip_id);
}

/** DB 內保存 JSON 字串,API/呼叫端統一拿結構化 device。 */
export function tripDevice(row: Pick<TripRow, "device_snapshot">): DashcamDeviceSnapshot | null {
  return parseDeviceSnapshot(row.device_snapshot);
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
export function canEditTrip(_db: DB, viewer: Viewer, trip: { owner_id: number | null }): boolean {
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
  return (
    (db.prepare("SELECT * FROM trips WHERE trip_id = ?").get(tripId) as TripRow | undefined) ?? null
  );
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

/** 旅程的影片總位元組(前+後鏡頭實際檔案,非阻塞)。檔案不存在以 0 計。 */
export async function tripBytes(row: Pick<TripRow, "front_path" | "rear_path">): Promise<number> {
  return (await fileBytes(row.front_path)) + (await fileBytes(row.rear_path));
}

/** 由 info.json/TripInfo 推得該趟的磁碟目錄(前鏡頭優先,否則後鏡頭)。 */
export function tripDirOf(info: Pick<TripInfo, "front_path" | "rear_path">): string | null {
  const p = info.front_path ?? info.rear_path;
  return p ? path.dirname(p) : null;
}

/** 整趟裁剪:寫入新起訖並保留原始值(COALESCE,支援重複裁剪)。SQL 集中於 repo(勿散落 route)。 */
export function applyTrim(
  db: DB,
  tripId: string,
  v: {
    prevStart: number;
    prevEnd: number;
    prevDur: number;
    newStart: number;
    newEnd: number;
    newDur: number;
    offset?: number;
  },
): void {
  const row = getTrip(db, tripId)!;
  const offset = v.offset ?? v.newStart - v.prevStart;
  const timeline = readTimeline(row);
  db.prepare(
    "UPDATE trips SET orig_timeline_json=COALESCE(orig_timeline_json,?), timeline_json=?, trim_offset_sec=trim_offset_sec+? WHERE trip_id=?",
  ).run(
    JSON.stringify(timeline),
    JSON.stringify(sliceTimeline(timeline, offset, offset + v.newDur)),
    offset,
    tripId,
  );
  db.prepare(
    `UPDATE trips SET
       orig_start_epoch  = COALESCE(orig_start_epoch, ?),
       orig_end_epoch    = COALESCE(orig_end_epoch, ?),
       orig_duration_sec = COALESCE(orig_duration_sec, ?),
       start_epoch = ?, end_epoch = ?, duration_sec = ?
     WHERE trip_id = ?`,
  ).run(v.prevStart, v.prevEnd, v.prevDur, v.newStart, v.newEnd, v.newDur, tripId);
}

/** 還原整趟裁剪:把原始起訖寫回並清空 orig_*。 */
export function clearTrim(
  db: DB,
  tripId: string,
  v: { start: number; end: number; dur: number },
): void {
  db.prepare(
    `UPDATE trips SET timeline_json=orig_timeline_json, orig_timeline_json=NULL, trim_offset_sec=0, start_epoch = ?, end_epoch = ?, duration_sec = ?,
       orig_start_epoch = NULL, orig_end_epoch = NULL, orig_duration_sec = NULL
     WHERE trip_id = ?`,
  ).run(v.start, v.end, v.dur, tripId);
}

/** 設定單一旅程的公開覆寫(null=跟隨帳號、0=不公開、1=公開)。 */
export function setPublicOverride(db: DB, tripId: string, override: number | null): void {
  db.prepare("UPDATE trips SET public_override = ? WHERE trip_id = ?").run(override, tripId);
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
function visibilityScope(viewer: Viewer, ownerId: number | null): { join: string; cond: string } {
  const seeAll = viewer.role === "admin" || (ownerId !== null && ownerId === viewer.id);
  if (seeAll) return { join: "", cond: "t.owner_id IS ?" };
  return {
    join: "JOIN users u ON u.id = t.owner_id",
    cond: "t.owner_id IS ? AND COALESCE(t.public_override, u.trips_public) = 1",
  };
}

export async function listTrips(
  db: DB,
  opts: {
    date?: string | null;
    ownerId?: number | null;
    viewer: Viewer;
    limit: number;
    offset: number;
  },
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
    db
      .prepare(`SELECT COUNT(*) AS c FROM trips t ${join} WHERE ${cond}${dateCond}`)
      .get(...params) as {
      c: number;
    }
  ).c;

  // 非阻塞 stat,平行取大小(避免在 async handler 內做同步 I/O 卡住 event loop)。
  const trips = await Promise.all(
    rows.map(async (r) => ({
      ...r,
      bytes: (await fileBytes(r.front_path)) + (await fileBytes(r.rear_path)),
    })),
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

/**
 * 彙總統計。管理員看全站;一般使用者只看「自己可見的旅程」(自己的 + 對其公開的),
 * 避免把含私人旅程在內的全站彙總(趟數/總時長/最高 G 等)洩漏給任何登入者。
 */
export function overallStats(db: DB, viewer: Viewer): Record<string, unknown> {
  const cols = `COUNT(*)             AS total_trips,
                COUNT(DISTINCT t.date) AS total_days,
                SUM(t.duration_sec)    AS total_sec,
                MAX(t.peak_gforce)     AS max_gforce,
                SUM(t.gforce_events)   AS total_gevents,
                SUM(t.emer_count)      AS total_emer`;
  if (viewer.role === "admin") {
    return (db.prepare(`SELECT ${cols} FROM trips t`).get() as Record<string, unknown>) ?? {};
  }
  // 一般使用者:自己的旅程,或其他人對「本檢視者」公開的旅程。
  return (
    (db
      .prepare(
        `SELECT ${cols}
           FROM trips t JOIN users u ON u.id = t.owner_id
          WHERE t.owner_id = ? OR COALESCE(t.public_override, u.trips_public) = 1`,
      )
      .get(viewer.id) as Record<string, unknown>) ?? {}
  );
}

/** 刪除一趟旅程(含磁碟目錄)。回傳是否存在並刪除成功。 */
export async function deleteTrip(db: DB, tripId: string): Promise<boolean> {
  const row = db.prepare("SELECT trip_dir FROM trips WHERE trip_id = ?").get(tripId) as
    | { trip_dir: string | null }
    | undefined;
  if (!row) return false;
  // 先刪 DB 列(CASCADE 清 notes/clips),再視情況刪磁碟目錄。
  db.prepare("DELETE FROM trips WHERE trip_id = ?").run(tripId);
  if (row.trip_dir) {
    // 若還有其他旅程列共用同一目錄(分批重匯入可能造成),不可刪目錄,否則會毀掉別列的影片。
    const shared = db.prepare("SELECT 1 FROM trips WHERE trip_dir = ? LIMIT 1").get(row.trip_dir);
    if (!shared) {
      await fs.rm(row.trip_dir, { recursive: true, force: true });
    }
  }
  return true;
}

/** 依 owner + date 重新編號,不同使用者的「第 N 趟」互不干擾。 */
export function renumberDay(db: DB, date: string, ownerId?: number | null): void {
  const scoped = ownerId !== undefined;
  const rows = db
    .prepare(
      `SELECT trip_id FROM trips WHERE date = ?${scoped ? " AND owner_id IS ?" : ""}
        ORDER BY start_epoch ASC, trip_id ASC`,
    )
    .all(...(scoped ? [date, ownerId ?? null] : [date])) as Array<{ trip_id: string }>;
  const upd = db.prepare("UPDATE trips SET day_order = ? WHERE trip_id = ?");
  const tx = db.transaction((list: Array<{ trip_id: string }>) => {
    list.forEach((r, i) => upd.run(i + 1, r.trip_id));
  });
  tx(rows);
}

/** 從磁碟上所有 info.json 重建 DB。回傳成功匯入數。 */
export async function rebuildFromDisk(db: DB): Promise<number> {
  const infoFiles = await findInfoJsons(TRIPS_DIR);
  let count = 0;
  const scopes = new Map<string, { date: string; ownerId: number | null }>();
  for (const file of infoFiles.sort()) {
    try {
      const info = JSON.parse(await fs.readFile(file, "utf-8")) as Partial<TripInfo>;
      if (!info.trip_id || !info.date) continue;
      const requestedOwnerId =
        Number.isInteger(info.owner_id) && Number(info.owner_id) > 0 ? Number(info.owner_id) : null;
      const ownerUsername =
        typeof info.owner_username === "string" && info.owner_username.length > 0
          ? info.owner_username
          : null;
      // owner_id 是單一 DB 內的代理鍵。只有 ID 與不可變帳號名稱都吻合才恢復
      // 歸屬；舊 metadata 缺少名稱時寧可成為 orphan，也不能錯綁另一個帳號。
      const validOwner =
        requestedOwnerId !== null && ownerUsername !== null
          ? (db
              .prepare("SELECT id FROM users WHERE id = ? AND username = ?")
              .get(requestedOwnerId, ownerUsername) as { id: number } | undefined)
          : undefined;
      const ownerId = validOwner?.id ?? null;
      const requestedDeviceId =
        Number.isInteger(info.device_id) && Number(info.device_id) > 0
          ? Number(info.device_id)
          : null;
      // device_id 是單一 DB 內的代理鍵。從空庫／不同備份重建時該 ID 可能不存在，
      // 直接寫入會觸發外鍵錯誤並讓整趟旅程被略過。只有裝置仍存在且屬於 owner 時
      // 才恢復關聯；否則設 null，仍保留 info.json 裡的不可變裝置快照。
      const validDevice =
        requestedDeviceId !== null && ownerId !== null
          ? (db
              .prepare("SELECT id FROM dashcam_devices WHERE id = ? AND user_id = ?")
              .get(requestedDeviceId, ownerId) as { id: number } | undefined)
          : undefined;
      const deviceId = validDevice?.id ?? null;
      scopes.set(`${ownerId ?? "null"}|${info.date}`, { date: info.date, ownerId });
      upsertTrip(
        db,
        {
          trip_id: info.trip_id,
          date: info.date,
          day_order: info.day_order ?? 1,
          start_epoch: info.start_epoch ?? 0,
          end_epoch: info.end_epoch ?? 0,
          duration_sec: info.duration_sec ?? 0,
          timeline: info.timeline,
          segment_count: info.segment_count ?? 0,
          emer_count: info.emer_count ?? 0,
          has_front: Boolean(info.has_front),
          has_rear: Boolean(info.has_rear),
          front_path: info.front_path ?? null,
          rear_path: info.rear_path ?? null,
          peak_gforce: info.peak_gforce ?? 0,
          gforce_events: info.gforce_events ?? 0,
          owner_id: ownerId,
          device_id: deviceId,
          device: parseDeviceSnapshot(info.device),
        },
        path.dirname(file),
        ownerId,
      );
      count++;
    } catch {
      continue;
    }
  }
  for (const scope of scopes.values()) renumberDay(db, scope.date, scope.ownerId);
  return count;
}

export interface TripInfoMetadataSyncResult {
  scanned: number;
  updated: number;
  failed: number;
}

/**
 * 把 DB 中的 owner／裝置快照補進旅程 info.json，讓資料庫遺失後仍可由磁碟重建。
 * 既有 metadata 的時間與裁剪前資訊一律保留；檔案不存在時才以 DB 列重建。
 * 共用目錄、損壞 JSON 或 trip_id 不一致一律拒絕寫入，避免交叉覆蓋旅程歸屬。
 */
export async function syncTripInfoDeviceMetadata(db: DB): Promise<TripInfoMetadataSyncResult> {
  const rows = db
    .prepare(
      `SELECT t.*, u.username AS owner_username
       FROM trips t LEFT JOIN users u ON u.id = t.owner_id
      ORDER BY t.trip_id`,
    )
    .all() as Array<TripRow & { owner_username: string | null }>;
  const result: TripInfoMetadataSyncResult = { scanned: 0, updated: 0, failed: 0 };
  const rowDir = (row: TripRow): string | null => {
    const inferred = row.front_path
      ? path.dirname(row.front_path)
      : row.rear_path
        ? path.dirname(row.rear_path)
        : null;
    return row.trip_dir ?? inferred;
  };
  const dirCounts = new Map<string, number>();
  for (const row of rows) {
    const dir = rowDir(row);
    if (!dir || !withinTrips(dir)) continue;
    const key = path.resolve(dir);
    dirCounts.set(key, (dirCounts.get(key) ?? 0) + 1);
  }

  for (const row of rows) {
    result.scanned++;
    const tripDir = rowDir(row);
    if (!tripDir || !withinTrips(tripDir)) {
      result.failed++;
      continue;
    }
    try {
      if (!(await fs.stat(tripDir)).isDirectory()) {
        result.failed++;
        continue;
      }
    } catch {
      result.failed++;
      continue;
    }
    if ((dirCounts.get(path.resolve(tripDir)) ?? 0) > 1) {
      result.failed++;
      continue;
    }
    const infoPath = path.join(tripDir, "info.json");
    const tmpPath = `${infoPath}.tmp.${process.pid}`;

    try {
      let original: Record<string, unknown> | null = null;
      try {
        const raw = await fs.readFile(infoPath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          (parsed as Record<string, unknown>).trip_id !== row.trip_id
        ) {
          throw new Error("info.json trip_id 與資料庫不一致");
        }
        original = parsed as Record<string, unknown>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        /* 缺檔時由 DB 列重建完整 metadata。 */
      }

      const base: Record<string, unknown> = original ?? {
        trip_id: row.trip_id,
        date: row.date,
        day_order: row.day_order,
        start_epoch: row.start_epoch,
        end_epoch: row.end_epoch,
        duration_sec: row.duration_sec,
        segment_count: row.segment_count,
        emer_count: row.emer_count,
        has_front: row.has_front === 1,
        has_rear: row.has_rear === 1,
        front_path: row.front_path,
        rear_path: row.rear_path,
        peak_gforce: row.peak_gforce,
        gforce_events: row.gforce_events,
      };
      const device = parseDeviceSnapshot(row.device_snapshot);
      const next = {
        ...base,
        owner_id: row.owner_id,
        owner_username: row.owner_username,
        device_id: row.device_id,
        device,
      };
      const unchanged =
        original !== null &&
        original.owner_id === next.owner_id &&
        original.owner_username === next.owner_username &&
        original.device_id === next.device_id &&
        JSON.stringify(original.device ?? null) === JSON.stringify(next.device);
      if (unchanged) continue;

      await fs.writeFile(tmpPath, JSON.stringify(next, null, 2), "utf8");
      await fs.rename(tmpPath, infoPath);
      result.updated++;
    } catch {
      result.failed++;
      await fs.rm(tmpPath, { force: true }).catch(() => {});
    }
  }
  return result;
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
