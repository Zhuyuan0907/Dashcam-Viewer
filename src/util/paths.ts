/**
 * 路徑安全工具 — 防止路徑穿越(path traversal)。
 *
 * 舊 Python 版的漏洞:上傳的 prebuilt 檔名直接被當成相對路徑接在暫存區後面,
 * 攻擊者可用 `2026-01-01/../../../etc/x` 之類的檔名寫到目錄外。
 * 這裡提供唯一的安全接合點。
 */
import path from "node:path";
import { TRIPS_DIR } from "../config.js";

/**
 * 確認一個(來自 DB 的)絕對路徑確實落在旅程根目錄 TRIPS_DIR 內。
 * 用於在服務/刪除 DB 存的絕對路徑前擋掉被植入 `../` 造成的任意檔存取。
 * 正好等於根目錄本身也視為合法(與既有 video.ts 行為一致)。
 */
export function withinTrips(p: string): boolean {
  const base = path.resolve(TRIPS_DIR);
  const rp = path.resolve(p);
  return rp === base || rp.startsWith(base + path.sep);
}

/**
 * 把 `relative` 安全地接到 `base` 之下。
 * 若結果跳出 base(含任何 `..` 逃逸、絕對路徑),丟出例外。
 * 回傳正規化後的絕對路徑。
 */
export function safeJoin(base: string, relative: string): string {
  const baseResolved = path.resolve(base);
  // 拒絕絕對路徑與含有 NUL 的輸入
  if (relative.includes("\0")) {
    throw new PathTraversalError(base, relative);
  }
  const target = path.resolve(baseResolved, relative);
  // 必須嚴格落在 base 內(或正好等於 base)
  const rel = path.relative(baseResolved, target);
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new PathTraversalError(base, relative);
  }
  return target;
}

/**
 * 檢查路徑的每一段是否安全(無 `..`、無絕對路徑根、無空段)。
 * 用於在組裝前先驗證 client 傳來的相對路徑段。
 */
export function isSafeRelative(relative: string): boolean {
  if (!relative || relative.includes("\0")) return false;
  if (path.isAbsolute(relative)) return false;
  const parts = relative.split(/[/\\]/);
  return parts.every((p) => p !== ".." && p !== "" && p !== ".");
}

export class PathTraversalError extends Error {
  constructor(base: string, relative: string) {
    super(`不安全的路徑:'${relative}' 試圖跳出 '${base}'`);
    this.name = "PathTraversalError";
  }
}
