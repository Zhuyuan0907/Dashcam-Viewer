/**
 * 上傳檔案分類(純函式,易測試)。
 *
 * 依 client 送來的相對路徑(webkitRelativePath)決定每個檔案該放哪:
 *   - 已整理旅程(prebuilt):路徑含日期夾,或檔名是 前/後鏡頭.mp4 / 資訊.txt
 *   - MiVue 原始片段(raw):FILE/EMER…F|R.mp4 → F/R 夾;…F.NMEA → NMEA 夾
 *   - Polaroid MS279WG:YYYY_MMDD_HHMMSS_NNNA|B.TS → F/R 夾(A=前、B=後)
 *   - 其餘:拒絕或略過
 */
import { FILENAME_RE, NMEA_RE } from "../trips/organizer.js";
import { DATE_FOLDER_RE, PREBUILT_NAMES } from "../trips/prebuilt.js";
import { parsePolaroidMs279wgFilename } from "../dashcams/polaroid-ms279wg.js";
import { parseGenericFilename } from '../dashcams/generic.js';

export type UploadDecision =
  | { action: "skip" } // macOS sidecar / 感測器數據,靜默略過
  | { action: "reject"; basename: string } // 格式不符
  | { action: "prebuilt"; relative: string } // 寫到 prebuilt 暫存區(relative 已驗證安全)
  | { action: "raw"; subdir: "F" | "R" | "NMEA"; basename: string };

export type UploadProfile = "mivue-mp20" | "polaroid-ms279wg" | "generic" | "prebuilt";

/** 供預檢與 ingest 顯示來源格式；分類本身仍維持精簡且向後相容。 */
export function describeUpload(rawPath: string): {
  decision: UploadDecision;
  profile: UploadProfile | null;
  camera: "front" | "rear" | "data" | null;
  reason: string | null;
} {
  const decision = classifyUpload(rawPath);
  const basename = basenameOf(rawPath);
  const polaroid = parsePolaroidMs279wgFilename(basename);
  if (decision.action === 'raw' && parseGenericFilename(basename)) {
    return {decision, profile:'generic', camera:decision.subdir === 'F' ? 'front' : 'rear', reason:null};
  }
  if (decision.action === "raw" && polaroid) {
    return {
      decision,
      profile: "polaroid-ms279wg",
      camera: polaroid.camera === "F" ? "front" : "rear",
      reason: null,
    };
  }
  if (decision.action === "raw") {
    return {
      decision,
      profile: "mivue-mp20",
      camera: decision.subdir === "F" ? "front" : decision.subdir === "R" ? "rear" : "data",
      reason: null,
    };
  }
  if (decision.action === "prebuilt") {
    return { decision, profile: "prebuilt", camera: null, reason: null };
  }
  if (decision.action === "skip") {
    return { decision, profile: null, camera: null, reason: "系統中繼檔或感測器資料，將略過" };
  }
  return { decision, profile: null, camera: null, reason: "檔名不符合目前支援的格式" };
}

function basenameOf(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] ?? p;
}

export function classifyUpload(rawPath: string): UploadDecision {
  const basename = basenameOf(rawPath);
  const generic = parseGenericFilename(basename);
  if (generic) return {action:'raw',subdir:generic.camera,basename};

  if (basename.startsWith("._") || rawPath.includes("感測器數據")) {
    return { action: "skip" };
  }

  // 先看檔名本身是否為原始片段命名 —— 即使它被放在日期夾底下(有些人把原始細碎檔
  // 也依日期分資料夾),仍應走 raw 管線,而非被日期夾誤判成 prebuilt 後永遠不會被匯入、
  // 且處理結束即遭刪除。同時把鏡頭字母正規化為大寫、副檔名為 .mp4/.NMEA,避免小寫檔名
  // 因下游以固定大寫路徑重建而找不到、合併失敗。
  const mMp4 = FILENAME_RE.exec(basename);
  if (mMp4) {
    const [, prefix, ymd, hms, seq, camRaw] = mMp4;
    const cam = camRaw!.toUpperCase() as "F" | "R";
    return { action: "raw", subdir: cam, basename: `${prefix}${ymd}-${hms}-${seq}${cam}.mp4` };
  }
  const mNmea = NMEA_RE.exec(basename);
  if (mNmea) {
    const [, prefix, ymd, hms, seq] = mNmea;
    return { action: "raw", subdir: "NMEA", basename: `${prefix}${ymd}-${hms}-${seq}F.NMEA` };
  }

  const polaroid = parsePolaroidMs279wgFilename(basename);
  if (polaroid) {
    return {
      action: "raw",
      subdir: polaroid.camera,
      basename: polaroid.normalizedName,
    };
  }

  // 非原始片段命名 → 可能是已整理旅程(prebuilt):檔名為 前/後鏡頭.mp4 / 資訊.txt,
  // 或路徑含日期夾。
  const parts = rawPath.split(/[/\\]/).filter((p) => p !== "");
  const dateIdx = parts.findIndex((p) => DATE_FOLDER_RE.test(p));
  const isPre = PREBUILT_NAMES.has(basename) || dateIdx >= 0;

  if (isPre) {
    // 以日期夾為根的相對路徑;含 `..` 等不安全段一律拒絕(防路徑穿越)
    const segs = dateIdx >= 0 ? parts.slice(dateIdx) : [basename];
    if (segs.some((s) => s === ".." || s === "." || s === "")) {
      return { action: "reject", basename };
    }
    return { action: "prebuilt", relative: segs.join("/") };
  }

  return { action: "reject", basename };
}
