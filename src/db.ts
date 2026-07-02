/**
 * 資料庫單例(better-sqlite3)。
 * 與舊 Python 版 schema 完全相同,SQLite 檔可與舊版互通(路徑見 config.ts 的 DB_PATH)。
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DB_PATH, DATA_DIR } from "./config.js";

export type DB = Database.Database;

const DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'viewer',
    email         TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    -- 上傳工作階段 idle 逾時(秒)的逐帳號覆寫:NULL=依角色預設(admin 不限)、0=不限、其他=秒數
    upload_idle_sec INTEGER,
    -- 逐帳號個人偏好(個人設定頁):NULL 一律代表「未設定/跟隨全域」
    pref_camera   TEXT,    -- 'front' | 'rear' | NULL(NULL=跟隨全域 default_camera)
    pref_speed    REAL,    -- 1 | 1.5 | 2 | NULL(NULL=1)
    pref_theme    TEXT,    -- 'auto' | 'light' | 'dark' | NULL(NULL 視為 auto)
    device_note   TEXT,    -- 「使用的行車記錄器」自由文字
    display_name  TEXT,    -- 顯示名稱(選填;各處 UI 優先顯示,未設定則用 username)
    -- 是否公開自己的旅程給其他使用者瀏覽(0=私人,預設;1=公開)
    trips_public  INTEGER NOT NULL DEFAULT 0,
    -- 總管理員(擁有者):唯一可變更/移除其他管理員角色者;帳號本身受保護不可刪除/降級
    is_owner      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
    trip_id       TEXT PRIMARY KEY,
    date          TEXT NOT NULL,
    day_order     INTEGER NOT NULL DEFAULT 1,
    start_epoch   INTEGER NOT NULL,
    end_epoch     INTEGER NOT NULL,
    duration_sec  INTEGER NOT NULL,
    segment_count INTEGER NOT NULL DEFAULT 0,
    emer_count    INTEGER NOT NULL DEFAULT 0,
    has_front     INTEGER NOT NULL DEFAULT 0,
    has_rear      INTEGER NOT NULL DEFAULT 0,
    front_path    TEXT,
    rear_path     TEXT,
    peak_gforce   REAL    NOT NULL DEFAULT 0,
    gforce_events INTEGER NOT NULL DEFAULT 0,
    trip_dir      TEXT,
    created_at    INTEGER NOT NULL,
    -- 旅程擁有者(上傳者 user id);NULL=無歸屬(遷移時回填給主管理員)
    owner_id      INTEGER,
    -- 單一旅程公開覆寫:NULL=跟隨帳號 trips_public、0=強制不公開、1=強制公開
    public_override INTEGER,
    -- 裁剪前的原始值(NULL=未裁剪);供還原
    orig_start_epoch  INTEGER,
    orig_end_epoch    INTEGER,
    orig_duration_sec INTEGER
);

CREATE TABLE IF NOT EXISTS upload_sessions (
    session_id   TEXT PRIMARY KEY,
    status       TEXT NOT NULL DEFAULT 'uploading',
    file_count   INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS sftp_sessions (
    id            TEXT PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username      TEXT NOT NULL,
    password      TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    file_count    INTEGER NOT NULL DEFAULT 0,
    total_bytes   INTEGER NOT NULL DEFAULT 0,
    -- 此工作階段建立當下的有效 idle 逾時(秒);0=不限,永不自動回收
    idle_sec      INTEGER NOT NULL DEFAULT 600
);

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trip_notes (
    trip_id    TEXT PRIMARY KEY REFERENCES trips(trip_id) ON DELETE CASCADE,
    note       TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS incidents (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at     INTEGER NOT NULL,
    session_id     TEXT,
    kind           TEXT NOT NULL,                 -- merge_failed | trip_skipped | processing_error
    severity       TEXT NOT NULL DEFAULT 'error', -- info | warn | error
    trip_label     TEXT,
    title          TEXT NOT NULL,
    detail         TEXT NOT NULL DEFAULT '',      -- 完整原因(ffmpeg stderr 等)
    context_json   TEXT NOT NULL DEFAULT '{}',    -- 結構化:camera / segmentBases / sizes / paths
    quarantine_dir TEXT,                           -- 隔離保留的原始素材路徑(可重試)
    status         TEXT NOT NULL DEFAULT 'open',  -- open | resolved | dismissed
    resolved_at    INTEGER,
    resolved_by    INTEGER,
    resolution     TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sessions_token   ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_trips_date       ON trips(date);
CREATE INDEX IF NOT EXISTS idx_sftp_sessions_user ON sftp_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_incidents_status  ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at);
`;

let _db: DB | null = null;

/**
 * 取得(或初始化)資料庫單例。
 * @param dbPath 測試可指定獨立 DB;預設用 config 的 DB_PATH。
 */
export function getDb(dbPath: string = DB_PATH): DB {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(DB_SCHEMA);
  migrate(db);
  _db = db;
  return db;
}

/** 建立一個獨立、不共用單例的 DB(供測試使用)。 */
export function createDb(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(DB_SCHEMA);
  migrate(db);
  return db;
}

/** 舊資料庫欄位遷移(冪等)。 */
function migrate(db: DB): void {
  const userCols = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userCols.some((c) => c.name === "email")) {
    db.exec("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
  }
  if (!userCols.some((c) => c.name === "upload_idle_sec")) {
    db.exec("ALTER TABLE users ADD COLUMN upload_idle_sec INTEGER");
  }
  // 個人偏好欄位(皆可空,NULL=未設定);逐一冪等新增。
  const need = (n: string): boolean => !userCols.some((c) => c.name === n);
  if (need("pref_camera")) db.exec("ALTER TABLE users ADD COLUMN pref_camera TEXT");
  if (need("pref_speed")) db.exec("ALTER TABLE users ADD COLUMN pref_speed REAL");
  if (need("pref_theme")) db.exec("ALTER TABLE users ADD COLUMN pref_theme TEXT");
  if (need("device_note")) db.exec("ALTER TABLE users ADD COLUMN device_note TEXT");
  if (need("display_name")) db.exec("ALTER TABLE users ADD COLUMN display_name TEXT");
  if (need("trips_public")) {
    db.exec("ALTER TABLE users ADD COLUMN trips_public INTEGER NOT NULL DEFAULT 0");
  }
  if (need("is_owner")) {
    db.exec("ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0");
    // 總管理員預設為主管理員(最小 id 的 admin);與旅程回填的歸屬一致。
    db.exec(
      "UPDATE users SET is_owner = 1 WHERE id = (SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1)",
    );
  }
  const sftpCols = db.prepare("PRAGMA table_info(sftp_sessions)").all() as Array<{ name: string }>;
  if (!sftpCols.some((c) => c.name === "idle_sec")) {
    db.exec("ALTER TABLE sftp_sessions ADD COLUMN idle_sec INTEGER NOT NULL DEFAULT 600");
  }
  // 旅程擁有權:新增 owner_id 欄並一次性把既有(無歸屬)旅程回填給主管理員(最小 id 的 admin)。
  const tripCols = db.prepare("PRAGMA table_info(trips)").all() as Array<{ name: string }>;
  const needTrip = (n: string): boolean => !tripCols.some((c) => c.name === n);
  if (needTrip("owner_id")) {
    db.exec("ALTER TABLE trips ADD COLUMN owner_id INTEGER");
    db.exec(
      "UPDATE trips SET owner_id = (SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1) WHERE owner_id IS NULL",
    );
  }
  if (needTrip("public_override")) db.exec("ALTER TABLE trips ADD COLUMN public_override INTEGER");
  if (needTrip("orig_start_epoch")) db.exec("ALTER TABLE trips ADD COLUMN orig_start_epoch INTEGER");
  if (needTrip("orig_end_epoch")) db.exec("ALTER TABLE trips ADD COLUMN orig_end_epoch INTEGER");
  if (needTrip("orig_duration_sec")) db.exec("ALTER TABLE trips ADD COLUMN orig_duration_sec INTEGER");
}

/** 清掉過期 session。 */
export function purgeExpiredSessions(db: DB): void {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Math.floor(Date.now() / 1000));
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** 確保資料目錄結構存在。 */
export function ensureDataDirs(): void {
  for (const sub of ["uploads/F", "uploads/R", "uploads/NMEA", "trips", "uploads/prebuilt", "quarantine"]) {
    fs.mkdirSync(path.join(DATA_DIR, sub), { recursive: true });
  }
}
