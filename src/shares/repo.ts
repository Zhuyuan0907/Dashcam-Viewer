/**
 * 單趟旅程的免登入分享連結。
 *
 * 分享 token 是 bearer credential：驗證只使用 SHA-256 雜湊，可取回副本以
 * AES-GCM 密文保存。匿名查詢永遠直接由 token 綁定到一趟旅程，不走公開清單。
 */
import crypto from "node:crypto";
import type { DB } from "../db.js";
import type { TripRow } from "../trips/repo.js";
import { openShareToken, sealShareToken } from "./token-vault.js";

export const DEFAULT_SHARE_DAYS = 7;
export const MAX_SHARE_DAYS = 365;
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface TripShareRow {
  id: number;
  token_hash: string;
  token_ciphertext: string | null;
  trip_id: string;
  created_by: number | null;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_access_at: number | null;
  access_count: number;
}

export interface CreatedTripShare {
  token: string;
  share: TripShareRow;
}

export type SharedTripRow = TripRow & {
  share_id: number;
  share_expires_at: number | null;
};

/** 32 隨機 bytes = 256 bits，base64url 不含需要 URL escape 的字元。 */
export function newShareToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashShareToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** 建立分享；碰到理論上的 token 雜湊衝突時最多重試三次。 */
export function createTripShare(
  db: DB,
  tripId: string,
  createdBy: number,
  expiresAt: number | null,
  now = Math.floor(Date.now() / 1000),
): CreatedTripShare {
  const insert = db.prepare(
    `INSERT INTO trip_shares (token_hash, trip_id, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertSecret = db.prepare(
    "INSERT INTO trip_share_secrets (share_id, ciphertext) VALUES (?, ?)",
  );
  const create = db.transaction((token: string, tokenHash: string): CreatedTripShare => {
    const result = insert.run(tokenHash, tripId, createdBy, now, expiresAt);
    const id = Number(result.lastInsertRowid);
    const tokenCiphertext = sealShareToken(token, id, tokenHash);
    insertSecret.run(id, tokenCiphertext);
    return {
      token,
      share: {
        id,
        token_hash: tokenHash,
        token_ciphertext: tokenCiphertext,
        trip_id: tripId,
        created_by: createdBy,
        created_at: now,
        expires_at: expiresAt,
        revoked_at: null,
        last_access_at: null,
        access_count: 0,
      },
    };
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = newShareToken();
    const tokenHash = hashShareToken(token);
    try {
      return create(token, tokenHash);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (!code.includes("SQLITE_CONSTRAINT_UNIQUE")) throw error;
    }
  }
  throw new Error("無法產生唯一的分享權杖");
}

/**
 * 原地更換有效分享的 bearer token。僅更新 token_hash，其餘紀錄欄位
 * （包含期限、已開啟次數與最後開啟時間）原樣保留。已撤銷或到期時回傳 null。
 */
export function rotateTripShare(
  db: DB,
  id: number,
  expectedTokenHash: string,
  now = Math.floor(Date.now() / 1000),
): CreatedTripShare | null {
  const update = db.prepare(
    `UPDATE trip_shares
        SET token_hash = ?
      WHERE id = ?
        AND token_hash = ?
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
      RETURNING id, token_hash, trip_id, created_by, created_at, expires_at, revoked_at,
                last_access_at, access_count`,
  );
  const upsertSecret = db.prepare(
    `INSERT INTO trip_share_secrets (share_id, ciphertext) VALUES (?, ?)
     ON CONFLICT(share_id) DO UPDATE SET ciphertext = excluded.ciphertext`,
  );
  const rotate = db.transaction((token: string, tokenHash: string): CreatedTripShare | null => {
    const share = update.get(tokenHash, id, expectedTokenHash, now) as
      | Omit<TripShareRow, "token_ciphertext">
      | undefined;
    if (!share) return null;
    const tokenCiphertext = sealShareToken(token, id, tokenHash);
    upsertSecret.run(id, tokenCiphertext);
    return { token, share: { ...share, token_ciphertext: tokenCiphertext } };
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = newShareToken();
    const tokenHash = hashShareToken(token);
    try {
      return rotate(token, tokenHash);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (!code.includes("SQLITE_CONSTRAINT_UNIQUE")) throw error;
    }
  }
  throw new Error("無法產生唯一的分享權杖");
}

export function listTripShares(db: DB, tripId: string, limit = 100): TripShareRow[] {
  return db
    .prepare(
      `SELECT s.id, s.token_hash, sec.ciphertext AS token_ciphertext,
              s.trip_id, s.created_by, s.created_at, s.expires_at, s.revoked_at,
              s.last_access_at, s.access_count
         FROM trip_shares s
         LEFT JOIN trip_share_secrets sec ON sec.share_id = s.id
        WHERE s.trip_id = ?
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT ?`,
    )
    .all(tripId, limit) as TripShareRow[];
}

export function getTripShare(db: DB, id: number): TripShareRow | null {
  const row = db
    .prepare(
      `SELECT s.id, s.token_hash, sec.ciphertext AS token_ciphertext,
              s.trip_id, s.created_by, s.created_at, s.expires_at, s.revoked_at,
              s.last_access_at, s.access_count
         FROM trip_shares s
         LEFT JOIN trip_share_secrets sec ON sec.share_id = s.id
        WHERE s.id = ?`,
    )
    .get(id) as TripShareRow | undefined;
  return row ?? null;
}

/** 只供已通過旅程管理權限的 reveal 端點使用；密文或 AAD 不符一律回 null。 */
export function recoverTripShareToken(row: TripShareRow): string | null {
  if (!row.token_ciphertext) return null;
  const token = openShareToken(row.token_ciphertext, row.id, row.token_hash);
  if (!token || !SHARE_TOKEN_RE.test(token)) return null;
  return hashShareToken(token) === row.token_hash ? token : null;
}

/** 冪等撤銷；已撤銷的列保留原時間。 */
export function revokeTripShare(db: DB, id: number, now = Math.floor(Date.now() / 1000)): boolean {
  const result = db
    .prepare("UPDATE trip_shares SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
    .run(now, id);
  return result.changes > 0;
}

/**
 * 以 bearer token 直接解析單一旅程。失效、撤銷、刪除或格式錯誤一律回 null，
 * 呼叫端應統一回 404，避免透露連結曾經存在。
 */
export function getSharedTrip(
  db: DB,
  token: string,
  now = Math.floor(Date.now() / 1000),
): SharedTripRow | null {
  if (!SHARE_TOKEN_RE.test(token)) return null;
  const row = db
    .prepare(
      `SELECT t.*, s.id AS share_id, s.expires_at AS share_expires_at
         FROM trip_shares s
         JOIN trips t ON t.trip_id = s.trip_id
        WHERE s.token_hash = ?
          AND s.revoked_at IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > ?)`,
    )
    .get(hashShareToken(token), now) as SharedTripRow | undefined;
  return row ?? null;
}

/** 只在匿名 metadata 載入時記一次，不讓影片的每個 Range 請求都寫 DB。 */
export function recordShareAccess(
  db: DB,
  id: number,
  now = Math.floor(Date.now() / 1000),
): void {
  db.prepare(
    `UPDATE trip_shares
        SET last_access_at = ?, access_count = access_count + 1
      WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
  ).run(now, id, now);
}
