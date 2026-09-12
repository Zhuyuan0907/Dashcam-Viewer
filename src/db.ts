/**
 * 資料庫單例(better-sqlite3)。
 * 直接沿用既有 /mnt/data/dashcam/dashcam.db,並以冪等遷移向後相容舊 schema。
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
    is_owner      INTEGER NOT NULL DEFAULT 0,
    -- 首次登入須改密碼:1=下次登入後被導到強制改密碼頁(可搭配空密碼帳號);改完歸 0
    must_change_password INTEGER NOT NULL DEFAULT 0
);

-- 一個帳號可管理多台記錄器。刪除採封存,歷史旅程另存不可變 snapshot。
CREATE TABLE IF NOT EXISTS dashcam_devices (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_key   TEXT NOT NULL,
    model         TEXT NOT NULL,
    nickname      TEXT NOT NULL DEFAULT '',
    note          TEXT NOT NULL DEFAULT '',
    show_on_trips INTEGER NOT NULL DEFAULT 1 CHECK(show_on_trips IN (0, 1)),
    is_default    INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
    archived_at   INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
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
    orig_duration_sec INTEGER,
    -- 上傳當下使用的裝置;snapshot 避免日後改名/封存造成歷史漂移
    device_id       INTEGER REFERENCES dashcam_devices(id) ON DELETE SET NULL,
    device_snapshot TEXT
);

-- 單趟旅程的免登入分享連結。驗證表只保存 SHA-256 雜湊；可取回密文另存下表。
-- 旅程刪除時分享立即失效；建立者刪除則保留分享，created_by 改為 NULL。
CREATE TABLE IF NOT EXISTS trip_shares (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash     TEXT UNIQUE NOT NULL CHECK(length(token_hash) = 64),
    trip_id        TEXT NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
    created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER,
    revoked_at     INTEGER,
    last_access_at INTEGER,
    access_count   INTEGER NOT NULL DEFAULT 0
);

-- 可取回分享連結的加密保管資料。金鑰不在 DB 內；舊分享沒有此列時仍可重新簽發。
CREATE TABLE IF NOT EXISTS trip_share_secrets (
    share_id       INTEGER PRIMARY KEY REFERENCES trip_shares(id) ON DELETE CASCADE,
    ciphertext     TEXT NOT NULL
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
    idle_sec      INTEGER NOT NULL DEFAULT 600,
    device_id       INTEGER REFERENCES dashcam_devices(id) ON DELETE SET NULL,
    device_snapshot TEXT
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

-- 匯出的片段(非破壞性「另存片段」):每列一個獨立影片檔,存於 <trip_dir>/clips/。
-- 與破壞性的整趟裁剪(trips.orig_*)無關;隨旅程刪除一併 CASCADE 清除。
CREATE TABLE IF NOT EXISTS trip_clips (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id       TEXT NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
    owner_id      INTEGER,                       -- 建立者 user id
    label         TEXT NOT NULL DEFAULT '',
    start_sec     REAL NOT NULL,
    end_sec       REAL NOT NULL,
    layout        TEXT NOT NULL,                 -- front | rear | pip
    quality       TEXT NOT NULL,                 -- precise | fast
    main_cam      TEXT,                          -- pip 主畫面(front|rear);單鏡頭為 NULL
    file_path     TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    duration_sec  REAL NOT NULL,
    created_at    INTEGER NOT NULL,
    -- 交通違規檢舉輔助:檢舉資料草稿(JSON:plate/location/violation/desc)與「已檢舉」時間
    report_json   TEXT NOT NULL DEFAULT '{}',
    reported_at   INTEGER
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
CREATE INDEX IF NOT EXISTS idx_trip_clips_trip   ON trip_clips(trip_id);
CREATE INDEX IF NOT EXISTS idx_dashcam_devices_user ON dashcam_devices(user_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_trip_shares_trip ON trip_shares(trip_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trip_shares_active ON trip_shares(trip_id, revoked_at, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dashcam_devices_one_default
  ON dashcam_devices(user_id) WHERE is_default = 1 AND archived_at IS NULL;
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
  const mediaColumns = new Set(
    (db.prepare("PRAGMA table_info(trips)").all() as { name: string }[]).map((c) => c.name),
  );
  for (const [name, type] of [
    ["timeline_json", "TEXT"],
    ["orig_timeline_json", "TEXT"],
    ["trim_offset_sec", "REAL NOT NULL DEFAULT 0"],
  ]) {
    if (!mediaColumns.has(name!)) db.exec(`ALTER TABLE trips ADD COLUMN ${name} ${type}`);
  }
  // Pre-timeline trimmed rows need their accumulated original-file offset migrated once.
  if (mediaColumns.has("orig_start_epoch")) {
    db.exec(
      "UPDATE trips SET trim_offset_sec=MAX(0,start_epoch-orig_start_epoch) WHERE orig_start_epoch IS NOT NULL AND timeline_json IS NULL AND trim_offset_sec=0",
    );
  }
  db.exec(`CREATE TABLE IF NOT EXISTS media_commits (
    id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, entries TEXT NOT NULL
  )`);
  const clipColumns = new Set(
    (db.prepare("PRAGMA table_info(trip_clips)").all() as { name: string }[]).map((c) => c.name),
  );
  for (const [name, type] of [
    ["source_start_epoch", "REAL"],
    ["source_end_epoch", "REAL"],
    ["source_version", "TEXT"],
  ]) {
    if (!clipColumns.has(name!)) db.exec(`ALTER TABLE trip_clips ADD COLUMN ${name} ${type}`);
  }
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
  if (need("must_change_password")) {
    db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
  }
  const sftpCols = db.prepare("PRAGMA table_info(sftp_sessions)").all() as Array<{ name: string }>;
  if (!sftpCols.some((c) => c.name === "idle_sec")) {
    db.exec("ALTER TABLE sftp_sessions ADD COLUMN idle_sec INTEGER NOT NULL DEFAULT 600");
  }
  if (!sftpCols.some((c) => c.name === "device_id")) {
    db.exec(
      "ALTER TABLE sftp_sessions ADD COLUMN device_id INTEGER REFERENCES dashcam_devices(id) ON DELETE SET NULL",
    );
  }
  if (!sftpCols.some((c) => c.name === "device_snapshot")) {
    db.exec("ALTER TABLE sftp_sessions ADD COLUMN device_snapshot TEXT");
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
  if (needTrip("orig_start_epoch"))
    db.exec("ALTER TABLE trips ADD COLUMN orig_start_epoch INTEGER");
  if (needTrip("orig_end_epoch")) db.exec("ALTER TABLE trips ADD COLUMN orig_end_epoch INTEGER");
  if (needTrip("orig_duration_sec"))
    db.exec("ALTER TABLE trips ADD COLUMN orig_duration_sec INTEGER");
  if (needTrip("device_id")) {
    db.exec(
      "ALTER TABLE trips ADD COLUMN device_id INTEGER REFERENCES dashcam_devices(id) ON DELETE SET NULL",
    );
  }
  if (needTrip("device_snapshot")) db.exec("ALTER TABLE trips ADD COLUMN device_snapshot TEXT");
  // 匯出片段的檢舉輔助欄位(草稿 JSON + 已檢舉時間)。
  const clipCols = db.prepare("PRAGMA table_info(trip_clips)").all() as Array<{ name: string }>;
  const needClip = (n: string): boolean => !clipCols.some((c) => c.name === n);
  if (needClip("report_json")) {
    db.exec("ALTER TABLE trip_clips ADD COLUMN report_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (needClip("reported_at")) db.exec("ALTER TABLE trip_clips ADD COLUMN reported_at INTEGER");

  // device_note(v2.0 舊欄位)→多裝置資料。以 settings marker 保證冪等,並把既有旅程
  // 快照回填成換機前的裝置;空白備註不建立虛構裝置。
  const deviceMigration = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get("schema.devices_v1") as { value: string } | undefined;
  if (!deviceMigration) {
    const tx = db.transaction(() => {
      const users = db
        .prepare("SELECT id, TRIM(COALESCE(device_note, '')) AS device_note FROM users")
        .all() as Array<{ id: number; device_note: string }>;
      const now = Math.floor(Date.now() / 1000);
      for (const u of users) {
        if (!u.device_note) continue;
        let device = db
          .prepare(
            "SELECT * FROM dashcam_devices WHERE user_id = ? ORDER BY is_default DESC, id LIMIT 1",
          )
          .get(u.id) as
          | {
              id: number;
              profile_key: string;
              model: string;
              nickname: string;
              note: string;
              show_on_trips: number;
            }
          | undefined;
        if (!device) {
          const profile = /MiVue\s*[™ ]?\s*MP20/i.test(u.device_note) ? "mivue-mp20" : "custom";
          const inserted = db
            .prepare(
              `INSERT INTO dashcam_devices
                (user_id, profile_key, model, nickname, note, show_on_trips, is_default, created_at, updated_at)
               VALUES (?, ?, ?, '', '', 1, 1, ?, ?)`,
            )
            .run(u.id, profile, u.device_note, now, now);
          device = {
            id: Number(inserted.lastInsertRowid),
            profile_key: profile,
            model: u.device_note,
            nickname: "",
            note: "",
            show_on_trips: 1,
          };
        }
        const snapshot = JSON.stringify({
          v: 1,
          profile_key: device.profile_key,
          model: device.model,
          nickname: device.nickname,
          note: device.note,
          show_on_trips: !!device.show_on_trips,
          legacy_inferred: true,
        });
        db.prepare(
          "UPDATE trips SET device_id = ?, device_snapshot = ? WHERE owner_id = ? AND device_snapshot IS NULL",
        ).run(device.id, snapshot, u.id);
      }
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, '1', ?)").run(
        "schema.devices_v1",
        now,
      );
    });
    tx();
  }
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

/**
 * 建立一份一致性的 DB 備份快照(VACUUM INTO,WAL-safe、單檔、同步)。
 * 先寫入唯一暫存檔再原子 rename,避免中途崩潰留下半成品被誤認為有效備份。
 * @returns 產生的備份檔絕對路徑。
 */
export function backupDb(db: DB, destDir: string, stamp: string): string {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, `dashcam-${stamp}.db`);
  const tmp = `${dest}.tmp`;
  fs.rmSync(tmp, { force: true });
  // VACUUM INTO 目標若已存在會失敗 → 故寫暫存檔;單引號需跳脫。
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  fs.renameSync(tmp, dest);
  return dest;
}

/** 只保留最新 keep 份 dashcam-*.db 備份,其餘刪除;順手清掉崩潰殘留的 .db.tmp 半成品。 */
export function pruneBackups(destDir: string, keep: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(destDir);
  } catch {
    return;
  }
  // 備份中途崩潰會留下 dashcam-*.db.tmp(rename 前的暫存),不清會無限累積佔磁碟。
  for (const name of names.filter((n) => /^dashcam-.*\.db\.tmp$/.test(n))) {
    fs.rmSync(path.join(destDir, name), { force: true });
  }
  const files = names.filter((n) => /^dashcam-.*\.db$/.test(n)).sort(); // 檔名含時間戳 → 字典序即時間序
  for (const name of files.slice(0, Math.max(0, files.length - keep))) {
    fs.rmSync(path.join(destDir, name), { force: true });
  }
}

/** 確保資料目錄結構存在。 */
export function ensureDataDirs(): void {
  for (const sub of [
    "uploads/F",
    "uploads/R",
    "uploads/NMEA",
    "trips",
    "uploads/prebuilt",
    "quarantine",
  ]) {
    fs.mkdirSync(path.join(DATA_DIR, sub), { recursive: true });
  }
}
