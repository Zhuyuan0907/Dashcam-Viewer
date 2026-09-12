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
import { describeUpload, type UploadProfile } from "./routing.js";

export interface IngestResult {
  accepted: number;
  rejected: string[];
  uploadType: "raw" | "prebuilt" | "mixed" | "empty";
  /** 本批原始片段實際辨識到的格式；prebuilt 不列入。 */
  rawProfiles: UploadProfile[];
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
  // 崩潰恢復:上一次確認可能已把 prebuilt 檔搬到 PREBUILT_DIR/<sid> 後才中斷。
  // 這些檔案不在 UPLOAD_DIR/<sid> 掃不到,若不列入計數,重新確認會回報「沒有可處理檔案」
  // 或 uploadType 漏掉 prebuilt → 已搬移的素材永遠不被匯入,最後隨 session 移除被靜默刪除。
  let preCount = (await walkFiles(path.join(PREBUILT_DIR, sid))).length;
  const rejected: string[] = [];
  const rawProfiles = new Set<UploadProfile>();

  /**
   * 搬移前的同名碰撞防護:目標已存在(且非同一路徑)時,同大小視為重複、刪來源即可;
   * 大小不同代表「不同內容撞名」,直接覆蓋會靜默毀掉先到的檔 → 改列入 rejected 保留原地。
   * 回傳是否算入 accepted。
   */
  async function moveGuarded(abs: string, dst: string, name: string): Promise<boolean> {
    if (path.resolve(abs) !== path.resolve(dst)) {
      try {
        const [src, exist] = await Promise.all([fs.stat(abs), fs.stat(dst)]);
        if (src.size !== exist.size) {
          rejected.push(`${name}(同名但內容不同,已保留原檔)`);
          return false;
        }
        await fs.rm(abs, { force: true }); // 同名同大小:視為重複上傳
        return true;
      } catch {
        /* 目標不存在 → 正常搬移 */
      }
    }
    await moveFile(abs, dst);
    return true;
  }

  for (const abs of files) {
    const relative = path.relative(root, abs);
    const described = describeUpload(relative);
    const decision = described.decision;

    if (decision.action === "skip") continue;
    if (decision.action === "reject") {
      rejected.push(decision.basename);
      continue;
    }
    if (decision.action === "prebuilt") {
      const dst = safeJoin(path.join(PREBUILT_DIR, sid), decision.relative);
      if (await moveGuarded(abs, dst, decision.relative)) preCount++;
    } else {
      if (described.profile && described.profile !== "prebuilt") rawProfiles.add(described.profile);
      const dst = path.join(root, decision.subdir, decision.basename);
      if (await moveGuarded(abs, dst, decision.basename)) rawCount++;
    }
  }

  const uploadType =
    rawCount && preCount ? "mixed" : preCount ? "prebuilt" : rawCount ? "raw" : "empty";
  return { accepted: rawCount + preCount, rejected, uploadType, rawProfiles: [...rawProfiles].sort() };
}
