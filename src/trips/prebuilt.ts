/**
 * 已整理旅程匯入(移植自 main.py 的 _import_prebuilt_trips 與 import_prebuilt.py)。
 *
 * 舊版把這段邏輯在伺服器與 CLI 各抄一份;這裡合併成單一模組,兩邊共用。
 * 掃描 YYYY-MM-DD/<趟>/{前鏡頭.mp4, 後鏡頭.mp4, 資訊.txt} 結構,逐趟匯入。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { TripInfo } from "./repo.js";
import type { ProgressEvent } from "./organizer.js";
import type { DashcamDeviceSnapshot } from "../devices/repo.js";

export const DATE_FOLDER_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TRIP_FOLDER_RE = /^(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\s*\((\d+)分\)$/;
export const DUR_RE = /(\d+)m\s*(\d+)s/;

export const PREBUILT_NAMES = new Set(["前鏡頭.mp4", "後鏡頭.mp4", "資訊.txt"]);

/** 解析 資訊.txt(支援全形「：」與半形「:」分隔)。 */
export function parseInfoTxt(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    for (const sep of ["：", ":"]) {
      const i = line.indexOf(sep);
      if (i >= 0) {
        result[line.slice(0, i).trim()] = line.slice(i + sep.length).trim();
        break;
      }
    }
  }
  return result;
}

function firstInt(raw: string | undefined, dflt = 0): number {
  const m = /\d+/.exec(raw ?? "");
  return m ? Number.parseInt(m[0], 10) : dflt;
}

function firstFloat(raw: string | undefined, dflt = 0): number {
  const m = /[\d.]+/.exec(raw ?? "");
  return m ? Number.parseFloat(m[0]) : dflt;
}

/** 解析 'YYYY-MM-DD HH:MM:SS' 為本地時區 Date;失敗回 null。 */
function parseLocalDateTime(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  // 牆鐘以 UTC 解讀(與 organizer.parseEpoch 一致)
  const d = new Date(
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
    ),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

interface TripDirRef {
  date: string;
  dir: string;
  name: string;
}

/** 找出 src 下的日期資料夾;recursive=true 時往下遞迴尋找(供 CLI 處理巢狀結構)。 */
export async function collectDateDirs(src: string, recursive: boolean): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith("._")) continue;
      if (DATE_FOLDER_RE.test(e.name)) {
        found.push(path.join(dir, e.name));
      } else if (recursive && depth < 6) {
        await walk(path.join(dir, e.name), depth + 1);
      }
    }
  }
  await walk(src, 0);
  return found;
}

export interface ImportOptions {
  tripsDir: string;
  /** 'move' = 搬移(伺服器處理上傳暫存);'copy' = 複製(CLI 預設保留原檔)。 */
  mode?: "move" | "copy";
  recursive?: boolean;
  dryRun?: boolean;
  /** SSE 串接用:起始 done 與 total 偏移。 */
  offset?: number;
  /** 測試注入:覆寫實際的檔案搬移/複製(預設依 mode 走 fs)。 */
  transfer?: (src: string, dst: string) => Promise<void>;
  /** 新產物使用 owner/device namespace;省略時維持舊 CLI/測試 id。 */
  idNamespace?: string;
  ownerId?: number | null;
  ownerUsername?: string | null;
  deviceId?: number | null;
  device?: DashcamDeviceSnapshot | null;
}

async function defaultTransfer(src: string, dst: string, mode: "move" | "copy"): Promise<void> {
  if (mode === "move") {
    try {
      await fs.rename(src, dst);
    } catch (e: unknown) {
      // 跨檔案系統 rename 會失敗(EXDEV),退回 copy + unlink
      if ((e as NodeJS.ErrnoException).code === "EXDEV") {
        await fs.copyFile(src, dst);
        await fs.rm(src, { force: true });
      } else {
        throw e;
      }
    }
  } else {
    await fs.copyFile(src, dst);
  }
}

/**
 * 匯入已整理旅程,以 async generator 逐事件回報;每趟成功時事件夾帶 tripInfo。
 * 不直接寫 DB —— 呼叫端收到 tripInfo 後用 repo.upsertTrip 寫入(維持 repo 為唯一寫入者)。
 */
export async function* importPrebuiltTrips(
  src: string,
  opts: ImportOptions,
): AsyncGenerator<ProgressEvent> {
  const mode = opts.mode ?? "move";
  const offset = opts.offset ?? 0;
  const transfer = opts.transfer ?? ((s: string, d: string) => defaultTransfer(s, d, mode));

  const dateDirs = (await collectDateDirs(src, opts.recursive ?? false)).sort();
  if (dateDirs.length === 0) {
    yield { stage: "merge", message: "找不到日期資料夾(YYYY-MM-DD)" };
    return;
  }

  // 收集所有 (date, tripDir),依日期分組、組內依資料夾名排序後給 day_order。
  const byDate = new Map<string, TripDirRef[]>();
  for (const dateDir of dateDirs) {
    const date = path.basename(dateDir);
    let entries;
    try {
      entries = await fs.readdir(dateDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const trips = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("._"))
      .map((e) => ({ date, dir: path.join(dateDir, e.name), name: e.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const list = byDate.get(date) ?? [];
    list.push(...trips);
    byDate.set(date, list);
  }

  const total = [...byDate.values()].reduce((s, v) => s + v.length, 0);
  let done = 0;

  for (const date of [...byDate.keys()].sort()) {
    const trips = byDate.get(date)!;
    let dayOrder = 0;
    for (const ref of trips) {
      dayOrder++;
      yield {
        stage: "merge",
        message: `匯入 ${date} 第${dayOrder}趟…`,
        done: offset + done,
        total: offset + total,
      };
      try {
        const ev = await importOneTrip(
          ref,
          dayOrder,
          opts.tripsDir,
          opts.dryRun ?? false,
          transfer,
          opts,
        );
        if (ev.skipped) {
          yield { stage: "merge", message: ev.skipped, done: offset + done, total: offset + total };
          continue;
        }
        done++;
        yield {
          stage: "merge",
          message: `完成 ${date} 第${dayOrder}趟`,
          done: offset + done,
          total: offset + total,
          tripInfo: ev.info,
        };
      } catch (err) {
        yield {
          stage: "merge",
          message: `× ${date}/${ref.name}:${err instanceof Error ? err.message : String(err)}`,
          done: offset + done,
          total: offset + total,
        };
      }
    }
  }
}

interface OneTripResult {
  info?: TripInfo;
  skipped?: string;
}

async function importOneTrip(
  ref: TripDirRef,
  dayOrder: number,
  tripsDir: string,
  dryRun: boolean,
  transfer: (s: string, d: string) => Promise<void>,
  context: Pick<ImportOptions, "idNamespace" | "ownerId" | "ownerUsername" | "deviceId" | "device">,
): Promise<OneTripResult> {
  const m = TRIP_FOLDER_RE.exec(ref.name.trim());
  if (!m) return { skipped: `略過(名稱格式不符):${ref.date}/${ref.name}` };

  const sh = Number(m[1]);
  const sm = Number(m[2]);
  const eh = Number(m[3]);
  const em = Number(m[4]);
  const folderMin = Number(m[5]); // 資料夾名的「(N分)」—— 最可靠的時長來源

  const infoTxt = path.join(ref.dir, "資訊.txt");
  const meta = (await fileExists(infoTxt)) ? parseInfoTxt(await fs.readFile(infoTxt, "utf-8")) : {};

  const [y, mo, d] = ref.date.split("-").map(Number) as [number, number, number];

  const parseTs = (key: string, h: number, mi: number): Date => {
    const raw = meta[key];
    if (raw) {
      const dt = parseLocalDateTime(raw);
      if (dt) return dt;
    }
    return new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  };

  let startDt = parseTs("開始時間", sh, sm);
  let endDt = parseTs("結束時間", eh, em);
  // 只有「結束『早於』開始」才是真正跨午夜 → +1 天。start===end(如 08.00-08.00 的短趟,
  // 分鐘級精度下起訖同分)不可 +1 天,否則不足 1 分的旅程會被算成 24 小時。
  if (endDt.getTime() < startDt.getTime()) {
    endDt = new Date(endDt.getTime() + 86_400_000);
  }

  // 時長優先序:資訊.txt 的「總時長」→ 資料夾名的「(N分)」→ 起訖時間差。
  let durSec: number;
  if (meta["總時長"]) {
    const md = DUR_RE.exec(meta["總時長"]);
    durSec = md
      ? Number(md[1]) * 60 + Number(md[2])
      : folderMin > 0
        ? folderMin * 60
        : Math.floor((endDt.getTime() - startDt.getTime()) / 1000);
  } else if (endDt.getTime() === startDt.getTime() && folderMin > 0) {
    // 起訖同分(分鐘精度不足以反映實際長度)→ 用資料夾名的分鐘數,並據此校正結束時間。
    durSec = folderMin * 60;
    endDt = new Date(startDt.getTime() + durSec * 1000);
  } else {
    durSec = Math.floor((endDt.getTime() - startDt.getTime()) / 1000);
  }

  const segCount = firstInt(meta["片段數"], 1);
  const emerCount = firstInt(meta["緊急片段"], 0);
  const peakG = firstFloat(meta["最高G-force"], 0);
  const gforceEvents = firstInt(meta["高G事件"], 0);

  const srcFront = path.join(ref.dir, "前鏡頭.mp4");
  const srcRear = path.join(ref.dir, "後鏡頭.mp4");
  const hasFront = await fileExists(srcFront);
  const hasRear = await fileExists(srcRear);
  if (!hasFront && !hasRear) return { skipped: `略過(無影片):${ref.date}/${ref.name}` };

  const startEpoch = Math.floor(startDt.getTime() / 1000);
  const endEpoch = Math.floor(endDt.getTime() / 1000);
  const baseTripId = `pre|${ref.date}|${hhmmss(startDt)}`;
  const tripIdStr = context.idNamespace ? `${context.idNamespace}|${baseTripId}` : baseTripId;
  const destDir = path.join(tripsDir, ref.date, ref.name);
  const frontPath = hasFront ? path.join(destDir, "front.mp4") : null;
  const rearPath = hasRear ? path.join(destDir, "rear.mp4") : null;

  const info: TripInfo = {
    trip_id: tripIdStr,
    date: ref.date,
    day_order: dayOrder,
    start_epoch: startEpoch,
    end_epoch: endEpoch,
    duration_sec: durSec,
    segment_count: segCount,
    emer_count: emerCount,
    has_front: hasFront,
    has_rear: hasRear,
    front_path: frontPath,
    rear_path: rearPath,
    peak_gforce: peakG,
    gforce_events: gforceEvents,
    owner_id: context.ownerId ?? null,
    owner_username: context.ownerUsername ?? null,
    device_id: context.deviceId ?? null,
    device: context.device ?? null,
  };

  if (dryRun) return { info };

  if (
    await fs
      .stat(destDir)
      .then(() => true)
      .catch(() => false)
  )
    return { skipped: `略過既有旅程（不覆寫）：${ref.date}/${ref.name}` };
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  await fs.mkdir(destDir);
  if (hasFront && frontPath && !(await fileExists(frontPath))) await transfer(srcFront, frontPath);
  if (hasRear && rearPath && !(await fileExists(rearPath))) await transfer(srcRear, rearPath);
  await fs.writeFile(path.join(destDir, "info.json"), JSON.stringify(info, null, 2));

  return { info };
}

function hhmmss(d: Date): string {
  return (
    String(d.getUTCHours()).padStart(2, "0") +
    String(d.getUTCMinutes()).padStart(2, "0") +
    String(d.getUTCSeconds()).padStart(2, "0")
  );
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}
