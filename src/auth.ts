/**
 * 認證:密碼雜湊(與舊 Python pbkdf2 相容)+ session 查詢。
 */
import crypto from "node:crypto";
import {
  PBKDF2_ITER,
  PBKDF2_KEYLEN,
  PBKDF2_DIGEST,
  PBKDF2_SALT_BYTES,
} from "./config.js";
import type { DB } from "./db.js";

export interface SessionUser {
  id: number;
  username: string;
  role: string;
  email: string;
  /** 總管理員(擁有者)旗標,0/1。 */
  is_owner: number;
  /** 顯示名稱(選填);未設定為 null。 */
  display_name: string | null;
}

/**
 * 產生密碼雜湊,格式 `"{salt_hex}:{key_hex}"`。
 * 與 Python `hashlib.pbkdf2_hmac("sha256", pw, salt, 310000)` 位元相容。
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(PBKDF2_SALT_BYTES);
  const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITER, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

/** 驗證密碼;使用 timing-safe 比較。 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const idx = stored.indexOf(":");
    if (idx < 0) return false;
    const saltHex = stored.slice(0, idx);
    const keyHex = stored.slice(idx + 1);
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(keyHex, "hex");
    if (expected.length === 0) return false;
    const actual = crypto.pbkdf2Sync(password, salt, PBKDF2_ITER, expected.length, PBKDF2_DIGEST);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 產生一個新的 session token。 */
export function newSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** 依 token 查詢有效的使用者;過期或不存在回 null。 */
export function lookupSession(db: DB, token: string | undefined | null): SessionUser | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.role, u.email, u.is_owner, u.display_name
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(token, Math.floor(Date.now() / 1000)) as SessionUser | undefined;
  return row ?? null;
}
