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
  /** 首次登入須改密碼旗標,0/1(供伺服器端強制)。 */
  must_change_password: number;
}

/**
 * 產生密碼雜湊,格式 `"{salt_hex}:{key_hex}"`。
 * 與 Python `hashlib.pbkdf2_hmac("sha256", pw, salt, 310000)` 位元相容。
 * 註:同步版仍保留(相容性向量測試與非 async 情境用);HTTP handler 應優先用
 * `hashPasswordAsync` 把 310k 次 PBKDF2 卸載到 libuv 執行緒池,避免阻塞 event loop。
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(PBKDF2_SALT_BYTES);
  const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITER, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

/** 驗證密碼(同步);使用 timing-safe 比較。 */
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

/** pbkdf2 的 Promise 包裝(卸載到執行緒池,不阻塞 event loop)。 */
function pbkdf2Async(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, PBKDF2_ITER, keylen, PBKDF2_DIGEST, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** 產生密碼雜湊(非阻塞)。格式同 hashPassword。 */
export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(PBKDF2_SALT_BYTES);
  const key = await pbkdf2Async(password, salt, PBKDF2_KEYLEN);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

/** 驗證密碼(非阻塞);使用 timing-safe 比較。 */
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  try {
    const idx = stored.indexOf(":");
    if (idx < 0) return false;
    const salt = Buffer.from(stored.slice(0, idx), "hex");
    const expected = Buffer.from(stored.slice(idx + 1), "hex");
    if (expected.length === 0) return false;
    const actual = await pbkdf2Async(password, salt, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * 一個固定的假雜湊,用於「帳號不存在 / 無密碼帳號」時仍執行等量 PBKDF2,
 * 消除「帳號是否存在」的登入計時側通道(存在者慢、不存在者快 → 可列舉)。
 */
export const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));

/** 產生一個新的 session token。 */
export function newSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** 依 token 查詢有效的使用者;過期或不存在回 null。 */
export function lookupSession(db: DB, token: string | undefined | null): SessionUser | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.role, u.email, u.is_owner, u.display_name, u.must_change_password
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(token, Math.floor(Date.now() / 1000)) as SessionUser | undefined;
  return row ?? null;
}
