/**
 * SFTP 上傳工作階段管理 —— DB 持久 + 記憶體 live 狀態。
 *
 * 取代舊 HTTP 版的 UploadManager。每個 session:
 *   - 一個短 id(= 資料夾名 = sftp username 後綴)與一次性密碼。
 *   - 資料夾 UPLOAD_DIR/<id>;SFTP 連線被沙箱在此夾內。
 *   - 記憶體追蹤進行中連線數(conns)與活動時間;只有 conns===0 且閒置超門檻、
 *     且非 processing 時才會被回收(刪資料夾 + 列)。
 * 啟動時由 DB rehydrate,讓重啟後既有資料夾仍會正確過期。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { DB } from "../db.js";
import { UPLOAD_DIR, PREBUILT_DIR } from "../config.js";

export type SessionStatus = "active" | "processing" | "done";

export interface SftpSession {
  id: string;
  userId: number;
  username: string;
  password: string;
  status: SessionStatus;
  createdAt: number;
  lastActivity: number;
  fileCount: number;
  totalBytes: number;
  /** 此工作階段的有效 idle 逾時(秒);0=不限,永不自動回收。 */
  idleSec: number;
  /** 進行中的 SFTP 連線數(僅記憶體,不入庫)。 */
  conns: number;
  /** 近一秒的即時上傳速率(bytes/秒;僅記憶體)。讀取端應在閒置時視為 0。 */
  speedBps: number;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

interface Row {
  id: string;
  user_id: number;
  username: string;
  password: string;
  status: SessionStatus;
  created_at: number;
  last_activity: number;
  file_count: number;
  total_bytes: number;
  idle_sec: number;
}

export class SftpSessionManager {
  private readonly db: DB;
  private readonly mem = new Map<string, SftpSession>();
  /** 每個 session 的速率取樣視窗(記憶體;毫秒級)。 */
  private readonly speedWin = new Map<string, { winBytes: number; winStartMs: number }>();

  constructor(db: DB) {
    this.db = db;
    this.rehydrate();
  }

  /** 啟動時把 DB 內既有 session 載回記憶體(conns 歸零)。 */
  private rehydrate(): void {
    const rows = this.db.prepare("SELECT * FROM sftp_sessions").all() as Row[];
    for (const r of rows) {
      this.mem.set(r.id, {
        id: r.id,
        userId: r.user_id,
        username: r.username,
        password: r.password,
        status: r.status,
        createdAt: r.created_at,
        lastActivity: r.last_activity,
        fileCount: r.file_count,
        totalBytes: r.total_bytes,
        idleSec: r.idle_sec,
        conns: 0,
        speedBps: 0,
      });
    }
  }

  rootDir(id: string): string {
    return path.join(UPLOAD_DIR, id);
  }

  sftpUsername(s: SftpSession): string {
    return `${s.username}.${s.id}`;
  }

  /**
   * 建立新 session:產生 id + 一次性密碼,寫 DB、建資料夾。
   * @param idleSec 此工作階段的有效 idle 逾時(秒);0=不限(永不自動回收)。由呼叫端依使用者算好。
   */
  create(user: { id: number; username: string }, idleSec: number): SftpSession {
    let id = "";
    do {
      id = crypto.randomBytes(4).toString("hex"); // 8 hex
    } while (this.mem.has(id));
    const password = crypto.randomBytes(16).toString("base64url");
    const t = now();

    fs.mkdirSync(this.rootDir(id), { recursive: true });
    this.db
      .prepare(
        `INSERT INTO sftp_sessions
           (id, user_id, username, password, status, created_at, last_activity, file_count, total_bytes, idle_sec)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, user.id, user.username, password, "active", t, t, 0, 0, idleSec);

    const s: SftpSession = {
      id,
      userId: user.id,
      username: user.username,
      password,
      status: "active",
      createdAt: t,
      lastActivity: t,
      fileCount: 0,
      totalBytes: 0,
      idleSec,
      conns: 0,
      speedBps: 0,
    };
    this.mem.set(id, s);
    return s;
  }

  get(id: string): SftpSession | undefined {
    return this.mem.get(id);
  }

  listForUser(userId: number): SftpSession[] {
    return [...this.mem.values()]
      .filter((s) => s.userId === userId && s.status !== "done")
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  listAll(): SftpSession[] {
    return [...this.mem.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  connOpened(id: string): void {
    const s = this.mem.get(id);
    if (!s) return;
    s.conns++;
    s.lastActivity = now();
  }

  connClosed(id: string): void {
    const s = this.mem.get(id);
    if (!s) return;
    s.conns = Math.max(0, s.conns - 1);
    s.lastActivity = now();
    this.sync(s);
  }

  /** 上傳活動:累加 bytes / 檔數並 bump 活動時間(不每次都寫 DB),同時更新即時速率。 */
  touch(id: string, delta: { bytes?: number; files?: number }): void {
    const s = this.mem.get(id);
    if (!s) return;
    const bytes = delta.bytes ?? 0;
    s.totalBytes += bytes;
    s.fileCount += delta.files ?? 0;
    s.lastActivity = now();
    // 速率:以 ~1 秒滑動視窗平均。累加此視窗 bytes,滿 1 秒即算出 bytes/秒並重置。
    if (bytes > 0) {
      const nowMs = Date.now();
      const win = this.speedWin.get(id) ?? { winBytes: 0, winStartMs: nowMs };
      win.winBytes += bytes;
      const dt = nowMs - win.winStartMs;
      if (dt >= 1000) {
        s.speedBps = win.winBytes / (dt / 1000);
        win.winBytes = 0;
        win.winStartMs = nowMs;
      }
      this.speedWin.set(id, win);
    }
  }

  /** 讀取即時速率:超過 3 秒無活動視為停止(0)。 */
  currentSpeed(s: SftpSession): number {
    if (now() - s.lastActivity > 3) return 0;
    return Math.round(s.speedBps);
  }

  setStatus(id: string, status: SessionStatus): void {
    const s = this.mem.get(id);
    if (!s) return;
    s.status = status;
    s.lastActivity = now();
    this.sync(s);
  }

  /** 把記憶體 live 狀態寫回 DB。 */
  private sync(s: SftpSession): void {
    this.db
      .prepare(
        "UPDATE sftp_sessions SET status=?, last_activity=?, file_count=?, total_bytes=? WHERE id=?",
      )
      .run(s.status, s.lastActivity, s.fileCount, s.totalBytes, s.id);
  }

  /**
   * 找出可回收的 session id(conns===0 且閒置超門檻)。逐 session 用自身 idleSec。
   *   - idleSec===0(不限,如 admin 預設):active 永不回收;但 processing/done 殘留仍給寬限後清。
   *   - active:超過 idleSec 即回收。
   *   - processing/done(可能是中斷/崩潰殘留):給較長寬限(≥1 小時)再回收,避免誤砍進行中的合併。
   */
  findExpired(): string[] {
    const t = now();
    const out: string[] = [];
    for (const s of this.mem.values()) {
      if (s.conns > 0) continue;
      const idle = t - s.lastActivity;
      if (s.status === "active") {
        if (s.idleSec > 0 && idle > s.idleSec) out.push(s.id);
      } else {
        // 殘留清理:不限時的也要清,基準用其 idleSec(0 時退回 1 小時)。
        const base = s.idleSec > 0 ? s.idleSec : 3600;
        if (idle > Math.max(base * 4, 3600)) out.push(s.id);
      }
    }
    return out;
  }

  /**
   * 啟動時清理孤兒資料夾:UPLOAD_DIR/* 與 PREBUILT_DIR/* 中無對應 live session 的夾。
   * (重啟時沒有任何處理進行中,安全。)回傳清掉的夾數。
   */
  async purgeOrphanDirs(): Promise<number> {
    const live = new Set(this.mem.keys());
    const reserved = new Set(["F", "R", "NMEA", "prebuilt"]); // UPLOAD_DIR 下的固定分流夾
    let removed = 0;
    for (const base of [UPLOAD_DIR, PREBUILT_DIR]) {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (base === UPLOAD_DIR && reserved.has(e.name)) continue;
        if (live.has(e.name)) continue;
        await fsp.rm(path.join(base, e.name), { recursive: true, force: true }).catch(() => {});
        removed++;
      }
    }
    return removed;
  }

  /** 移除 session:刪資料夾(含 prebuilt 暫存)與 DB 列。 */
  async remove(id: string): Promise<void> {
    this.mem.delete(id);
    this.speedWin.delete(id);
    this.db.prepare("DELETE FROM sftp_sessions WHERE id = ?").run(id);
    await fsp.rm(this.rootDir(id), { recursive: true, force: true }).catch(() => {});
    await fsp.rm(path.join(PREBUILT_DIR, id), { recursive: true, force: true }).catch(() => {});
  }
}
