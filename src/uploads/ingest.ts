/**
 * 把 SFTP 丟進來的「扁平/任意結構」資料夾,整理成既有 process 管線預期的結構。
 *
 * 使用者透過 SFTP 把片段直接倒進 UPLOAD_DIR/<sid>(不分類)。確認處理時呼叫本函式:
 * 逐檔以相對路徑交給既有的 classifyUpload(唯一分類真相),把:
 *   - raw    → UPLOAD_DIR/<sid>/{F,R,NMEA}/<basename>
 *   - prebuilt → PREBUILT_DIR/<sid>/<date 樹相對路徑>
 * 產出結構剛好等於 processBatch / importPrebuiltTrips 的輸入,下游零改動。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { UPLOAD_DIR, PREBUILT_DIR } from "../config.js";
import { safeJoin } from "../util/paths.js";
import { classifyUpload } from "./routing.js";

export interface IngestResult {
  accepted: number;
  rejected: string[];
  uploadType: "raw" | "prebuilt" | "mixed" | "empty";
}

/** 跨檔案系統安全的搬移。 */
async function moveFile(src: string, dst: string): Promise<void> {
  if (path.resolve(src) === path.resolve(dst)) return; // 同位置免動
  await fs.mkdir(path.dirname(dst), { recursive: true });
  try {
    await fs.rename(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EXDEV") {
      await fs.copyFile(src, dst);
      await fs.rm(src, { force: true });
    } else {
      throw e;
    }
  }
}

/** 收集資料夾下所有檔案的絕對路徑(深度優先)。 */
async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

export async function ingestFlatFolder(sid: string): Promise<IngestResult> {
  const root = path.join(UPLOAD_DIR, sid);
  const files = await walkFiles(root);

  let rawCount = 0;
  let preCount = 0;
  const rejected: string[] = [];

  for (const abs of files) {
    const relative = path.relative(root, abs);
    const decision = classifyUpload(relative);

    if (decision.action === "skip") continue;
    if (decision.action === "reject") {
      rejected.push(decision.basename);
      continue;
    }
    if (decision.action === "prebuilt") {
      const dst = safeJoin(path.join(PREBUILT_DIR, sid), decision.relative);
      await moveFile(abs, dst);
      preCount++;
    } else {
      const dst = path.join(root, decision.subdir, decision.basename);
      await moveFile(abs, dst);
      rawCount++;
    }
  }

  const uploadType =
    rawCount && preCount ? "mixed" : preCount ? "prebuilt" : rawCount ? "raw" : "empty";
  return { accepted: rawCount + preCount, rejected, uploadType };
}
