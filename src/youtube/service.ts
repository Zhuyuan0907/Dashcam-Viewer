import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppContext } from "../context.js";
import { getTrip, deleteTrip, type TripRow } from "../trips/repo.js";
import { TRIPS_DIR } from "../config.js";
import { withinTrips } from "../util/paths.js";
import { YoutubeVault } from "./vault.js";
import { YoutubeAPI, YoutubeError, type OAuthConfig, type Tokens } from "./api.js";
import { DEFAULT_TITLE, DEFAULT_DESCRIPTION, metadata, variables } from "./templates.js";

export interface UploadRow {
  id: number;
  user_id: number;
  channel_id: string;
  trip_id: string;
  camera: "front" | "rear";
  date: string;
  trip_no: number;
  title: string;
  description: string;
  privacy: string;
  made_for_kids: number;
  source_path: string;
  source_size: number;
  source_mtime: number;
  source_version: string;
  status: string;
  uploaded_bytes: number;
  upload_secret: string | null;
  video_id: string | null;
  message: string;
  attempts: number;
  not_before: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  verified_at: number | null;
}
interface Account {
  user_id: number;
  channel_id: string;
  channel_title: string;
  secret: string;
  daily_limit: number;
  paused: number;
  blocked_until: number;
}
interface Cleanup {
  trip_id: string;
  user_id: number;
  original_dir: string;
  tombstone: string;
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS youtube_config(id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS youtube_accounts(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 channel_id TEXT NOT NULL, channel_title TEXT NOT NULL, secret TEXT NOT NULL, daily_limit INTEGER NOT NULL DEFAULT 10,
 paused INTEGER NOT NULL DEFAULT 0, blocked_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS youtube_states(state_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_hash TEXT NOT NULL, verifier_secret TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS youtube_uploads(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 channel_id TEXT NOT NULL, trip_id TEXT NOT NULL, camera TEXT NOT NULL, date TEXT NOT NULL, trip_no INTEGER NOT NULL,
 title TEXT NOT NULL, description TEXT NOT NULL, privacy TEXT NOT NULL, made_for_kids INTEGER NOT NULL DEFAULT 0,
 source_path TEXT NOT NULL, source_size INTEGER NOT NULL, source_mtime REAL NOT NULL, source_version TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued', uploaded_bytes INTEGER NOT NULL DEFAULT 0, upload_secret TEXT, video_id TEXT,
 message TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, not_before INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, verified_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS idx_youtube_unique ON youtube_uploads(user_id,channel_id,trip_id,camera,source_version) WHERE status != 'cancelled';
CREATE INDEX IF NOT EXISTS idx_youtube_due ON youtube_uploads(status,not_before);
CREATE TABLE IF NOT EXISTS youtube_events(id INTEGER PRIMARY KEY AUTOINCREMENT, upload_id INTEGER NOT NULL REFERENCES youtube_uploads(id) ON DELETE CASCADE,
 stage TEXT NOT NULL, message TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_youtube_events ON youtube_events(upload_id,id);
CREATE TABLE IF NOT EXISTS youtube_usage(id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_youtube_usage_time ON youtube_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_youtube_usage_channel ON youtube_usage(channel_id,created_at);
CREATE TABLE IF NOT EXISTS youtube_cleanup(trip_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, original_dir TEXT NOT NULL, tombstone TEXT NOT NULL);
`;
export function version(row: TripRow): string {
  return JSON.stringify([
    row.start_epoch,
    row.end_epoch,
    row.duration_sec,
    row.trim_offset_sec ?? 0,
    row.timeline_json ?? null,
  ]);
}
export function sourceVersion(row: TripRow, size: number, mtime: number): string {
  return JSON.stringify([version(row), size, mtime]);
}
const pacificFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function nextPacificMidnight(now: number): number {
  const today = pacificFormatter.format(now);
  let low = now,
    high = now + 26 * 3_600_000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (pacificFormatter.format(middle) === today) low = middle;
    else high = middle;
  }
  return high;
}
const channelBudgetKey = (channel: string) =>
  crypto.createHash("sha256").update(channel).digest("hex");
export class YoutubeService {
  readonly api: YoutubeAPI;
  readonly vault: YoutubeVault;
  private timer?: NodeJS.Timeout;
  private running: {
    id: number;
    user: number;
    controller: AbortController;
    promise: Promise<void>;
  } | null = null;
  private stopped = false;
  private ticking = false;
  constructor(
    private readonly ctx: AppContext,
    api = new YoutubeAPI(),
    vault = new YoutubeVault(),
    private readonly clock = Date.now,
  ) {
    this.api = api;
    this.vault = vault;
    ctx.db.exec(SCHEMA);
    const interrupted = ctx.db
      .prepare("SELECT id FROM youtube_uploads WHERE status='uploading'")
      .all() as { id: number }[];
    ctx.db
      .prepare(
        "UPDATE youtube_uploads SET status='queued',message='服務重啟，將查詢 YouTube 已收到的位置後續傳' WHERE status='uploading'",
      )
      .run();
    for (const row of interrupted) this.event(row.id, "resume", "服務重啟，保留續傳工作階段與進度");
  }
  config(): OAuthConfig | null {
    const row = this.ctx.db.prepare("SELECT secret FROM youtube_config WHERE id=1").get() as
      | { secret: string }
      | undefined;
    return row ? this.vault.open(row.secret, "youtube:config") : null;
  }
  setConfig(config: OAuthConfig): void {
    const existing = this.config();
    if (
      existing &&
      existing.client_id !== config.client_id &&
      this.ctx.db.prepare("SELECT 1 FROM youtube_accounts LIMIT 1").get()
    )
      throw new Error("請先解除所有 YouTube 連結，再更換 OAuth 專案");
    this.ctx.db
      .prepare(
        "INSERT INTO youtube_config(id,secret) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret",
      )
      .run(this.vault.seal(config, "youtube:config"));
  }
  account(user: number): Account | undefined {
    return this.ctx.db.prepare("SELECT * FROM youtube_accounts WHERE user_id=?").get(user) as
      | Account
      | undefined;
  }
  async connect(user: number, tokens: Tokens): Promise<void> {
    if (!tokens.refresh_token) throw new Error("Google 未提供離線授權，請重新同意授權");
    const channel = await this.api.channel(tokens.access_token);
    const old = this.account(user);
    if (
      old &&
      old.channel_id !== channel.id &&
      this.ctx.db
        .prepare(
          "SELECT 1 FROM youtube_uploads WHERE user_id=? AND status IN ('queued','uploading','processing') LIMIT 1",
        )
        .get(user)
    )
      throw new Error("有尚未完成的工作，請先取消或解除連結再切換頻道");
    this.ctx.db
      .prepare(
        `INSERT INTO youtube_accounts(user_id,channel_id,channel_title,secret) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET channel_id=excluded.channel_id,channel_title=excluded.channel_title,secret=excluded.secret,blocked_until=0`,
      )
      .run(user, channel.id, channel.title, this.vault.seal(tokens, `youtube:account:${user}`));
  }
  async token(user: number): Promise<string> {
    const account = this.account(user),
      config = this.config();
    if (!account || !config) throw new YoutubeError("unauthorized");
    let tokens = this.vault.open<Tokens>(account.secret, `youtube:account:${user}`);
    if (tokens.expires_at < this.clock() + 60_000) {
      tokens = await this.api.tokens(config, {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      });
      this.ctx.db
        .prepare("UPDATE youtube_accounts SET secret=? WHERE user_id=?")
        .run(this.vault.seal(tokens, `youtube:account:${user}`), user);
    }
    return tokens.access_token;
  }
  async disconnect(user: number): Promise<boolean> {
    this.pause(user, true);
    if (this.running?.user === user) await this.running.promise;
    const account = this.account(user);
    let revoked = true;
    if (account) {
      try {
        await this.api.revoke(
          this.vault.open<Tokens>(account.secret, `youtube:account:${user}`).refresh_token,
        );
      } catch {
        revoked = false;
      }
    }
    this.ctx.db.transaction(() => {
      this.ctx.db.prepare("DELETE FROM youtube_accounts WHERE user_id=?").run(user);
      this.ctx.db.prepare("DELETE FROM youtube_states WHERE user_id=?").run(user);
      this.ctx.db.prepare("DELETE FROM youtube_uploads WHERE user_id=?").run(user);
    })();
    return revoked;
  }
  pause(user: number, paused: boolean): void {
    this.ctx.db
      .prepare("UPDATE youtube_accounts SET paused=? WHERE user_id=?")
      .run(paused ? 1 : 0, user);
    if (paused && this.running?.user === user) this.running.controller.abort();
  }
  setDailyLimit(user: number, limit: number): void {
    this.ctx.db
      .prepare("UPDATE youtube_accounts SET daily_limit=? WHERE user_id=?")
      .run(limit, user);
  }
  get(id: number): UploadRow | undefined {
    return this.ctx.db.prepare("SELECT * FROM youtube_uploads WHERE id=?").get(id) as
      | UploadRow
      | undefined;
  }
  event(id: number, stage: string, message: string, bytes = 0): void {
    this.ctx.db
      .prepare(
        "INSERT INTO youtube_events(upload_id,stage,message,bytes,created_at) VALUES(?,?,?,?,?)",
      )
      .run(id, stage, message, bytes, this.clock());
  }
  update(id: number, status: string, message: string, notBefore?: number): void {
    this.ctx.db
      .prepare(
        "UPDATE youtube_uploads SET status=?,message=?,updated_at=?,not_before=COALESCE(?,not_before) WHERE id=?",
      )
      .run(status, message, this.clock(), notBefore ?? null, id);
    this.event(id, status, message, this.get(id)?.uploaded_bytes ?? 0);
  }
  async source(row: TripRow, camera: "front" | "rear") {
    const file = row[`${camera}_path`];
    if (!file || !withinTrips(file)) throw new Error("此鏡頭沒有本機影片");
    const real = await fs.realpath(file);
    if (!withinTrips(real)) throw new Error("影片路徑不在資料區");
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 256 * 1024 ** 3)
      throw new Error("影片大小不符合 YouTube 上傳規格");
    return { file, size: stat.size, mtime: stat.mtimeMs };
  }
  async enqueue(
    user: number,
    ids: string[],
    options: {
      camera: string;
      title_template: string;
      description_template: string;
      privacy: string;
      made_for_kids: boolean;
      not_before: number;
    },
  ) {
    const account = this.account(user);
    if (!account || !this.config()) throw new Error("請先連結 YouTube 帳號");
    const prepared: Array<{
      row: TripRow;
      camera: "front" | "rear";
      file: string;
      size: number;
      mtime: number;
      title: string;
      description: string;
    }> = [];
    for (const id of [...new Set(ids)]) {
      const row = getTrip(this.ctx.db, id);
      if (!row || row.owner_id !== user) throw new Error("只能上傳自己的旅程");
      if (this.ctx.jobs.busy(id)) throw new Error("旅程正在處理，請等待完成再加入");
      for (const camera of ["front", "rear"] as const) {
        if (options.camera !== "both" && camera !== options.camera) continue;
        if (!row[`has_${camera}`]) continue;
        const source = await this.source(row, camera);
        prepared.push({
          row,
          camera,
          ...source,
          ...metadata(
            options.title_template,
            options.description_template,
            variables(row, camera, path.basename(source.file)),
          ),
        });
      }
    }
    if (!prepared.length) throw new Error("選擇的旅程沒有可上傳的鏡頭");
    const insert = this.ctx.db
      .prepare(`INSERT OR IGNORE INTO youtube_uploads(user_id,channel_id,trip_id,camera,date,trip_no,title,description,privacy,made_for_kids,
      source_path,source_size,source_mtime,source_version,not_before,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let added = 0;
    this.ctx.db.transaction(() => {
      // Recheck after asynchronous file inspection, before accepting the batch.
      for (const p of prepared) {
        const current = getTrip(this.ctx.db, p.row.trip_id);
        if (
          !current ||
          current.owner_id !== user ||
          version(current) !== version(p.row) ||
          this.ctx.jobs.busy(p.row.trip_id)
        )
          throw new Error("旅程已變更，請重新選擇");
        const result = insert.run(
          user,
          account.channel_id,
          p.row.trip_id,
          p.camera,
          p.row.date,
          p.row.day_order,
          p.title,
          p.description,
          options.privacy,
          options.made_for_kids ? 1 : 0,
          p.file,
          p.size,
          p.mtime,
          sourceVersion(p.row, p.size, p.mtime),
          options.not_before,
          this.clock(),
          this.clock(),
        );
        if (result.changes) {
          added++;
          this.event(Number(result.lastInsertRowid), "queued", "已加入上傳佇列；前後鏡頭各計一部");
        }
      }
    })();
    return { added, skipped: prepared.length - added };
  }
  retry(id: number, restart: boolean): void {
    const row = this.get(id);
    if (!row || !["failed", "cancelled"].includes(row.status))
      throw new Error("此工作目前無法重試");
    if (row.video_id && !restart) {
      this.update(id, "processing", "重新確認已上傳影片的處理狀態", this.clock());
      return;
    }
    if (row.video_id && restart) {
      this.ctx.db
        .prepare("UPDATE youtube_uploads SET video_id=NULL,verified_at=NULL WHERE id=?")
        .run(id);
    }
    if (row.upload_secret && !restart) {
      this.update(id, "queued", "將先查詢續傳狀態", this.clock());
      return;
    }
    if (row.upload_secret && restart)
      this.ctx.db
        .prepare("UPDATE youtube_uploads SET upload_secret=NULL,uploaded_bytes=0 WHERE id=?")
        .run(id);
    // Do not create a second row; preserve history and avoid unique-index conflicts with a replacement.
    const duplicate = this.ctx.db
      .prepare(
        "SELECT id FROM youtube_uploads WHERE user_id=? AND channel_id=? AND trip_id=? AND camera=? AND source_version=? AND status!='cancelled' AND id!=?",
      )
      .get(row.user_id, row.channel_id, row.trip_id, row.camera, row.source_version, id);
    if (duplicate) throw new Error("相同影片已有其他上傳工作");
    this.update(id, "queued", "使用者要求重新嘗試", this.clock());
  }
  async cancel(id: number): Promise<void> {
    const row = this.get(id);
    if (!row || !["queued", "uploading", "failed"].includes(row.status))
      throw new Error("此工作目前無法取消");
    if (this.running?.id === id) {
      this.running.controller.abort();
      await this.running.promise;
    }
    const current = this.get(id);
    if (current?.video_id) throw new Error("影片已完成傳輸，取消不會刪除 YouTube 影片");
    this.update(id, "cancelled", "使用者取消；已建立的 YouTube 工作階段仍可能保留");
  }
  /** Count initiation attempts, including failed API calls. Channel budget is a rolling 24 hours. */
  allowance(
    account: Account,
    projectLimit: number,
  ): { until: number; used: number; project_used: number } {
    const now = this.clock();
    const own = this.ctx.db
      .prepare(
        "SELECT created_at FROM youtube_usage WHERE channel_id=? AND created_at>? ORDER BY created_at",
      )
      .all(channelBudgetKey(account.channel_id), now - 86_400_000) as { created_at: number }[];
    const day = pacificFormatter.format(now);
    const project = (
      this.ctx.db
        .prepare("SELECT created_at FROM youtube_usage WHERE created_at>?")
        .all(now - 90_000_000) as { created_at: number }[]
    ).filter((r) => pacificFormatter.format(r.created_at) === day);
    let until = Math.max(now, account.blocked_until);
    if (own.length >= account.daily_limit)
      until = Math.max(until, own[own.length - account.daily_limit]!.created_at + 86_400_001);
    // Conservative wait for a project quota boundary; YouTube remains the authority on actual quota.
    if (project.length >= projectLimit) until = Math.max(until, nextPacificMidnight(now));
    return { until, used: own.length, project_used: project.length };
  }
  async start(): Promise<void> {
    await this.recoverCleanup();
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 5000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.running?.controller.abort();
    if (this.running) await this.running.promise;
  }
  async tick(): Promise<void> {
    if (this.stopped || this.running || this.ticking) return;
    this.ticking = true;
    try {
      const config = this.config();
      if (!config) return;
      const row = this.ctx.db
        .prepare(
          `SELECT u.* FROM youtube_uploads u JOIN youtube_accounts a ON a.user_id=u.user_id AND a.channel_id=u.channel_id
        WHERE u.status IN ('queued','processing') AND u.not_before<=? AND a.paused=0 AND a.blocked_until<=? ORDER BY u.not_before,u.id LIMIT 1`,
        )
        .get(this.clock(), this.clock()) as UploadRow | undefined;
      if (!row) return;
      const account = this.account(row.user_id)!;
      if (row.status === "queued" && !row.upload_secret) {
        const budget = this.allowance(account, config.project_daily_limit);
        if (budget.until > this.clock()) {
          this.update(row.id, "queued", "等待每日額度恢復，會自動繼續", budget.until);
          return;
        }
      }
      const controller = new AbortController();
      const promise = this.run(row, controller).finally(() => {
        this.running = null;
      });
      this.running = { id: row.id, user: row.user_id, controller, promise };
      await promise;
    } finally {
      this.ticking = false;
    }
  }
  private async run(row: UploadRow, controller: AbortController): Promise<void> {
    const { db, jobs } = this.ctx;
    let locked = false;
    try {
      if (row.status === "processing") {
        await this.verify(row);
        return;
      }
      if (jobs.busy(row.trip_id)) {
        this.update(row.id, "queued", "等待此旅程的其他工作完成", this.clock() + 30_000);
        return;
      }
      jobs.registerTrim(row.trip_id, controller);
      jobs.registerOwnerProcess(row.user_id);
      locked = true;
      this.update(row.id, "uploading", "檢查本機影片與 Google 授權");
      const current = getTrip(db, row.trip_id);
      if (!current || current.owner_id !== row.user_id)
        throw new Error("本機旅程已刪除或編輯，請重新選擇影片");
      const source = await this.source(current, row.camera);
      if (
        source.file !== row.source_path ||
        source.size !== row.source_size ||
        source.mtime !== row.source_mtime ||
        sourceVersion(current, source.size, source.mtime) !== row.source_version
      )
        throw new Error("本機影片版本已變更，請重新選擇影片");
      let token = await this.token(row.user_id);
      if (controller.signal.aborted) throw new Error("interrupted");
      let uploadURL: string;
      if (row.upload_secret)
        uploadURL = this.vault.open<string>(row.upload_secret, `youtube:upload:${row.id}`);
      else {
        db.prepare("INSERT INTO youtube_usage(channel_id,created_at) VALUES(?,?)").run(
          channelBudgetKey(row.channel_id),
          this.clock(),
        );
        db.prepare("UPDATE youtube_uploads SET attempts=attempts+1 WHERE id=?").run(row.id);
        this.event(row.id, "authorize", "已取得 Google 授權，建立 YouTube 續傳工作階段");
        uploadURL = await this.api.initiate(
          token,
          {
            title: row.title,
            description: row.description,
            privacy: row.privacy,
            made_for_kids: !!row.made_for_kids,
          },
          row.source_size,
          controller.signal,
        );
        db.prepare("UPDATE youtube_uploads SET upload_secret=? WHERE id=?").run(
          this.vault.seal(uploadURL, `youtube:upload:${row.id}`),
          row.id,
        );
      }
      this.event(row.id, "resume", "查詢 YouTube 已確認接收的位元組，避免重複上傳");
      let progress = await this.api.put(
        uploadURL,
        token,
        row.source_size,
        null,
        null,
        controller.signal,
      );
      const file = await fs.open(row.source_path, "r");
      try {
        const chunk = Buffer.alloc(8 * 1024 * 1024);
        while (!progress.id) {
          if (controller.signal.aborted) throw new Error("interrupted");
          token = await this.token(row.user_id);
          const count = Math.min(chunk.length, row.source_size - progress.offset);
          if (count <= 0) throw new YoutubeError("transient");
          const read = await file.read(chunk, 0, count, progress.offset);
          if (read.bytesRead !== count) throw new Error("來源影片長度已變更，停止上傳");
          const previous = progress.offset;
          progress = await this.api.put(
            uploadURL,
            token,
            row.source_size,
            previous,
            chunk.subarray(0, count),
            controller.signal,
          );
          if (!progress.id && progress.offset <= previous) throw new YoutubeError("transient");
          db.prepare("UPDATE youtube_uploads SET uploaded_bytes=?,updated_at=? WHERE id=?").run(
            progress.offset,
            this.clock(),
            row.id,
          );
          this.event(
            row.id,
            "transfer",
            `YouTube 已接收 ${progress.offset} / ${row.source_size} bytes`,
            progress.offset,
          );
        }
      } finally {
        await file.close();
      }
      db.prepare(
        "UPDATE youtube_uploads SET video_id=?,uploaded_bytes=source_size,upload_secret=NULL WHERE id=?",
      ).run(progress.id, row.id);
      this.update(
        row.id,
        "processing",
        "檔案傳輸完成，等待 YouTube 處理與確認畫質",
        this.clock() + 30_000,
      );
    } catch (error) {
      if (controller.signal.aborted)
        this.update(
          row.id,
          "queued",
          "已暫停傳輸，保留進度；下次先確認 YouTube 的接收位置",
          this.clock() + 5000,
        );
      else if (
        error instanceof YoutubeError &&
        ["uploadLimitExceeded", "quotaExceeded", "dailyLimitExceeded"].includes(error.reason)
      ) {
        const until =
          error.reason === "uploadLimitExceeded"
            ? this.clock() + 86_400_000
            : nextPacificMidnight(this.clock());
        if (error.reason === "uploadLimitExceeded")
          db.prepare("UPDATE youtube_accounts SET blocked_until=? WHERE channel_id=?").run(
            until,
            row.channel_id,
          );
        else db.prepare("UPDATE youtube_uploads SET not_before=? WHERE status='queued'").run(until);
        this.update(row.id, row.video_id ? "processing" : "queued", error.message, until);
      } else if (error instanceof YoutubeError && error.reason === "transient") {
        db.prepare("UPDATE youtube_uploads SET attempts=attempts+1 WHERE id=?").run(row.id);
        const attempts = this.get(row.id)!.attempts;
        this.update(
          row.id,
          row.status === "processing" ? "processing" : "queued",
          error.message,
          this.clock() + Math.min(3_600_000, 30_000 * 2 ** Math.min(attempts, 7)),
        );
      } else {
        if (
          error instanceof YoutubeError &&
          ["invalid_grant", "unauthorized"].includes(error.reason)
        )
          this.pause(row.user_id, true);
        this.update(
          row.id,
          "failed",
          error instanceof YoutubeError
            ? error.message
            : error instanceof Error && !/https?:|ENOENT|EACCES/.test(error.message)
              ? error.message
              : "無法讀取影片或授權資料，請檢查後重試",
        );
      }
    } finally {
      if (locked) {
        jobs.unregisterTrim(row.trip_id);
        jobs.unregisterOwnerProcess(row.user_id);
      }
    }
  }
  async verify(row: UploadRow): Promise<boolean> {
    if (!row.video_id || this.account(row.user_id)?.channel_id !== row.channel_id)
      throw new Error("請連結此影片所屬的 YouTube 頻道");
    const video = await this.api.video(await this.token(row.user_id), row.video_id);
    if (!video || video.snippet?.channelId !== row.channel_id) {
      this.update(row.id, "failed", "YouTube 影片不存在或不屬於目前頻道");
      return false;
    }
    const status = video.processingDetails?.processingStatus;
    if (
      ["failed", "terminated"].includes(status) ||
      ["failed", "rejected", "deleted"].includes(video.status?.uploadStatus)
    ) {
      this.update(row.id, "failed", "YouTube 處理失敗或影片遭拒，請保留本機影片");
      return false;
    }
    if (status === "succeeded" && video.status?.uploadStatus === "processed") {
      this.ctx.db
        .prepare("UPDATE youtube_uploads SET verified_at=? WHERE id=?")
        .run(this.clock(), row.id);
      this.update(
        row.id,
        "succeeded",
        `YouTube 已完成處理（可見性：${video.status.privacyStatus}），可查看或選擇清理本機檔案`,
      );
      return true;
    }
    this.update(row.id, "processing", "YouTube 仍在處理，稍後自動確認", this.clock() + 300_000);
    return false;
  }
  async cleanup(user: number, tripId: string): Promise<void> {
    const { db, jobs } = this.ctx;
    const row = getTrip(db, tripId);
    if (!row || row.owner_id !== user) throw new Error("找不到自己的本機旅程");
    if (jobs.busy(tripId)) throw new Error("旅程還有背景作業，請等待完成");
    jobs.registerTrim(tripId, new AbortController());
    jobs.registerOwnerProcess(user);
    try {
      if (
        !row.trip_dir ||
        !withinTrips(row.trip_dir) ||
        path.resolve(row.trip_dir) === path.resolve(TRIPS_DIR)
      )
        throw new Error("旅程目錄不正確");
      if (
        row.orig_duration_sec !== null ||
        db.prepare("SELECT 1 FROM trip_clips WHERE trip_id=? LIMIT 1").get(tripId)
      )
        throw new Error("此旅程有裁剪原始備份或匯出片段，請先另行備份並在旅程頁管理");
      const realDir = await fs.realpath(row.trip_dir);
      if (!withinTrips(realDir) || realDir !== path.resolve(row.trip_dir))
        throw new Error("旅程目錄含符號連結，無法安全清理");
      if (
        db
          .prepare("SELECT 1 FROM trips WHERE trip_dir=? AND trip_id!=? LIMIT 1")
          .get(row.trip_dir, tripId)
      )
        throw new Error("其他旅程共用此目錄，無法安全清理");
      const allowedFiles = new Set<string>();
      for (const camera of ["front", "rear"] as const) {
        if (!row[`has_${camera}`]) continue;
        const source = await this.source(row, camera);
        if (path.dirname(source.file) !== realDir)
          throw new Error("鏡頭影片不在旅程目錄，無法安全清理");
        allowedFiles.add(source.file);
        const uploaded = db
          .prepare(
            "SELECT * FROM youtube_uploads WHERE user_id=? AND trip_id=? AND camera=? AND source_version=? AND source_size=? AND source_mtime=? AND status='succeeded' AND video_id IS NOT NULL ORDER BY id DESC LIMIT 1",
          )
          .get(
            user,
            tripId,
            camera,
            sourceVersion(row, source.size, source.mtime),
            source.size,
            source.mtime,
          ) as UploadRow | undefined;
        if (!uploaded || !(await this.verify(uploaded)))
          throw new Error("每個現有鏡頭都必須完成上傳且通過 YouTube 確認，才能清理整趟");
      }
      if (!allowedFiles.size) throw new Error("沒有可清理的本機影片");
      const entries = await fs.readdir(realDir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.isDirectory() ||
          entry.isSymbolicLink() ||
          (/\.(mp4|mov|ts|mkv|avi|webm)$/i.test(entry.name) &&
            !allowedFiles.has(path.join(realDir, entry.name)))
        )
          throw new Error("旅程目錄包含其他素材，請先另行備份並在旅程頁管理");
      }
      const tombstone = `${row.trip_dir}.youtube-cleanup-${crypto.randomBytes(8).toString("hex")}`;
      db.prepare(
        "INSERT INTO youtube_cleanup(trip_id,user_id,original_dir,tombstone) VALUES(?,?,?,?)",
      ).run(tripId, user, row.trip_dir, tombstone);
      await fs.rename(row.trip_dir, tombstone);
      await this.finishCleanup({
        trip_id: tripId,
        user_id: user,
        original_dir: row.trip_dir,
        tombstone,
      });
    } finally {
      jobs.unregisterTrim(tripId);
      jobs.unregisterOwnerProcess(user);
    }
  }
  private async finishCleanup(row: Cleanup): Promise<void> {
    await fs.rm(row.tombstone, { recursive: true, force: true });
    await deleteTrip(this.ctx.db, row.trip_id);
    const uploads = this.ctx.db
      .prepare("SELECT id FROM youtube_uploads WHERE user_id=? AND trip_id=?")
      .all(row.user_id, row.trip_id) as { id: number }[];
    this.ctx.db
      .prepare("UPDATE youtube_uploads SET deleted_at=? WHERE user_id=? AND trip_id=?")
      .run(this.clock(), row.user_id, row.trip_id);
    for (const upload of uploads)
      this.event(upload.id, "cleanup", "使用者確認後清理本機旅程，保留 YouTube 影片與配對紀錄");
    this.ctx.db.prepare("DELETE FROM youtube_cleanup WHERE trip_id=?").run(row.trip_id);
  }
  private async recoverCleanup(): Promise<void> {
    for (const row of this.ctx.db.prepare("SELECT * FROM youtube_cleanup").all() as Cleanup[]) {
      if (
        !withinTrips(row.original_dir) ||
        !withinTrips(row.tombstone) ||
        !row.tombstone.startsWith(`${row.original_dir}.youtube-cleanup-`)
      )
        throw new Error("YouTube 清理紀錄路徑不正確");
      const oldExists = await fs.stat(row.original_dir).then(
        () => true,
        () => false,
      );
      if (oldExists)
        this.ctx.db.prepare("DELETE FROM youtube_cleanup WHERE trip_id=?").run(row.trip_id);
      else await this.finishCleanup(row);
    }
  }
  defaults() {
    return { title_template: DEFAULT_TITLE, description_template: DEFAULT_DESCRIPTION };
  }
}
