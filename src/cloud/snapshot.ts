/**
 * 送到站外的資料庫快照：先 VACUUM INTO 取得一致的副本，再移除登入憑證與各種上傳密碼，
 * 最後重新 VACUUM，讓刪掉的內容不會殘留在空白頁裡。
 * 旅程、備註、片段、裝置、帳號（加鹽雜湊）與雲端備份紀錄都保留，還原時才對得回影片。
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { DB } from "../db.js";

/** 表 → 要清掉的動作；表不存在（舊資料庫或功能未啟用）就略過。 */
const SCRUB: Array<[table: string, sql: string]> = [
  ["sessions", "DELETE FROM sessions"],
  ["sftp_sessions", "UPDATE sftp_sessions SET password = ''"],
  ["trip_share_secrets", "DELETE FROM trip_share_secrets"],
  ["youtube_config", "DELETE FROM youtube_config"],
  ["youtube_states", "DELETE FROM youtube_states"],
  ["youtube_accounts", "UPDATE youtube_accounts SET secret = ''"],
  ["youtube_uploads", "UPDATE youtube_uploads SET upload_secret = NULL"],
  ["cloud_backup_config", "UPDATE cloud_backup_config SET secret = NULL"],
  ["cloud_backups", "UPDATE cloud_backups SET upload_secret = NULL"],
];

export function sanitizedSnapshot(db: DB, dest: string): number {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const raw = `${dest}.raw`;
  fs.rmSync(raw, { force: true });
  fs.rmSync(dest, { force: true });
  db.exec(`VACUUM INTO '${raw.replace(/'/g, "''")}'`);
  try {
    const copy = new Database(raw);
    try {
      copy.pragma("journal_mode = DELETE");
      const tables = new Set(
        (
          copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
            name: string;
          }[]
        ).map((t) => t.name),
      );
      copy.transaction(() => {
        for (const [table, sql] of SCRUB) if (tables.has(table)) copy.exec(sql);
      })();
      copy.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    } finally {
      copy.close();
    }
  } finally {
    for (const leftover of [raw, `${raw}-wal`, `${raw}-shm`, `${raw}-journal`])
      fs.rmSync(leftover, { force: true });
  }
  return fs.statSync(dest).size;
}
