/**
 * Polaroid MS279WG 原始片段命名與前後鏡頭配對。
 *
 * 實機格式:YYYY_MMDD_HHMMSS_seq(A|B).TS
 *   A = 前鏡頭、B = 後鏡頭。兩顆鏡頭的檔名時間可能相差 1 秒,流水號也不是固定奇偶,
 *   因此配對必須以最近時間為準,不能靠流水號或完全相同的檔名 base。跨午夜時
 *   前後鏡頭可能落在不同日期,只要絕對時間差仍在容許範圍內就應視為同一組。
 */

export const POLAROID_MS279WG_PROFILE = "polaroid-ms279wg" as const;
export const POLAROID_MS279WG_PAIR_TOLERANCE_SEC = 2;

export const POLAROID_MS279WG_FILENAME_RE =
  /^(\d{4})_(\d{4})_(\d{6})_(\d+)(A|B)\.(TS|MP4)$/i;

export interface PolaroidMs279wgFile {
  profile: typeof POLAROID_MS279WG_PROFILE;
  originalName: string;
  normalizedName: string;
  camera: "F" | "R";
  channel: "A" | "B";
  extension: "TS" | "mp4";
  epoch: number;
  dateKey: string;
  sequence: number;
  /** 不含鏡頭字母的穩定識別,供 trip id / 記錄使用。 */
  segmentId: string;
}

/** 解析並嚴格驗證日期時間;格式不符或日期溢位時回 null。 */
export function parsePolaroidMs279wgFilename(name: string): PolaroidMs279wgFile | null {
  const m = POLAROID_MS279WG_FILENAME_RE.exec(name);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]!.slice(0, 2));
  const day = Number(m[2]!.slice(2, 4));
  const hour = Number(m[3]!.slice(0, 2));
  const minute = Number(m[3]!.slice(2, 4));
  const second = Number(m[3]!.slice(4, 6));
  const sequence = Number.parseInt(m[4]!, 10);
  const channel = m[5]!.toUpperCase() as "A" | "B";
  const extension = m[6]!.toUpperCase() === "TS" ? "TS" : "mp4";

  if (
    month < 1 || month > 12 || day < 1 || day > 31 ||
    hour > 23 || minute > 59 || second > 59 || !Number.isSafeInteger(sequence)
  ) {
    return null;
  }
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day || d.getUTCHours() !== hour ||
    d.getUTCMinutes() !== minute || d.getUTCSeconds() !== second
  ) {
    return null;
  }

  const y = String(year).padStart(4, "0");
  const md = `${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
  const hms = `${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}${String(second).padStart(2, "0")}`;
  const seq = m[4]!;
  return {
    profile: POLAROID_MS279WG_PROFILE,
    originalName: name,
    normalizedName: `${y}_${md}_${hms}_${seq}${channel}.${extension}`,
    camera: channel === "A" ? "F" : "R",
    channel,
    extension,
    epoch: Math.floor(d.getTime() / 1000),
    dateKey: `${y}${md}`,
    sequence,
    segmentId: `MS279WG-${y}${md}-${hms}-${seq}`,
  };
}

/**
 * 為一支前鏡頭片段找最近、尚未使用的後鏡頭片段。
 * 實機樣本 47 組的偏差均為 0 或 1 秒;容許 2 秒保留時鐘取整餘裕。
 */
export function findPolaroidMs279wgRear(
  front: PolaroidMs279wgFile,
  rearFiles: PolaroidMs279wgFile[],
  usedNames: ReadonlySet<string>,
  toleranceSec = POLAROID_MS279WG_PAIR_TOLERANCE_SEC,
): PolaroidMs279wgFile | null {
  if (front.camera !== "F") return null;
  const candidates = rearFiles
    .filter((r) =>
      r.camera === "R" &&
      !usedNames.has(r.normalizedName) && Math.abs(r.epoch - front.epoch) <= toleranceSec,
    )
    .sort((a, b) =>
      Math.abs(a.epoch - front.epoch) - Math.abs(b.epoch - front.epoch) ||
      Math.abs(a.sequence - front.sequence) - Math.abs(b.sequence - front.sequence) ||
      a.sequence - b.sequence,
    );
  return candidates[0] ?? null;
}
