import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SHARE_TOKEN_KEY_PATH } from "../config.js";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 1;
let cachedKey: Buffer | null = null;

function readKey(): Buffer | null {
  try {
    const key = fs.readFileSync(SHARE_TOKEN_KEY_PATH);
    if (key.length !== KEY_BYTES) {
      throw new Error(`分享連結金鑰長度錯誤：${SHARE_TOKEN_KEY_PATH}`);
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function createKey(): Buffer {
  fs.mkdirSync(path.dirname(SHARE_TOKEN_KEY_PATH), { recursive: true });
  const generated = crypto.randomBytes(KEY_BYTES);
  try {
    const fd = fs.openSync(SHARE_TOKEN_KEY_PATH, "wx", 0o600);
    try {
      fs.writeFileSync(fd, generated);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readKey();
    if (!existing) throw new Error("分享連結金鑰建立失敗");
    return existing;
  }
}

/**
 * 啟動時先確認金鑰狀態。已有密文卻遺失金鑰時必須直接失敗，避免靜默產生
 * 新金鑰後讓既有連結永久無法取回。
 */
export function initializeShareTokenVault(hasStoredSecrets: boolean): void {
  cachedKey = null;
  const existing = readKey();
  if (existing) {
    cachedKey = existing;
    return;
  }
  if (hasStoredSecrets) {
    throw new Error(`找不到分享連結金鑰：${SHARE_TOKEN_KEY_PATH}`);
  }
  cachedKey = createKey();
}

function key(): Buffer {
  if (!cachedKey) initializeShareTokenVault(false);
  return cachedKey!;
}

function aad(shareId: number, tokenHash: string): Buffer {
  return Buffer.from(`dashcam-share-v1:${shareId}:${tokenHash}`, "utf8");
}

export function sealShareToken(token: string, shareId: number, tokenHash: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(aad(shareId, tokenHash));
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, tag, encrypted]).toString("base64url");
}

export function openShareToken(
  ciphertext: string,
  shareId: number,
  tokenHash: string,
): string | null {
  try {
    const packed = Buffer.from(ciphertext, "base64url");
    if (packed.length <= 1 + IV_BYTES + TAG_BYTES || packed[0] !== FORMAT_VERSION) return null;
    const iv = packed.subarray(1, 1 + IV_BYTES);
    const tag = packed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const encrypted = packed.subarray(1 + IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAAD(aad(shareId, tokenHash));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
