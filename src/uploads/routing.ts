/**
 * 上傳檔案分類(純函式,易測試)。
 *
 * 依 client 送來的相對路徑(webkitRelativePath)決定每個檔案該放哪:
 *   - 已整理旅程(prebuilt):路徑含日期夾,或檔名是 前/後鏡頭.mp4 / 資訊.txt
 *   - 原始片段(raw):FILE/EMER…F|R.mp4 → F/R 夾;…F.NMEA → NMEA 夾
 *   - 其餘:拒絕或略過
 */
import { FILENAME_RE, NMEA_RE } from "../trips/organizer.js";
import { DATE_FOLDER_RE, PREBUILT_NAMES } from "../trips/prebuilt.js";

export type UploadDecision =
  | { action: "skip" } // macOS sidecar / 感測器數據,靜默略過
  | { action: "reject"; basename: string } // 格式不符
  | { action: "prebuilt"; relative: string } // 寫到 prebuilt 暫存區(relative 已驗證安全)
  | { action: "raw"; subdir: "F" | "R" | "NMEA"; basename: string };

function basenameOf(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] ?? p;
}

export function classifyUpload(rawPath: string): UploadDecision {
  const basename = basenameOf(rawPath);

  if (basename.startsWith("._") || rawPath.includes("感測器數據")) {
    return { action: "skip" };
  }

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

  const mMp4 = FILENAME_RE.exec(basename);
  if (mMp4) {
    const cam = mMp4[5]!.toUpperCase() as "F" | "R";
    return { action: "raw", subdir: cam, basename };
  }
  if (NMEA_RE.exec(basename)) {
    return { action: "raw", subdir: "NMEA", basename };
  }
  return { action: "reject", basename };
}
