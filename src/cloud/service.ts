/**
 * 雲端備份（chunkproxy）：把旅程原始影片與資料庫快照傳到站外加密儲存。
 *
 * 與 YouTube 不同，這裡保存的是原檔（不轉檔、不會被平台下架）。上傳金鑰只能上傳，
 * 不能列出、下載或刪除雲端檔案，所以本機 cloud_backups 是「雲端有哪些檔案」的唯一紀錄；
 * 旅程刪除後紀錄仍保留（沒有外鍵串連刪除），還原時才找得到對應的雲端檔案。
 *
 * - 每個鏡頭檔一筆；超過單檔上限（10 GiB）的影片平均切成多「份」，各自一筆、各自上傳。
 * - 一次只傳一份。分段進度存 DB，重啟後從下一段續傳（伺服器閒置一小時會清掉工作階段）。
 * - 上傳前先算 SHA-256，完成時與伺服器回報的雜湊比對，不符就不算備份成功。
 * - 點數不足（402）或金鑰失效（401）會暫停整個佇列，不自動重試。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { AppContext } from "../context.js";
import { getTrip, type TripRow } from "../trips/repo.js";
import { DATA_DIR, TRIPS_DIR } from "../config.js";
import { withinTrips } from "../util/paths.js";
import { SecretVault } from "../util/secret-vault.js";
import {
  ChunkproxyClient,
  ChunkproxyError,
  compositeSha256,
  DEFAULT_ENDPOINT,
  SINGLE_MAX_BYTES,
  VOLUME_MAX_BYTES,
  type ClientOptions,
  type RemoteFile,
  type RemoteUpload,
} from "./chunkproxy.js";
import { sanitizedSnapshot } from "./snapshot.js";

export type Camera = "front" | "rear";
export type BackupStatus = "queued" | "uploading" | "done" | "failed" | "cancelled";
/** 挑選頁上每個鏡頭的狀態：none=未備份、stale=已備份但本機影片之後變更過。 */
export type CameraState = "none" | "stale" | "queued" | "uploading" | "done" | "failed" | "missing";

export interface BackupRow {
  id: number;
  kind: "trip" | "database";
  trip_id: string | null;
  camera: Camera | null;
  owner_id: number | null;
  date: string | null;
  trip_no: number | null;
  start_epoch: number | null;
  end_epoch: number | null;
  source_path: string;
  source_size: number;
  source_mtime: number;
  source_version: string;
  volume: number;
  volumes: number;
  byte_offset: number;
  byte_length: number;
  remote_name: string;
  sha256: string | null;
  status: BackupStatus;
  message: string;
  uploaded_bytes: number;
  upload_id: string | null;
  upload_secret: string | null;
  part_size: number | null;
  part_count: number | null;
  parts_done: number;
  remote_id: string | null;
  remote_sha256: string | null;
  remote_state: string | null;
  remote_checks: number;
  /** 分段上傳各段的 SHA-256（hex 依序串接）；用來核對服務端的組合校驗碼。 */
  part_sha256: string | null;
  /** 1 = 完成時服務回報的校驗碼與本機相符。 */
  verified: number;
  attempts: number;
  retry_count: number;
  not_before: number;
  created_by: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}
export interface CloudConfig {
  endpoint: string;
  secret: string | null;
  key_hint: string;
  auto_new: number;
  auto_since: number;
  db_snapshot: number;
  rate_mbps: number;
  paused: number;
  /** '' | user | credits | auth */
  pause_reason: string;
  topup_url: string | null;
  last_db_at: number;
  updated_at: number;
}
export interface LiveProgress {
  id: number;
  phase: "hashing" | "uploading" | "finishing";
  done: number;
  total: number;
  /** 最近幾秒的速度（bytes/s，平滑過）。 */
  rate: number;
  started_at: number;
  sample_at: number;
  sample_done: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cloud_backup_config(id INTEGER PRIMARY KEY CHECK(id=1), endpoint TEXT NOT NULL, secret TEXT,
 key_hint TEXT NOT NULL DEFAULT '', auto_new INTEGER NOT NULL DEFAULT 0, auto_since INTEGER NOT NULL DEFAULT 0,
 db_snapshot INTEGER NOT NULL DEFAULT 0, rate_mbps INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
 pause_reason TEXT NOT NULL DEFAULT '', topup_url TEXT, last_db_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cloud_backups(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
 trip_id TEXT, camera TEXT, owner_id INTEGER, date TEXT, trip_no INTEGER, start_epoch INTEGER, end_epoch INTEGER,
 source_path TEXT NOT NULL DEFAULT '', source_size INTEGER NOT NULL DEFAULT 0, source_mtime REAL NOT NULL DEFAULT 0,
 source_version TEXT NOT NULL, volume INTEGER NOT NULL DEFAULT 1, volumes INTEGER NOT NULL DEFAULT 1,
 byte_offset INTEGER NOT NULL DEFAULT 0, byte_length INTEGER NOT NULL DEFAULT 0, remote_name TEXT NOT NULL, sha256 TEXT,
 status TEXT NOT NULL DEFAULT 'queued', message TEXT NOT NULL DEFAULT '', uploaded_bytes INTEGER NOT NULL DEFAULT 0,
 upload_id TEXT, upload_secret TEXT, part_size INTEGER, part_count INTEGER, parts_done INTEGER NOT NULL DEFAULT 0,
 remote_id TEXT, remote_sha256 TEXT, remote_state TEXT, remote_checks INTEGER NOT NULL DEFAULT 0,
 part_sha256 TEXT, verified INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0, not_before INTEGER NOT NULL DEFAULT 0,
 created_by INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_backups_unique ON cloud_backups(kind,trip_id,camera,source_version,volume) WHERE status != 'cancelled';
CREATE INDEX IF NOT EXISTS idx_cloud_backups_due ON cloud_backups(status,not_before);
CREATE INDEX IF NOT EXISTS idx_cloud_backups_trip ON cloud_backups(trip_id,camera);
CREATE TABLE IF NOT EXISTS cloud_backup_events(id INTEGER PRIMARY KEY AUTOINCREMENT,
 backup_id INTEGER NOT NULL REFERENCES cloud_backups(id) ON DELETE CASCADE, stage TEXT NOT NULL, message TEXT NOT NULL,
 created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cloud_backup_events ON cloud_backup_events(backup_id,id);
`;

/** 不可重試的錯誤：直接標示失敗，等使用者處理。 */
export class BackupFailure extends Error {}

const MAX_TRANSIENT_RETRIES = 8;
const PART_ATTEMPTS = 3;
/** 新旅程建立後等這麼久才自動備份，避開整理後的合併/裁剪。 */
const AUTO_SETTLE_MS = 10 * 60_000;
const DB_MIN_INTERVAL_MS = 12 * 3_600_000;
const DB_MAX_INTERVAL_MS = 7 * 86_400_000;

const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

/** 影片內容版本：時間軸（裁剪會改）＋檔案大小與修改時間。 */
export function tripVersion(row: TripRow, size: number, mtime: number): string {
  return sha256(
    JSON.stringify([
      row.start_epoch,
      row.end_epoch,
      row.duration_sec,
      row.trim_offset_sec ?? 0,
      row.timeline_json ?? null,
      size,
      mtime,
    ]),
  );
}

/** 平均切成不超過上限的幾份，避免最後一份只剩一點點。 */
export function planVolumes(size: number, max: number): Array<{ offset: number; length: number }> {
  const count = Math.max(1, Math.ceil(size / max));
  const each = Math.ceil(size / count);
  const out: Array<{ offset: number; length: number }> = [];
  for (let offset = 0; offset < size; offset += each)
    out.push({ offset, length: Math.min(each, size - offset) });
  return out;
}

/** 車機牆鐘（以 UTC 存）→ HHMM。 */
const hhmm = (epoch: number) => new Date(epoch * 1000).toISOString().slice(11, 16).replace(":", "");

/** 雲端檔名：服務網站上看得懂是哪一天、哪個時段、哪個鏡頭；分卷加 .001 這類副檔名。 */
export function remoteName(
  row: Pick<TripRow, "trip_id" | "date" | "start_epoch" | "end_epoch" | "owner_id">,
  camera: Camera,
  ext: string,
  volume: number,
  volumes: number,
): string {
  const tag = sha256(row.trip_id).slice(0, 8);
  const safeExt = /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : ".mp4";
  const base = `dashcam_${row.date}_${hhmm(row.start_epoch)}-${hhmm(row.end_epoch)}_${camera}_u${row.owner_id ?? 0}-${tag}${safeExt}`;
  return volumes > 1 ? `${base}.${String(volume).padStart(3, "0")}` : base;
}

async function hashSlice(
  file: string,
  start: number,
  length: number,
  signal: AbortSignal,
  onProgress: (done: number) => void,
): Promise<string> {
  const hash = crypto.createHash("sha256");
  let done = 0;
  const stream = createReadStream(file, {
    start,
    end: start + length - 1,
    highWaterMark: 4 * 1024 * 1024,
  });
  try {
    for await (const chunk of stream) {
      if (signal.aborted) throw new ChunkproxyError("aborted");
      hash.update(chunk as Buffer);
      done += (chunk as Buffer).length;
      onProgress(done);
    }
  } finally {
    stream.destroy();
  }
  if (done !== length) throw new BackupFailure("本機檔案長度已變更，請重新加入備份");
  return hash.digest("hex");
}

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export interface CloudBackupOptions {
  clock?: () => number;
  vault?: SecretVault;
  /** 測試用：縮小分卷與單次上傳的門檻。 */
  volumeMaxBytes?: number;
  singleMaxBytes?: number;
  snapshotDir?: string;
  intervalMs?: number;
  /** 單一分段的重試等待基準（毫秒）。 */
  retryDelayMs?: number;
  /** 服務日誌（Fastify 的 app.log）；失敗原因會寫進去，方便事後查。 */
  log?: CloudLogger;
  /** 測試用：連線逾時與 DNS 查詢。 */
  client?: ClientOptions;
}

export interface CloudLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** 整個佇列因連線問題等待重試時，給狀態頁顯示的原因與時間。 */
export interface CloudWaitState {
  until: number;
  since: number;
  message: string;
  failures: number;
}

export class CloudBackupService {
  readonly vault: SecretVault;
  private readonly clock: () => number;
  private readonly volumeMax: number;
  private readonly singleMax: number;
  private readonly snapshotDir: string;
  private readonly intervalMs: number;
  private readonly retryDelayMs: number;
  private timer?: NodeJS.Timeout;
  private running: {
    id: number;
    controller: AbortController;
    promise: Promise<void>;
    reason: "" | "cancel" | "pause" | "stop";
  } | null = null;
  private stopped = false;
  private ticking = false;
  private lastAutoScan = 0;
  private lastRemoteCheck = 0;
  /** 連線類錯誤後整個佇列一起等待，避免服務中斷時把每一項的重試次數都耗光。 */
  private cooldownUntil = 0;
  private failures = 0;
  /** 這一輪等待的原因與開始時間（成功上傳後清除）。 */
  private waiting: { message: string; since: number } | null = null;
  private readonly log?: CloudLogger;
  private readonly clientOptions: ClientOptions;
  live: LiveProgress | null = null;

  constructor(
    private readonly ctx: AppContext,
    opts: CloudBackupOptions = {},
  ) {
    this.clock = opts.clock ?? Date.now;
    this.vault = opts.vault ?? new SecretVault(path.join(DATA_DIR, "cloud-backup.key"), "雲端備份");
    this.volumeMax = opts.volumeMaxBytes ?? VOLUME_MAX_BYTES;
    this.singleMax = opts.singleMaxBytes ?? SINGLE_MAX_BYTES;
    this.snapshotDir = opts.snapshotDir ?? path.join(DATA_DIR, "cloud-backup");
    this.intervalMs = opts.intervalMs ?? 5000;
    this.retryDelayMs = opts.retryDelayMs ?? 2000;
    this.log = opts.log;
    this.clientOptions = opts.client ?? {};
    ctx.db.exec(SCHEMA);
    // 2.10.1 以前建立的資料表補上欄位；當時只有整檔 SHA-256 相同才算核對過。
    const columns = new Set(
      (ctx.db.prepare("PRAGMA table_info(cloud_backups)").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    if (!columns.has("part_sha256"))
      ctx.db.exec("ALTER TABLE cloud_backups ADD COLUMN part_sha256 TEXT");
    if (!columns.has("verified")) {
      ctx.db.exec("ALTER TABLE cloud_backups ADD COLUMN verified INTEGER NOT NULL DEFAULT 0");
      ctx.db.exec(
        "UPDATE cloud_backups SET verified=1 WHERE status='done' AND remote_sha256 IS NOT NULL AND remote_sha256=sha256",
      );
    }
    const interrupted = ctx.db
      .prepare("SELECT id FROM cloud_backups WHERE status='uploading'")
      .all() as { id: number }[];
    for (const row of interrupted)
      this.update(row.id, "queued", "服務重啟，將從上次完成的分段續傳");
  }

  // ── 設定 ───────────────────────────────────────────────────
  config(): CloudConfig {
    const now = this.clock();
    this.ctx.db
      .prepare("INSERT OR IGNORE INTO cloud_backup_config(id,endpoint,updated_at) VALUES(1,?,?)")
      .run(DEFAULT_ENDPOINT, now);
    return this.ctx.db.prepare("SELECT * FROM cloud_backup_config WHERE id=1").get() as CloudConfig;
  }
  private apiKey(): string | null {
    const config = this.config();
    return config.secret ? this.vault.open<string>(config.secret, "cloud:api-key") : null;
  }
  client(): ChunkproxyClient {
    const key = this.apiKey();
    if (!key) throw new BackupFailure("尚未設定雲端備份的 API 金鑰");
    return new ChunkproxyClient(this.config().endpoint, key, this.clientOptions);
  }
  setKey(key: string): void {
    this.config();
    this.ctx.db
      .prepare(
        `UPDATE cloud_backup_config SET secret=?,key_hint=?,updated_at=?,
         paused=CASE WHEN pause_reason='auth' THEN 0 ELSE paused END,
         pause_reason=CASE WHEN pause_reason='auth' THEN '' ELSE pause_reason END WHERE id=1`,
      )
      .run(this.vault.seal(key, "cloud:api-key"), key.slice(-4), this.clock());
  }
  async clearKey(): Promise<void> {
    await this.interrupt("pause");
    this.config();
    this.ctx.db
      .prepare("UPDATE cloud_backup_config SET secret=NULL,key_hint='',updated_at=? WHERE id=1")
      .run(this.clock());
  }
  updateSettings(settings: {
    auto_new?: boolean;
    db_snapshot?: boolean;
    rate_mbps?: number;
    endpoint?: string;
  }): void {
    const current = this.config();
    const now = this.clock();
    const autoNew = settings.auto_new ?? !!current.auto_new;
    this.ctx.db
      .prepare(
        `UPDATE cloud_backup_config SET auto_new=?,auto_since=?,db_snapshot=?,rate_mbps=?,endpoint=?,updated_at=? WHERE id=1`,
      )
      .run(
        autoNew ? 1 : 0,
        // 開啟自動備份的那一刻起算「新旅程」，不會一口氣把既有旅程全部排進去。
        autoNew && !current.auto_new ? now : current.auto_since,
        (settings.db_snapshot ?? !!current.db_snapshot) ? 1 : 0,
        settings.rate_mbps ?? current.rate_mbps,
        settings.endpoint ?? current.endpoint,
        now,
      );
  }
  async setPaused(paused: boolean): Promise<void> {
    this.config();
    if (paused) {
      this.ctx.db
        .prepare(
          "UPDATE cloud_backup_config SET paused=1,pause_reason='user',updated_at=? WHERE id=1",
        )
        .run(this.clock());
      await this.interrupt("pause");
    } else {
      this.ctx.db
        .prepare(
          "UPDATE cloud_backup_config SET paused=0,pause_reason='',topup_url=NULL,updated_at=? WHERE id=1",
        )
        .run(this.clock());
      // 使用者按「繼續備份」就是要現在開始，不必再等之前連線失敗排定的重試時間。
      this.retryNow();
    }
  }

  /** 整個佇列正在等待重試時的原因與下次重試時間；沒有在等就回傳 null。 */
  waitState(): CloudWaitState | null {
    if (!this.waiting || this.clock() >= this.cooldownUntil) return null;
    return {
      until: this.cooldownUntil,
      since: this.waiting.since,
      message: this.waiting.message,
      failures: this.failures,
    };
  }

  /** 立即重試：結束整個佇列的等待，排定稍後重試的項目也改成現在就可以執行（下一輪就開始）。 */
  retryNow(): number {
    this.cooldownUntil = 0;
    const now = this.clock();
    return this.ctx.db
      .prepare("UPDATE cloud_backups SET not_before=? WHERE status='queued' AND not_before>?")
      .run(now, now).changes;
  }
  private pauseFor(reason: "credits" | "auth", topupUrl: string | null = null): void {
    this.ctx.db
      .prepare(
        "UPDATE cloud_backup_config SET paused=1,pause_reason=?,topup_url=?,updated_at=? WHERE id=1",
      )
      .run(reason, topupUrl, this.clock());
  }

  /**
   * 檢查金鑰與點數：開一個 1 MB 的分段上傳再立刻取消（取消會退還點數）。
   * 點數為 0 時伺服器回 402，不會扣款。成功時順便解除因點數/金鑰造成的暫停。
   */
  async check(): Promise<{
    ok: boolean;
    reason?: string;
    message: string;
    topup_url?: string | null;
  }> {
    const client = this.client();
    try {
      const upload = await client.createUpload(
        "dashcam-backup-check.bin",
        1024 * 1024,
        "application/octet-stream",
      );
      await client.abort(upload).catch(() => {});
    } catch (error) {
      if (error instanceof ChunkproxyError) {
        if (error.reason === "credits") this.pauseFor("credits", error.topupUrl);
        if (error.reason === "auth") this.pauseFor("auth");
        return {
          ok: false,
          reason: error.reason,
          message: error.message,
          topup_url: error.topupUrl,
        };
      }
      throw error;
    }
    const config = this.config();
    if (config.paused && ["credits", "auth"].includes(config.pause_reason))
      await this.setPaused(false);
    // 連得上也開得了上傳：之前因連線問題排定的等待可以直接結束。
    else this.retryNow();
    return { ok: true, message: "金鑰有效、點數足夠；測試用的上傳已取消並退還點數" };
  }

  // ── 紀錄 ───────────────────────────────────────────────────
  get(id: number): BackupRow | undefined {
    return this.ctx.db.prepare("SELECT * FROM cloud_backups WHERE id=?").get(id) as
      | BackupRow
      | undefined;
  }
  event(id: number, stage: string, message: string): void {
    this.ctx.db
      .prepare(
        "INSERT INTO cloud_backup_events(backup_id,stage,message,created_at) VALUES(?,?,?,?)",
      )
      .run(id, stage, message, this.clock());
  }
  events(id: number): Array<{ stage: string; message: string; created_at: number }> {
    return this.ctx.db
      .prepare(
        "SELECT stage,message,created_at FROM cloud_backup_events WHERE backup_id=? ORDER BY id DESC LIMIT 50",
      )
      .all(id) as Array<{ stage: string; message: string; created_at: number }>;
  }
  private update(id: number, status: BackupStatus, message: string, notBefore?: number): void {
    this.ctx.db
      .prepare(
        "UPDATE cloud_backups SET status=?,message=?,updated_at=?,not_before=COALESCE(?,not_before) WHERE id=?",
      )
      .run(status, message, this.clock(), notBefore ?? null, id);
    this.event(id, status, message);
  }
  /** 只更新目前訊息（不寫事件），讓列表看得到現在在做什麼。 */
  private note(id: number, message: string): void {
    this.ctx.db
      .prepare("UPDATE cloud_backups SET message=?,updated_at=? WHERE id=?")
      .run(message, this.clock(), id);
  }
  /** 同一個檔案（同一版本）的所有分卷。 */
  group(row: BackupRow): BackupRow[] {
    return this.ctx.db
      .prepare(
        "SELECT * FROM cloud_backups WHERE kind=? AND trip_id IS ? AND camera IS ? AND source_version=? AND status!='cancelled' ORDER BY volume",
      )
      .all(row.kind, row.trip_id, row.camera, row.source_version) as BackupRow[];
  }

  // ── 來源影片 ─────────────────────────────────────────────────
  async source(row: TripRow, camera: Camera) {
    const file = row[`${camera}_path`];
    if (!row[`has_${camera}`] || !file || !withinTrips(file)) return null;
    try {
      const real = await fs.realpath(file);
      if (!withinTrips(real)) return null;
      const stat = await fs.stat(real);
      if (!stat.isFile() || stat.size <= 0) return null;
      return {
        file,
        size: stat.size,
        mtime: stat.mtimeMs,
        version: tripVersion(row, stat.size, stat.mtimeMs),
      };
    } catch {
      return null;
    }
  }

  /** 每趟每個鏡頭目前的備份狀態（以目前影片版本判斷）。 */
  async states(
    trips: TripRow[],
  ): Promise<
    Map<string, Array<{ camera: Camera; size: number; state: CameraState; done_at: number | null }>>
  > {
    const rows = this.ctx.db
      .prepare(
        `SELECT trip_id,camera,source_version,volumes,status,COUNT(*) AS n,MAX(completed_at) AS done_at
         FROM cloud_backups WHERE kind='trip' AND status!='cancelled' GROUP BY trip_id,camera,source_version,status`,
      )
      .all() as Array<{
      trip_id: string;
      camera: Camera;
      source_version: string;
      volumes: number;
      status: BackupStatus;
      n: number;
      done_at: number | null;
    }>;
    const index = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.trip_id}\n${r.camera}`;
      index.set(key, [...(index.get(key) ?? []), r]);
    }
    const out = new Map<
      string,
      Array<{ camera: Camera; size: number; state: CameraState; done_at: number | null }>
    >();
    for (const trip of trips) {
      const cams: Array<{
        camera: Camera;
        size: number;
        state: CameraState;
        done_at: number | null;
      }> = [];
      for (const camera of ["front", "rear"] as const) {
        if (!trip[`has_${camera}`]) continue;
        const source = await this.source(trip, camera);
        const all = index.get(`${trip.trip_id}\n${camera}`) ?? [];
        if (!source) {
          cams.push({ camera, size: 0, state: "missing", done_at: null });
          continue;
        }
        const current = all.filter((r) => r.source_version === source.version);
        const count = (status: BackupStatus) =>
          current.filter((r) => r.status === status).reduce((n, r) => n + r.n, 0);
        const volumes = current[0]?.volumes ?? 1;
        let state: CameraState = "none";
        if (current.length) {
          if (count("done") >= volumes) state = "done";
          else if (count("uploading")) state = "uploading";
          else if (count("queued")) state = "queued";
          else if (count("failed")) state = "failed";
        } else if (all.some((r) => r.status === "done")) state = "stale";
        const doneAt = current.find((r) => r.status === "done")?.done_at ?? null;
        cams.push({ camera, size: source.size, state, done_at: state === "done" ? doneAt : null });
      }
      out.set(trip.trip_id, cams);
    }
    return out;
  }

  /** 挑選頁：旅程（新到舊）＋每個鏡頭的備份狀態。 */
  async trips(filter: "pending" | "all" | "done", page: number, limit: number) {
    const trips = this.ctx.db
      .prepare(
        `SELECT t.*,u.username AS owner_username,u.display_name AS owner_display_name FROM trips t
         LEFT JOIN users u ON u.id=t.owner_id WHERE t.superseded_by IS NULL ORDER BY t.date DESC,t.start_epoch DESC`,
      )
      .all() as Array<
      TripRow & { owner_username: string | null; owner_display_name: string | null }
    >;
    const states = await this.states(trips);
    const pending = (s: CameraState) => s === "none" || s === "stale" || s === "failed";
    const summary = {
      trips: 0,
      files: 0,
      bytes: 0,
      /** 全部完成需要的上傳次數（每份分卷 1 次）。 */
      uploads: 0,
      done_files: 0,
      done_bytes: 0,
      total_files: 0,
    };
    const rows = trips
      .map((t) => ({ trip: t, cameras: states.get(t.trip_id) ?? [] }))
      .filter(({ cameras }) => cameras.length > 0);
    for (const { cameras } of rows) {
      const todo = cameras.filter((c) => pending(c.state));
      if (todo.length) summary.trips++;
      summary.files += todo.length;
      summary.bytes += todo.reduce((n, c) => n + c.size, 0);
      summary.uploads += todo.reduce(
        (n, c) => n + Math.max(1, Math.ceil(c.size / this.volumeMax)),
        0,
      );
      summary.total_files += cameras.filter((c) => c.state !== "missing").length;
      const done = cameras.filter((c) => c.state === "done");
      summary.done_files += done.length;
      summary.done_bytes += done.reduce((n, c) => n + c.size, 0);
    }
    const filtered = rows.filter(({ cameras }) =>
      filter === "all"
        ? true
        : filter === "done"
          ? cameras.some((c) => c.state === "done")
          : cameras.some((c) => pending(c.state)),
    );
    const start = (page - 1) * limit;
    return {
      total: filtered.length,
      summary,
      trips: filtered.slice(start, start + limit).map(({ trip, cameras }) => ({
        trip_id: trip.trip_id,
        date: trip.date,
        trip_no: trip.day_order,
        start_epoch: trip.start_epoch,
        end_epoch: trip.end_epoch,
        duration_sec: trip.duration_sec,
        owner: trip.owner_display_name || trip.owner_username || null,
        cameras,
      })),
    };
  }

  // ── 加入佇列 ─────────────────────────────────────────────────
  async enqueue(
    tripIds: string[],
    cameras: "both" | Camera,
    user: number | null,
    only?: (state: CameraState) => boolean,
  ): Promise<{ added: number; skipped: number; bytes: number }> {
    if (!this.config().secret) throw new BackupFailure("請先設定雲端備份的 API 金鑰");
    const plans: Array<{
      trip: TripRow;
      camera: Camera;
      file: string;
      size: number;
      mtime: number;
      version: string;
    }> = [];
    let skipped = 0;
    for (const id of [...new Set(tripIds)]) {
      const trip = getTrip(this.ctx.db, id);
      if (!trip) throw new BackupFailure("找不到選擇的旅程，請重新整理");
      if (trip.superseded_by) {
        skipped++;
        continue;
      }
      const states = only ? ((await this.states([trip])).get(trip.trip_id) ?? []) : [];
      for (const camera of ["front", "rear"] as const) {
        if (cameras !== "both" && camera !== cameras) continue;
        if (!trip[`has_${camera}`]) continue;
        if (only && !only(states.find((s) => s.camera === camera)?.state ?? "missing")) continue;
        const source = await this.source(trip, camera);
        if (!source) {
          skipped++;
          continue;
        }
        plans.push({ trip, camera, ...source });
      }
    }
    const insert = this.ctx.db.prepare(
      `INSERT OR IGNORE INTO cloud_backups(kind,trip_id,camera,owner_id,date,trip_no,start_epoch,end_epoch,source_path,
       source_size,source_mtime,source_version,volume,volumes,byte_offset,byte_length,remote_name,not_before,created_by,
       created_at,updated_at) VALUES('trip',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    let added = 0,
      bytes = 0;
    const now = this.clock();
    this.ctx.db.transaction(() => {
      for (const p of plans) {
        const volumes = planVolumes(p.size, this.volumeMax);
        const ext = path.extname(p.file).toLowerCase();
        let fresh = 0;
        volumes.forEach((v, i) => {
          const result = insert.run(
            p.trip.trip_id,
            p.camera,
            p.trip.owner_id,
            p.trip.date,
            p.trip.day_order,
            p.trip.start_epoch,
            p.trip.end_epoch,
            p.file,
            p.size,
            p.mtime,
            p.version,
            i + 1,
            volumes.length,
            v.offset,
            v.length,
            remoteName(p.trip, p.camera, ext, i + 1, volumes.length),
            now,
            user,
            now,
            now,
          );
          if (result.changes) {
            fresh++;
            this.event(
              Number(result.lastInsertRowid),
              "queued",
              volumes.length > 1
                ? `已加入備份佇列（第 ${i + 1}/${volumes.length} 份）`
                : "已加入備份佇列",
            );
          }
        });
        // 同版本已有紀錄：失敗的重新排入，其餘（已完成或進行中）視為重複略過。
        const failed = this.ctx.db
          .prepare(
            "SELECT id FROM cloud_backups WHERE kind='trip' AND trip_id=? AND camera=? AND source_version=? AND status='failed'",
          )
          .all(p.trip.trip_id, p.camera, p.version) as { id: number }[];
        for (const f of failed) {
          this.ctx.db.prepare("UPDATE cloud_backups SET retry_count=0 WHERE id=?").run(f.id);
          this.update(f.id, "queued", "重新加入備份佇列", now);
        }
        if (fresh || failed.length) {
          added++;
          bytes += p.size;
        } else skipped++;
      }
    })();
    return { added, skipped, bytes };
  }

  /** 立即排一份資料庫快照（已有等待中的就不重複）。 */
  enqueueDatabase(user: number | null, why = "手動要求"): boolean {
    if (!this.config().secret) throw new BackupFailure("請先設定雲端備份的 API 金鑰");
    const pending = this.ctx.db
      .prepare(
        "SELECT 1 FROM cloud_backups WHERE kind='database' AND status IN ('queued','uploading')",
      )
      .get();
    if (pending) return false;
    const now = this.clock();
    const stamp = new Date(now).toISOString().slice(0, 16).replace("T", "_").replace(":", "");
    const result = this.ctx.db
      .prepare(
        `INSERT INTO cloud_backups(kind,source_version,remote_name,not_before,created_by,created_at,updated_at)
         VALUES('database',?,?,?,?,?,?)`,
      )
      .run(`db:${now}:${crypto.randomUUID()}`, `dashcam-db_${stamp}Z.sqlite`, now, user, now, now);
    this.event(Number(result.lastInsertRowid), "queued", `資料庫快照已排入（${why}）`);
    return true;
  }

  retry(id: number): number {
    const row = this.get(id);
    if (!row || row.status !== "failed") throw new BackupFailure("此項目目前無法重試");
    let n = 0;
    for (const r of this.group(row))
      if (r.status === "failed") {
        this.ctx.db.prepare("UPDATE cloud_backups SET retry_count=0 WHERE id=?").run(r.id);
        this.update(r.id, "queued", "使用者要求重新嘗試", this.clock());
        n++;
      }
    return n;
  }

  /** 取消整個檔案（所有分卷）；進行中的分段上傳會通知雲端取消並退還點數。已完成的分卷保留紀錄。 */
  async cancel(id: number): Promise<number> {
    const row = this.get(id);
    if (!row || !["queued", "uploading", "failed"].includes(row.status))
      throw new BackupFailure("此項目目前無法取消");
    const members = this.group(row);
    if (this.running && members.some((r) => r.id === this.running!.id))
      await this.interrupt("cancel");
    let n = 0;
    for (const member of this.group(row)) {
      if (member.status === "done") continue;
      await this.abandon(member);
      this.update(member.id, "cancelled", "使用者取消");
      n++;
    }
    return n;
  }

  /** 取消所有尚未開始的項目（進行中的那一份不受影響）。 */
  async cancelQueued(): Promise<number> {
    const rows = this.ctx.db
      .prepare("SELECT * FROM cloud_backups WHERE status='queued'")
      .all() as BackupRow[];
    let n = 0;
    for (const row of rows) {
      if (this.running?.id === row.id) continue;
      await this.abandon(row);
      this.update(row.id, "cancelled", "使用者取消所有等待中的項目");
      n++;
    }
    return n;
  }

  /** 放棄一份：取消雲端分段上傳（退點）並清掉暫存的資料庫快照。 */
  private async abandon(row: BackupRow): Promise<void> {
    if (row.upload_id && row.upload_secret) {
      try {
        const token = this.vault.open<string>(row.upload_secret, `cloud:upload:${row.id}`);
        await this.client().abort({ id: row.upload_id, upload_token: token });
        this.event(row.id, "abort", "已通知儲存服務取消分段上傳並退還點數");
      } catch {
        this.event(row.id, "abort", "無法通知儲存服務取消；閒置一小時後會自動清除並退還點數");
      }
      this.ctx.db
        .prepare("UPDATE cloud_backups SET upload_id=NULL,upload_secret=NULL WHERE id=?")
        .run(row.id);
    }
    if (row.kind === "database" && row.source_path)
      await fs.rm(row.source_path, { force: true }).catch(() => {});
  }

  // ── 列表與統計 ───────────────────────────────────────────────
  list(view: "active" | "done" | "cancelled", page: number, limit: number) {
    const where =
      view === "active"
        ? "status IN ('queued','uploading','failed')"
        : view === "done"
          ? "status='done'"
          : "status='cancelled'";
    const order =
      view === "active"
        ? "CASE status WHEN 'uploading' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,(kind='database') DESC,not_before,id"
        : view === "done"
          ? "completed_at DESC,id DESC"
          : "updated_at DESC,id DESC";
    const total = (
      this.ctx.db.prepare(`SELECT COUNT(*) AS n FROM cloud_backups WHERE ${where}`).get() as {
        n: number;
      }
    ).n;
    const rows = this.ctx.db
      .prepare(`SELECT * FROM cloud_backups WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(limit, (page - 1) * limit) as BackupRow[];
    return { total, rows };
  }
  stats() {
    const counts = Object.fromEntries(
      (
        this.ctx.db
          .prepare(
            "SELECT status,COUNT(*) AS n,SUM(byte_length) AS bytes,SUM(uploaded_bytes) AS sent FROM cloud_backups GROUP BY status",
          )
          .all() as Array<{ status: string; n: number; bytes: number | null; sent: number | null }>
      ).map((r) => [r.status, { n: r.n, bytes: r.bytes ?? 0, sent: r.sent ?? 0 }]),
    ) as Record<string, { n: number; bytes: number; sent: number }>;
    // 所有分卷都完成才算備份好一支影片。
    const doneFiles = this.ctx.db
      .prepare(
        `SELECT COUNT(*) AS n,COALESCE(SUM(size),0) AS bytes FROM (SELECT MAX(source_size) AS size FROM cloud_backups
         WHERE kind='trip' AND status='done' GROUP BY trip_id,camera,source_version HAVING COUNT(*)>=MAX(volumes))`,
      )
      .get() as { n: number; bytes: number };
    const lastDone = this.ctx.db
      .prepare("SELECT MAX(completed_at) AS t FROM cloud_backups WHERE status='done'")
      .get() as { t: number | null };
    const pick = (s: string) => counts[s] ?? { n: 0, bytes: 0, sent: 0 };
    const queued = pick("queued"),
      uploading = pick("uploading");
    const sending = this.live?.phase === "uploading" ? this.live.done : uploading.sent;
    const remaining = queued.bytes - queued.sent + uploading.bytes - sending;
    return {
      queued: pick("queued").n,
      uploading: pick("uploading").n,
      failed: pick("failed").n,
      done: pick("done").n,
      done_bytes: pick("done").bytes,
      done_files: doneFiles.n,
      done_file_bytes: doneFiles.bytes,
      remaining_bytes: Math.max(0, remaining),
      last_done_at: lastDone.t,
    };
  }
  /** 還原用清單：所有已完成的雲端檔案。 */
  manifest(): BackupRow[] {
    return this.ctx.db
      .prepare(
        "SELECT * FROM cloud_backups WHERE status='done' ORDER BY kind,date,start_epoch,camera,volume,id",
      )
      .all() as BackupRow[];
  }
  relativeSource(row: BackupRow): string {
    if (row.kind !== "trip" || !row.source_path) return "";
    const rel = path.relative(TRIPS_DIR, row.source_path);
    return rel.startsWith("..") || path.isAbsolute(rel) ? path.basename(row.source_path) : rel;
  }

  // ── 背景工作 ─────────────────────────────────────────────────
  async start(): Promise<void> {
    // 只留下還在等待或可重試的資料庫快照，其餘是中斷殘留。
    const keep = new Set(
      (
        this.ctx.db
          .prepare(
            "SELECT source_path FROM cloud_backups WHERE kind='database' AND status IN ('queued','uploading','failed')",
          )
          .all() as { source_path: string }[]
      ).map((r) => path.resolve(r.source_path)),
    );
    for (const name of await fs.readdir(this.snapshotDir).catch(() => [] as string[])) {
      const file = path.resolve(this.snapshotDir, name);
      if (!keep.has(file)) await fs.rm(file, { force: true }).catch(() => {});
    }
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, this.intervalMs);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.interrupt("stop");
  }
  private async interrupt(reason: "cancel" | "pause" | "stop"): Promise<void> {
    const running = this.running;
    if (!running) return;
    running.reason = reason;
    running.controller.abort();
    await running.promise;
  }

  async tick(): Promise<void> {
    if (this.stopped || this.running || this.ticking) return;
    this.ticking = true;
    try {
      const config = this.config();
      if (!config.secret || config.paused) return;
      const now = this.clock();
      if (now < this.cooldownUntil) return;
      if (now - this.lastAutoScan >= 60_000) {
        this.lastAutoScan = now;
        await this.autoEnqueue(config);
        this.scheduleDatabase(config);
      }
      if (now - this.lastRemoteCheck >= 120_000) {
        this.lastRemoteCheck = now;
        await this.checkRemote();
      }
      const row = this.ctx.db
        .prepare(
          "SELECT * FROM cloud_backups WHERE status='queued' AND not_before<=? ORDER BY (kind='database') DESC,(upload_id IS NOT NULL) DESC,not_before,id LIMIT 1",
        )
        .get(this.clock()) as BackupRow | undefined;
      // 等待上面的非同步步驟時服務可能已在關閉。
      if (!row || this.stopped) return;
      const controller = new AbortController();
      const running = {
        id: row.id,
        controller,
        reason: "" as "" | "cancel" | "pause" | "stop",
        promise: Promise.resolve(),
      };
      running.promise = this.run(row, controller, () => running.reason).finally(() => {
        this.running = null;
        this.live = null;
      });
      this.running = running;
      await running.promise;
    } finally {
      this.ticking = false;
    }
  }

  /** 自動備份：開啟後新建立的旅程，若目前版本還沒備份就排入（失敗的不自動重排）。 */
  private async autoEnqueue(config: CloudConfig): Promise<void> {
    if (!config.auto_new) return;
    const ids = (
      this.ctx.db
        .prepare(
          "SELECT trip_id FROM trips WHERE superseded_by IS NULL AND created_at*1000>=? AND created_at*1000<=? ORDER BY created_at",
        )
        .all(config.auto_since, this.clock() - AUTO_SETTLE_MS) as { trip_id: string }[]
    ).map((r) => r.trip_id);
    if (!ids.length) return;
    await this.enqueue(ids, "both", null, (s) => s === "none" || s === "stale").catch(() => {});
  }

  /**
   * 影片都傳完、且之後有新的完成項目時補一份資料庫快照（最多每 12 小時一次）；
   * 沒有新備份時每 7 天仍備份一次，讓備註與片段紀錄也有站外副本。
   */
  private scheduleDatabase(config: CloudConfig): void {
    if (!config.db_snapshot) return;
    const now = this.clock();
    if (now - config.last_db_at < DB_MIN_INTERVAL_MS) return;
    const busy = this.ctx.db
      .prepare("SELECT 1 FROM cloud_backups WHERE status IN ('queued','uploading') LIMIT 1")
      .get();
    if (busy) return;
    const fresh = this.ctx.db
      .prepare(
        "SELECT 1 FROM cloud_backups WHERE kind='trip' AND status='done' AND completed_at>? LIMIT 1",
      )
      .get(config.last_db_at);
    if (!fresh && config.last_db_at && now - config.last_db_at < DB_MAX_INTERVAL_MS) return;
    this.enqueueDatabase(null, "自動排程");
  }

  /**
   * 核對服務完成時回報的校驗碼。單次上傳回報整個檔案的 SHA-256；分段上傳回報各段 SHA-256 的組合
   * （compositeSha256）。各段雜湊在上傳時就記下；缺的（例如由舊版開始的上傳）從本機原檔逐段補算。
   */
  private async matchesRemote(id: number, reported: string, signal: AbortSignal): Promise<boolean> {
    const row = this.get(id)!;
    if (reported === row.sha256) return true;
    const composite = /^[0-9a-f]{64}-(\d+)$/.exec(reported);
    if (!composite || !row.part_size || !row.part_count || Number(composite[1]) !== row.part_count)
      return false;
    let hashes: string[] =
      row.part_sha256?.length === row.part_count * 64 ? row.part_sha256.match(/.{64}/g)! : [];
    if (!hashes.length) {
      this.note(id, "重新讀取本機檔案，逐段核對雲端校驗碼");
      this.event(id, "verify", "重新讀取本機檔案，逐段核對雲端校驗碼");
      for (let n = 0; n < row.part_count; n++) {
        const start = n * row.part_size;
        const length = Math.min(row.part_size, row.byte_length - start);
        hashes.push(
          await hashSlice(row.source_path, row.byte_offset + start, length, signal, (done) =>
            this.progress(id, "hashing", start + done, row.byte_length),
          ),
        );
      }
    }
    return compositeSha256(hashes) === reported;
  }

  /** 完成時伺服器若回報仍在處理，稍後盡力再查一次（上傳金鑰可能沒有查詢權限，查不到就保留原狀）。 */
  private async checkRemote(): Promise<void> {
    const row = this.ctx.db
      .prepare(
        "SELECT * FROM cloud_backups WHERE status='done' AND remote_id IS NOT NULL AND remote_state='pending' AND remote_checks<3 ORDER BY completed_at LIMIT 1",
      )
      .get() as BackupRow | undefined;
    if (!row) return;
    try {
      const remote = await this.client().status(row.remote_id!, AbortSignal.timeout(30_000));
      this.ctx.db
        .prepare("UPDATE cloud_backups SET remote_state=?,remote_checks=remote_checks+1 WHERE id=?")
        .run(remote.state, row.id);
      if (/^(failed|error)$/i.test(remote.state))
        this.update(row.id, "failed", "儲存服務回報這個檔案儲存失敗，請重試");
    } catch {
      this.ctx.db
        .prepare("UPDATE cloud_backups SET remote_checks=remote_checks+1 WHERE id=?")
        .run(row.id);
    }
  }

  private progress(id: number, phase: LiveProgress["phase"], done: number, total: number): void {
    const now = this.clock();
    const live = this.live;
    if (!live || live.id !== id || live.phase !== phase) {
      this.live = {
        id,
        phase,
        done,
        total,
        rate: 0,
        started_at: now,
        sample_at: now,
        sample_done: done,
      };
      return;
    }
    live.done = done;
    live.total = total;
    const elapsed = now - live.sample_at;
    if (elapsed >= 2000) {
      const instant = ((done - live.sample_done) * 1000) / elapsed;
      live.rate = live.rate ? live.rate * 0.6 + instant * 0.4 : instant;
      live.sample_at = now;
      live.sample_done = done;
    }
  }

  private async run(
    row: BackupRow,
    controller: AbortController,
    reason: () => string,
  ): Promise<void> {
    const { db, jobs } = this.ctx;
    let lockedTrip: string | null = null,
      lockedOwner: number | null = null;
    const signal = controller.signal;
    try {
      const client = this.client();
      this.update(row.id, "uploading", row.parts_done ? "繼續上傳" : "準備上傳");
      if (row.kind === "trip") {
        const tripId = row.trip_id!;
        if (jobs.busy(tripId)) {
          this.update(row.id, "queued", "等待此旅程的裁剪或匯出完成", this.clock() + 30_000);
          return;
        }
        jobs.registerTrim(tripId, controller);
        lockedTrip = tripId;
        if (row.owner_id !== null) {
          jobs.registerOwnerProcess(row.owner_id);
          lockedOwner = row.owner_id;
        }
        const trip = getTrip(db, tripId);
        if (!trip) throw new BackupFailure("本機旅程已刪除，無法備份");
        const source = await this.source(trip, row.camera!);
        if (!source) throw new BackupFailure("找不到本機影片檔，無法備份");
        if (source.version !== row.source_version || source.file !== row.source_path) {
          if (
            row.upload_id ||
            row.uploaded_bytes > 0 ||
            this.group(row).some((r) => r.status === "done")
          )
            throw new BackupFailure("本機影片在備份途中被變更（例如裁剪），請重新加入備份");
          // 還沒開始傳：改備份目前的版本。
          for (const member of this.group(row))
            if (member.status !== "done")
              this.update(member.id, "cancelled", "本機影片已變更，改為備份目前的版本");
          if (lockedTrip) jobs.unregisterTrim(lockedTrip);
          lockedTrip = null;
          await this.enqueue([tripId], row.camera!, row.created_by);
          return;
        }
      } else if (!row.source_path || !(await fs.stat(row.source_path).catch(() => null))) {
        // 資料庫快照在要上傳時才產生，內容才是最新的。
        this.progress(row.id, "hashing", 0, 0);
        const file = path.join(this.snapshotDir, `${row.id}-${row.remote_name}`);
        const size = sanitizedSnapshot(db, file);
        const stat = await fs.stat(file);
        db.prepare(
          `UPDATE cloud_backups SET source_path=?,source_size=?,source_mtime=?,byte_offset=0,byte_length=?,sha256=NULL,
           upload_id=NULL,upload_secret=NULL,part_size=NULL,part_count=NULL,parts_done=0,uploaded_bytes=0 WHERE id=?`,
        ).run(file, size, stat.mtimeMs, size, row.id);
        this.event(row.id, "snapshot", "已建立資料庫快照（已移除登入憑證與上傳密碼）");
        row = this.get(row.id)!;
      }
      if (!row.sha256) {
        this.note(row.id, "計算 SHA-256 校驗碼");
        this.event(row.id, "hash", "計算 SHA-256 校驗碼");
        const digest = await hashSlice(
          row.source_path,
          row.byte_offset,
          row.byte_length,
          signal,
          (done) => this.progress(row.id, "hashing", done, row.byte_length),
        );
        db.prepare("UPDATE cloud_backups SET sha256=? WHERE id=?").run(digest, row.id);
        row = this.get(row.id)!;
      }
      if (signal.aborted) throw new ChunkproxyError("aborted");
      // 每一段開始時重新讀取，調整速度上限不必等到下一個檔案。
      const bytesPerSecond = () => this.config().rate_mbps * 125_000;
      this.note(row.id, row.parts_done ? `續傳中（從第 ${row.parts_done + 1} 段開始）` : "上傳中");
      let remote: RemoteFile;
      if (row.byte_length <= this.singleMax) {
        db.prepare("UPDATE cloud_backups SET attempts=attempts+1 WHERE id=?").run(row.id);
        this.event(row.id, "transfer", "上傳中（單次上傳，使用 1 次上傳點數）");
        remote = await client.uploadSmall(
          row.remote_name,
          { file: row.source_path, start: row.byte_offset, length: row.byte_length },
          {
            signal,
            bytesPerSecond: bytesPerSecond(),
            onProgress: (sent) => this.progress(row.id, "uploading", sent, row.byte_length),
          },
        );
      } else {
        let upload: RemoteUpload;
        if (row.upload_id && row.upload_secret && row.part_size && row.part_count)
          upload = {
            id: row.upload_id,
            upload_token: this.vault.open<string>(row.upload_secret, `cloud:upload:${row.id}`),
            part_size: row.part_size,
            part_count: row.part_count,
          };
        else {
          db.prepare("UPDATE cloud_backups SET attempts=attempts+1 WHERE id=?").run(row.id);
          upload = await client.createUpload(
            row.remote_name,
            row.byte_length,
            row.volumes === 1 && /\.mp4$/i.test(row.remote_name)
              ? "video/mp4"
              : "application/octet-stream",
            signal,
          );
          db.prepare(
            "UPDATE cloud_backups SET upload_id=?,upload_secret=?,part_size=?,part_count=?,parts_done=0,uploaded_bytes=0,part_sha256='' WHERE id=?",
          ).run(
            upload.id,
            this.vault.seal(upload.upload_token, `cloud:upload:${row.id}`),
            upload.part_size,
            upload.part_count,
            row.id,
          );
          this.event(
            row.id,
            "open",
            `已開啟分段上傳（${upload.part_count} 段，使用 1 次上傳點數）`,
          );
          row = this.get(row.id)!;
        }
        for (let n = row.parts_done; n < upload.part_count; n++) {
          const start = n * upload.part_size;
          const length = Math.min(upload.part_size, row.byte_length - start);
          let digest = "";
          for (let attempt = 1; ; attempt++) {
            try {
              digest = await client.putPart(
                upload,
                n,
                { file: row.source_path, start: row.byte_offset + start, length },
                {
                  signal,
                  bytesPerSecond: bytesPerSecond(),
                  onProgress: (sent) =>
                    this.progress(row.id, "uploading", start + sent, row.byte_length),
                },
              );
              break;
            } catch (error) {
              if (
                !(error instanceof ChunkproxyError && error.reason === "transient") ||
                attempt >= PART_ATTEMPTS ||
                signal.aborted
              )
                throw error;
              await delay(this.retryDelayMs * attempt * attempt, signal);
            }
          }
          // 各段雜湊依序接上；中間缺了（例如舊版開始的上傳）就整串作廢，完成時改從原檔補算。
          db.prepare(
            `UPDATE cloud_backups SET parts_done=?,uploaded_bytes=?,updated_at=?,
             part_sha256=CASE WHEN length(COALESCE(part_sha256,''))=? THEN COALESCE(part_sha256,'')||? ELSE NULL END WHERE id=?`,
          ).run(n + 1, start + length, this.clock(), n * 64, digest, row.id);
          if (n + 1 === upload.part_count || (n + 1) % 16 === 0)
            this.event(row.id, "transfer", `已上傳 ${n + 1} / ${upload.part_count} 段`);
        }
        this.progress(row.id, "finishing", row.byte_length, row.byte_length);
        remote = await client.complete(upload, signal);
      }
      if (remote.size !== null && remote.size !== row.byte_length)
        throw new BackupFailure(
          `儲存服務回報的大小（${remote.size}）與本機（${row.byte_length}）不符，請重試`,
        );
      if (remote.sha256 && !(await this.matchesRemote(row.id, remote.sha256, signal)))
        throw new BackupFailure("儲存服務回報的 SHA-256 與本機不符，請重試");
      // 分段上傳的組合校驗碼是由送出的內容算的：再確認原檔在上傳期間沒有被改過。
      const after = await fs.stat(row.source_path).catch(() => null);
      if (
        row.kind === "trip" &&
        (!after || after.size !== row.source_size || Math.abs(after.mtimeMs - row.source_mtime) > 1)
      )
        throw new BackupFailure("本機影片在備份途中被變更（例如裁剪），請重新加入備份");
      const now = this.clock();
      this.failures = 0;
      this.waiting = null;
      db.prepare(
        `UPDATE cloud_backups SET remote_id=?,remote_sha256=?,remote_state=?,verified=?,uploaded_bytes=byte_length,
         upload_id=NULL,upload_secret=NULL,retry_count=0,completed_at=? WHERE id=?`,
      ).run(remote.id, remote.sha256, remote.state, remote.sha256 ? 1 : 0, now, row.id);
      this.update(
        row.id,
        "done",
        remote.sha256
          ? `已備份並核對 SHA-256（雲端檔案 ${remote.id}）`
          : `已備份（雲端檔案 ${remote.id}；儲存服務未回報校驗碼）`,
      );
      if (row.kind === "database") {
        await fs.rm(row.source_path, { force: true }).catch(() => {});
        db.prepare("UPDATE cloud_backup_config SET last_db_at=? WHERE id=1").run(now);
      }
      this.log?.info({ backup: row.id, remote: remote.id }, "雲端備份完成一份");
    } catch (error) {
      const current = this.get(row.id);
      if (!current) return;
      if (signal.aborted || (error instanceof ChunkproxyError && error.reason === "aborted")) {
        const why = reason();
        if (why === "cancel") return; // cancel() 自己收尾
        this.update(
          row.id,
          "queued",
          why === "stop"
            ? "服務重啟，將從上次完成的分段續傳"
            : why === "pause"
              ? "已暫停，保留已完成的分段"
              : "傳輸被中斷，稍後續傳",
          this.clock() + (why ? 0 : 60_000),
        );
      } else if (error instanceof ChunkproxyError && error.reason === "credits") {
        this.pauseFor("credits", error.topupUrl);
        this.update(row.id, "queued", "上傳點數不足，備份已暫停；儲值後按「繼續備份」");
        this.log?.warn({ backup: row.id, status: error.status }, "雲端備份：上傳點數不足，已暫停");
      } else if (error instanceof ChunkproxyError && error.reason === "auth") {
        this.pauseFor("auth");
        this.update(row.id, "queued", "API 金鑰無效或已撤銷，備份已暫停；更新金鑰後會繼續");
        this.log?.warn({ backup: row.id, status: error.status }, "雲端備份：API 金鑰被拒，已暫停");
      } else if (
        error instanceof ChunkproxyError &&
        (error.reason === "transient" || (error.reason === "not_found" && current.upload_id))
      ) {
        if (error.reason === "not_found")
          db.prepare(
            "UPDATE cloud_backups SET upload_id=NULL,upload_secret=NULL,part_size=NULL,part_count=NULL,parts_done=0,uploaded_bytes=0,part_sha256=NULL WHERE id=?",
          ).run(row.id);
        const message =
          error.reason === "not_found" ? "雲端的分段上傳已過期，將重新上傳這一份" : error.message;
        const cooldown = () => {
          this.failures++;
          this.cooldownUntil =
            this.clock() +
            Math.max(
              error.retryAfterMs,
              Math.min(3_600_000, 30_000 * 2 ** Math.min(this.failures - 1, 7)),
            );
          this.waiting = { message, since: this.waiting?.since ?? this.clock() };
          return this.cooldownUntil;
        };
        this.log?.warn(
          { backup: row.id, reason: error.reason, status: error.status, outage: error.outage },
          `雲端備份暫時失敗：${message}`,
        );
        // 服務整個連不上（斷線、DNS、502/503/504、限流）：整個佇列一起等，不算這一份的失敗次數，
        // 否則服務中斷一天會把等待中的項目一個個耗成「失敗」。這一份的排序不往後挪，恢復後先重試它，
        // 不會在中斷期間輪流把其他影片整支讀過一遍算校驗碼。
        if (error.outage) {
          cooldown();
          this.update(row.id, "queued", message);
        } else {
          db.prepare("UPDATE cloud_backups SET retry_count=retry_count+1 WHERE id=?").run(row.id);
          const retries = this.get(row.id)!.retry_count;
          if (retries > MAX_TRANSIENT_RETRIES)
            this.update(row.id, "failed", `自動重試已達上限：${message}`);
          else if (error.reason === "not_found")
            this.update(row.id, "queued", message, this.clock());
          else this.update(row.id, "queued", message, cooldown());
        }
      } else {
        const message =
          error instanceof BackupFailure || error instanceof ChunkproxyError
            ? error.message
            : error instanceof Error && !/ENOENT|EACCES|EIO/.test(error.message)
              ? error.message
              : "無法讀取本機檔案，請檢查後重試";
        this.update(row.id, "failed", message);
        this.log?.warn(
          { backup: row.id, err: error instanceof Error ? error.message : String(error) },
          `雲端備份失敗：${message}`,
        );
      }
    } finally {
      if (lockedTrip) jobs.unregisterTrim(lockedTrip);
      if (lockedOwner !== null) jobs.unregisterOwnerProcess(lockedOwner);
    }
  }
}
