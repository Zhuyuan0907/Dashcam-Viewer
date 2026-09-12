/**
 * 行車記錄器旅程整理器(移植自 organizer.py)。
 * 把細碎影片依「日期/趟次」整理、用 ffmpeg 無損合併成完整旅程。
 *
 * 支援 MiVue `(FILE|EMER)(YYMMDD)-(HHMMSS)-(seq)(F|R).mp4`，以及
 * Polaroid MS279WG `YYYY_MMDD_HHMMSS_seq(A|B).TS`（A=前鏡頭、B=後鏡頭）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { probeDuration, probeReadable, concatCopy, FALLBACK_DURATION } from "../media/ffmpeg.js";
import type { TripInfo } from "./repo.js";
import type { DashcamDeviceSnapshot } from "../devices/repo.js";
import type { Span } from '../media/timeline.js';
import { parseGenericFilename } from '../dashcams/generic.js';
import { inspectMedia } from '../media/inspect.js';
import {
  findPolaroidMs279wgRear,
  parsePolaroidMs279wgFilename,
} from "../dashcams/polaroid-ms279wg.js";

// ── 常數(regex 與舊版完全一致) ──────────────────────────────────────────────
export const FILENAME_RE = /^(FILE|EMER)(\d{6})-(\d{6})-(\d+)(F|R)\.mp4$/i;
export const NMEA_RE = /^(FILE|EMER)(\d{6})-(\d{6})-(\d+)(F)\.NMEA$/i;

export const GAP_SECONDS = 15 * 60; // 15 分鐘 → 新旅程

// ── 資料結構 ──────────────────────────────────────────────────────────────────
export interface Segment {
  base: string; // "FILE240115-083000-001"
  prefix: string; // "FILE" | "EMER"
  epoch: number; // 起始時間(把記錄器檔名牆鐘以 UTC 儲存,顯示端同樣用 UTC)
  seq: number;
  duration: number;
  isEmergency: boolean;
  /** 非舊版 F/R.mp4 命名時,保存實際來源 basename。 */
  frontFilename?: string;
  rearFilename?: string;
  rearEpoch?: number;
  nmeaFilename?: string;
  sourceProfile?: string;
}

export interface Trip {
  date: string; // "2024-01-15"
  dayOrder: number;
  startEpoch: number;
  endEpoch: number;
  segments: Segment[];
}

/** 失敗事件的結構化內容,供善後系統持久記錄(不送進 SSE wire)。 */
export interface IncidentPayload {
  kind: "merge_failed" | "trip_skipped" | "processing_error";
  severity: "info" | "warn" | "error";
  trip_label?: string;
  title: string;
  detail: string;
  context: Record<string, unknown>;
  /** 此事件專屬的隔離素材路徑(覆寫 session 層級的預設);未設則沿用 session 的隔離夾。 */
  quarantine_dir?: string | null;
}

/** 進度事件;完成一趟時夾帶 tripInfo 供呼叫端寫入 DB;失敗時夾帶 incident。 */
export interface ProgressEvent {
  stage: string;
  message: string;
  done?: number;
  total?: number;
  progress?: number;
  trip_index?: number;
  trip_total?: number;
  pending?: number;
  tripInfo?: TripInfo;
  incident?: IncidentPayload;
}

// ── 工具函數 ──────────────────────────────────────────────────────────────────

/** YYMMDD + HHMMSS → Unix timestamp(本地時區);失敗回 null。 */
export function parseEpoch(yymmdd: string, hhmmss: string): number | null {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(yymmdd);
  const t = /^(\d{2})(\d{2})(\d{2})$/.exec(hhmmss);
  if (!m || !t) return null;
  const year = 2000 + Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hh = Number(t[1]);
  const mm = Number(t[2]);
  const ss = Number(t[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hh > 23 || mm > 59 || ss > 59) return null;
  // 行車記錄器檔名是「牆鐘」。以 UTC 解讀、顯示端也以 UTC 呈現 → 顯示時間 == 檔名,
  // 與伺服器/瀏覽器時區無關(避免雙重時區偏移)。
  const d = new Date(Date.UTC(year, month - 1, day, hh, mm, ss));
  // 驗證沒有溢位(例如 02/30 會被 JS 自動進位)
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return Math.floor(d.getTime() / 1000);
}

function fmtHHdotMM(epoch: number): string {
  const d = new Date(epoch * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}.${mm}`;
}

function dateStr(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 旅程資料夾名:`HH.MM-HH.MM (N分)`,與 organize.sh 取整邏輯一致(最少 1 分)。 */
export function folderName(trip: Trip): string {
  const durationSec = trip.endEpoch - trip.startEpoch;
  const mins = Math.max(1, Math.floor((durationSec + 30) / 60));
  return `${fmtHHdotMM(trip.startEpoch)}-${fmtHHdotMM(trip.endEpoch)} (${mins}分)`;
}

/** 旅程 ID:第一段 base + 段數 + 末段 seq(沿用舊規則以保相容)。
 *  注意:含「段數」,故同一趟分批上傳會產生不同 id —— 已知脆弱點,維持相容不在此修。 */
export function tripId(trip: Trip): string {
  if (trip.segments.length === 0) return "";
  const first = trip.segments[0]!.base;
  const count = trip.segments.length;
  const lastSeq = trip.segments[trip.segments.length - 1]!.seq;
  return `${first}|${count}|${lastSeq}`;
}

/** 掃描 F/ 資料夾,回傳依(epoch, seq)排序的前鏡頭片段。 */
export async function scanSegments(frontDir: string, rearDir?: string): Promise<Segment[]> {
  let names: string[];
  try {
    names = await fs.readdir(frontDir);
  } catch {
    names = [];
  }
  let rearNames: string[] = [];
  if (rearDir) {
    try {
      rearNames = await fs.readdir(rearDir);
    } catch {
      rearNames = [];
    }
  }
  const polaroidRears = rearNames
    .map(parsePolaroidMs279wgFilename)
    .filter(
      (f): f is NonNullable<ReturnType<typeof parsePolaroidMs279wgFilename>> =>
        f?.camera === "R",
    );
  const usedPolaroidRears = new Set<string>();
  const segments: Segment[] = [];
  for (const name of names) {
    const generic = parseGenericFilename(name);
    if (generic?.camera === 'F') {
      segments.push({base:generic.base,prefix:'FILE',epoch:generic.epoch,seq:generic.sequence,
        duration:FALLBACK_DURATION,isEmergency:false,frontFilename:name,
        rearFilename:rearNames.find(n=>n.toLowerCase() === generic.peer.toLowerCase()),sourceProfile:'generic'});
      continue;
    }
    const m = FILENAME_RE.exec(name);
    if (m) {
      const [, prefix, yymmdd, hhmmss, seqStr, camera] = m;
      if (camera!.toUpperCase() !== "F") continue;
      const epoch = parseEpoch(yymmdd!, hhmmss!);
      if (epoch === null) continue;
      segments.push({
        base: `${prefix}${yymmdd}-${hhmmss}-${seqStr}`,
        prefix: prefix!,
        epoch,
        seq: Number.parseInt(seqStr!, 10),
        duration: FALLBACK_DURATION,
        isEmergency: prefix!.toUpperCase() === "EMER",
      });
      continue;
    }

    const polaroid = parsePolaroidMs279wgFilename(name);
    if (!polaroid || polaroid.camera !== "F") continue;
    const rear = findPolaroidMs279wgRear(polaroid, polaroidRears, usedPolaroidRears);
    if (rear) usedPolaroidRears.add(rear.normalizedName);
    segments.push({
      base: polaroid.segmentId,
      prefix: "FILE",
      epoch: polaroid.epoch,
      seq: polaroid.sequence,
      duration: FALLBACK_DURATION,
      isEmergency: false,
      frontFilename: name,
      rearFilename: rear?.originalName,
      rearEpoch: rear?.epoch,
      sourceProfile: polaroid.profile,
    });
  }
  // Rear-only recordings are independent segments, not silently discarded for lacking a front peer.
  const paired = new Set(segments.map(s => sourceFilename(s, 'R').toLowerCase()));
  for (const name of rearNames) {
    if (paired.has(name.toLowerCase())) continue;
    const generic = parseGenericFilename(name);
    const polaroid = parsePolaroidMs279wgFilename(name);
    const m = FILENAME_RE.exec(name);
    if (generic?.camera === 'R') {
      segments.push({base:generic.base,prefix:'FILE',epoch:generic.epoch,seq:generic.sequence,
        duration:FALLBACK_DURATION,isEmergency:false,rearFilename:name,sourceProfile:'generic'});
    } else if (polaroid?.camera === 'R') {
      segments.push({base:polaroid.segmentId,prefix:'FILE',epoch:polaroid.epoch,seq:polaroid.sequence,
        duration:FALLBACK_DURATION,isEmergency:false,rearFilename:name,rearEpoch:polaroid.epoch,sourceProfile:polaroid.profile});
    } else if (m?.[5]?.toUpperCase() === 'R') {
      const epoch = parseEpoch(m[2]!, m[3]!);
      if (epoch !== null) segments.push({base:`${m[1]}${m[2]}-${m[3]}-${m[4]}`,prefix:m[1]!,epoch,
        seq:Number(m[4]),duration:FALLBACK_DURATION,isEmergency:m[1]!.toUpperCase()==='EMER',rearFilename:name});
    }
  }
  segments.sort((a, b) => a.epoch - b.epoch || a.seq - b.seq);
  return segments;
}

/** 依時間間隔把片段切成多趟旅程。 */
export function detectTrips(segments: Segment[], gapSec = GAP_SECONDS): Trip[] {
  if (segments.length === 0) return [];
  const trips: Trip[] = [];
  let current: Segment[] = [segments[0]!];

  for (const seg of segments.slice(1)) {
    const prev = current[current.length - 1]!;
    const prevEnd = prev.epoch + prev.duration;
    const gap = seg.epoch - prevEnd;
    if (gap > gapSec) {
      trips.push(makeTrip(current));
      current = [seg];
    } else {
      current.push(seg);
    }
  }
  trips.push(makeTrip(current));
  assignDayOrders(trips);
  return trips;
}

function makeTrip(segments: Segment[]): Trip {
  const start = segments[0]!.epoch;
  const last = segments[segments.length - 1]!;
  const end = last.epoch + last.duration;
  return { date: dateStr(start), dayOrder: 0, startEpoch: start, endEpoch: end, segments: [...segments] };
}

function assignDayOrders(trips: Trip[]): void {
  const counts = new Map<string, number>();
  for (const trip of trips) {
    const n = (counts.get(trip.date) ?? 0) + 1;
    counts.set(trip.date, n);
    trip.dayOrder = n;
  }
}

/**
 * 解析 NMEA 檔的 G-force 資料。格式: $GSENSORD,X,Y,Z,...
 * 註:此處算的是三軸合力 √(x²+y²+z²),靜止時約等於 1g(含重力),沿用舊版語意。
 */
export async function analyzeNmea(
  nmeaPath: string,
  threshold = 1.8,
): Promise<{ peakG: number; eventCount: number }> {
  let peakG = 0;
  let eventCount = 0;
  let text: string;
  try {
    text = await fs.readFile(nmeaPath, "latin1");
  } catch {
    return { peakG: 0, eventCount: 0 };
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("$GSENSORD")) continue;
    const parts = line.split(",");
    if (parts.length < 4) continue;
    const x = Number.parseFloat(parts[1]!);
    const y = Number.parseFloat(parts[2]!);
    const z = Number.parseFloat(parts[3]!.split("*")[0]!);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const g = Math.sqrt(x * x + y * y + z * z);
    if (g > peakG) peakG = g;
    if (g > threshold) eventCount++;
  }
  return { peakG: Math.round(peakG * 1000) / 1000, eventCount };
}

// ── 主要處理流程 ──────────────────────────────────────────────────────────────

export interface ProcessOptions {
  uploadDir: string;
  tripsDir: string;
  gapSec?: number;
  doneTripIds?: Set<string>;
  /**
   * 容錯模式:合併前先以 ffprobe 過濾掉讀不到的壞段,只串接有效段。
   * 用於「容錯重合」修復 —— 對應 ffmpeg「第一段壞掉就整個失敗」的情形。
   */
  tolerant?: boolean;
  /** 新產物使用 owner/device namespace;省略時維持舊 CLI/測試 id。 */
  idNamespace?: string;
  ownerId?: number | null;
  ownerUsername?: string | null;
  deviceId?: number | null;
  device?: DashcamDeviceSnapshot | null;
}

/**
 * 完整處理:掃描 → 取時長(ffprobe,非阻塞)→ 偵測旅程 → 合併 → 分析 NMEA。
 * 以 async generator 逐事件回報;完成一趟時事件夾帶 tripInfo。
 */
export async function* processBatch(opts: ProcessOptions): AsyncGenerator<ProgressEvent> {
  const gapSec = opts.gapSec ?? GAP_SECONDS;
  const doneTripIds = opts.doneTripIds ?? new Set<string>();
  const frontDir = path.join(opts.uploadDir, "F");
  const rearDir = path.join(opts.uploadDir, "R");
  const nmeaDir = path.join(opts.uploadDir, "NMEA");

  // Step 1: 掃描
  yield { stage: "scan", message: "掃描影片檔案中…" };
  const segments = await scanSegments(frontDir, rearDir);
  if (segments.length === 0) {
    yield {
      stage: "error",
      message: "在 F/、R/ 資料夾中找不到符合命名規則的影片",
      incident: {
        kind: "processing_error",
        severity: "warn",
        title: "找不到可處理的前鏡頭片段",
        detail:
          `掃描 ${frontDir} 後沒有符合命名規則的影片。支援 ` +
          `(FILE|EMER)YYMMDD-HHMMSS-seqF.mp4 與 Polaroid MS279WG YYYY_MMDD_HHMMSS_seqA.TS。`,
        context: { frontDir },
      },
    };
    return;
  }
  yield { stage: "scan", message: `找到 ${segments.length} 組拍攝片段` };

  // Step 2: 取時長(ffprobe,非阻塞)。以小批併發(每個 probe 各 spawn 一個獨立子程序、
  // 彼此無依賴),避免大批上傳時逐段串行讓時長階段耗時線性放大。
  yield { stage: "duration", message: `讀取影片時長(共 ${segments.length} 個)…` };
  const PROBE_CONCURRENCY = 4;
  let probed = 0;
  for (let i = 0; i < segments.length; i += PROBE_CONCURRENCY) {
    const chunk = segments.slice(i, i + PROBE_CONCURRENCY);
    await Promise.all(
      chunk.map(async (seg) => {
        const f = path.join(frontDir, sourceFilename(seg, "F"));
        if (await fileExists(f)) seg.duration = await probeDuration(f);
        else seg.duration = await probeDuration(path.join(rearDir, sourceFilename(seg, 'R')));
      }),
    );
    probed += chunk.length;
    yield {
      stage: "duration",
      message: `時長讀取中… ${probed}/${segments.length}`,
      progress: Math.round((probed / segments.length) * 100),
    };
  }

  // Step 3: 偵測旅程
  const trips = detectTrips(segments, gapSec);
  yield { stage: "detect", message: `偵測到 ${trips.length} 趟旅程(間隔閾值 ${Math.floor(gapSec / 60)} 分鐘)` };

  const effectiveTripId = (t: Trip): string =>
    opts.idNamespace ? `${opts.idNamespace}|${tripId(t)}` : tripId(t);
  const toProcess = trips.filter((t) => !doneTripIds.has(effectiveTripId(t)));
  yield {
    stage: "detect",
    message: `其中 ${toProcess.length} 趟需要處理`,
    total: trips.length,
    pending: toProcess.length,
  };
  if (toProcess.length === 0) {
    yield { stage: "done", message: "所有旅程均已處理完成!" };
    return;
  }

  // Step 4 + 5: 合併 + 分析
  for (let idx = 0; idx < toProcess.length; idx++) {
    const trip = toProcess[idx]!;
    const startLabel = fmtHM(trip.startEpoch);
    const endLabel = fmtHM(trip.endEpoch);
    const tripLabel = `${trip.date} ${startLabel}～${endLabel}`;

    yield {
      stage: "merge",
      message: `[${idx + 1}/${toProcess.length}] 處理旅程:${tripLabel}`,
      trip_index: idx + 1,
      trip_total: toProcess.length,
    };

    const tripDir = path.join(opts.tripsDir, trip.date, folderName(trip));
    await fs.mkdir(tripDir, { recursive: true });
    const bases = trip.segments.map((s) => s.base);

    const frontOut = path.join(tripDir, "前鏡頭.mp4");
    const rearOut = path.join(tripDir, "後鏡頭.mp4");
    const tolerant = opts.tolerant ?? false;

    // 合併前後鏡頭(成功與否以實際合併結果為準,而非檔案是否存在)。
    const frontRes: MergeResult = { ok: false, found: 0, dropped: 0 };
    for await (const ev of mergeCameraEvents(trip.segments, frontDir, "F", frontOut, frontRes, tolerant)) yield ev;
    const frontOk = frontRes.ok;
    const rearRes: MergeResult = { ok: false, found: 0, dropped: 0 };
    for await (const ev of mergeCameraEvents(trip.segments, rearDir, "R", rearOut, rearRes, tolerant)) yield ev;
    const rearOk = rearRes.ok;

    // 前後鏡頭都沒合成出有效影片:不寫入空旅程(否則介面會出現無法播放的項目),
    // 並夾帶結構化失敗內容供善後系統持久記錄。
    if (!frontOk && !rearOk) {
      await fs.rm(tripDir, { recursive: true, force: true }).catch(() => {});
      const detail = [
        `前鏡頭(找到 ${frontRes.found} 段):${frontRes.error ?? "未知錯誤"}`,
        `後鏡頭(找到 ${rearRes.found} 段):${rearRes.error ?? "未知錯誤"}`,
      ].join("\n");
      yield {
        stage: "merge",
        message: `  ⚠ 旅程 ${tripLabel} 合併失敗,未產生有效影片,已略過`,
        incident: {
          kind: "trip_skipped",
          severity: "error",
          trip_label: tripLabel,
          title: `旅程合併失敗:${tripLabel}`,
          detail,
          context: {
            date: trip.date,
            folder: folderName(trip),
            segment_count: trip.segments.length,
            segment_bases: bases,
            owner_id: opts.ownerId ?? null,
            device_id: opts.deviceId ?? null,
            device: opts.device ?? null,
            front: { found: frontRes.found, dropped: frontRes.dropped, error: frontRes.error },
            rear: { found: rearRes.found, dropped: rearRes.dropped, error: rearRes.error },
          },
        },
      };
      continue;
    }

    // 分析 NMEA
    let peakG = 0;
    let gEvents = 0;
    if (await dirExists(nmeaDir)) {
      for (const seg of trip.segments) {
        const nf = path.join(nmeaDir, seg.nmeaFilename ?? `${seg.base}F.NMEA`);
        if (await fileExists(nf)) {
          const r = await analyzeNmea(nf);
          if (r.peakG > peakG) peakG = r.peakG;
          gEvents += r.eventCount;
        }
      }
    }

    const info: TripInfo = {
      trip_id: effectiveTripId(trip),
      date: trip.date,
      day_order: trip.dayOrder,
      start_epoch: trip.startEpoch,
      end_epoch: trip.endEpoch,
      duration_sec: (frontRes.timeline ?? rearRes.timeline ?? []).reduce((n,s)=>n+s.duration,0),
      timeline: {front:frontRes.timeline ?? [],rear:rearRes.timeline ?? []},
      segment_count: trip.segments.length,
      emer_count: trip.segments.filter((s) => s.isEmergency).length,
      has_front: frontOk,
      has_rear: rearOk,
      peak_gforce: peakG,
      gforce_events: gEvents,
      front_path: frontOk ? frontOut : null,
      rear_path: rearOk ? rearOut : null,
      owner_id: opts.ownerId ?? null,
      owner_username: opts.ownerUsername ?? null,
      device_id: opts.deviceId ?? null,
      device: opts.device ?? null,
    };
    await fs.writeFile(path.join(tripDir, "info.json"), JSON.stringify(info, null, 2));

    yield { stage: "merge", message: `  旅程完成:${tripLabel}`, tripInfo: info };
  }

  yield { stage: "done", message: `全部完成!共處理 ${toProcess.length} 趟旅程` };
}

// ── 合併輔助 ──────────────────────────────────────────────────────────────────

/**
 * 合併單一鏡頭並逐事件回報;合併結果寫入 `result.ok`。
 *
 * 「成功」的定義是 ffmpeg 正常結束「且」輸出檔非空。ffmpeg 在建立輸出檔之後仍可能
 * 失敗或被中斷(例如來源片段損毀/不相容),留下一個 0-byte 檔 —— 舊版僅以
 * `fileExists()` 判斷,會把這種空檔誤記成有效影片,導致旅程在介面上出現卻無法播放。
 */
interface MergeResult {
  timeline?: Span[];
  /** 來源片段數(過濾後實際送入合併的)。0 表示沒有來源。 */
  ok: boolean;
  /** 失敗原因(成功時 undefined)。 */
  error?: string;
  /** 找到的來源段數。 */
  found: number;
  /** 容錯模式下被丟棄的壞段數。 */
  dropped: number;
}

async function* mergeCameraEvents(
  segments: Segment[],
  srcDir: string,
  camera: "F" | "R",
  outPath: string,
  result: MergeResult,
  tolerant: boolean,
): AsyncGenerator<ProgressEvent> {
  const label = camera === "F" ? "前鏡頭" : "後鏡頭";
  let entries: string[] = [];
  const epochs = new Map<string,number>();
  for (const seg of segments) {
    const src = path.join(srcDir, sourceFilename(seg, camera));
    if (await fileExists(src)) { entries.push(src); epochs.set(src,camera === 'R' ? seg.rearEpoch ?? seg.epoch : seg.epoch); }
  }
  result.found = entries.length;
  if (entries.length === 0) {
    result.ok = false;
    result.error = "找不到來源片段";
    yield { stage: "merge", message: `  ${label}:找不到來源片段,略過` };
    return;
  }

  // 容錯模式:先過濾掉 ffprobe 讀不到的壞段,避免一段壞檔拖垮整支合併。以小批併發探測。
  if (tolerant) {
    const good: string[] = [];
    const READ_CONCURRENCY = 4;
    for (let i = 0; i < entries.length; i += READ_CONCURRENCY) {
      const chunk = entries.slice(i, i + READ_CONCURRENCY);
      const oks = await Promise.all(chunk.map((e) => probeReadable(e)));
      chunk.forEach((e, j) => {
        if (oks[j]) good.push(e);
      });
    }
    result.dropped = entries.length - good.length;
    if (result.dropped > 0) {
      yield { stage: "merge", message: `  ${label}:容錯模式丟棄 ${result.dropped} 段壞檔` };
    }
    entries = good;
    if (entries.length === 0) {
      result.ok = false;
      result.error = "所有來源片段皆無法解析";
      yield { stage: "merge", message: `  ${label} 失敗:所有來源片段皆無法解析` };
      return;
    }
  }

  yield { stage: "merge", message: `  ${label} 合併中… (${entries.length} 段)` };
  try {
    let signature: string | undefined;
    for (const entry of entries) {
      const media = await inspectMedia(entry);
      const current = JSON.stringify([media.codec,media.width,media.height,Math.round(media.fps*100),media.audio]);
      if (signature && signature !== current) throw Error('來源的編碼、解析度、幀率或音軌不同，請分批匯入或先轉為一致格式');
      signature = current;
    }
  } catch(error) {
    result.ok=false;result.error=error instanceof Error?error.message:String(error);
    yield {stage:'merge',message:`${label} 無法安全合併：${result.error}`};
    return;
  }
  const r = await concatCopy(entries, outPath);
  const sizeBytes = r.sizeBytes ?? 0;
  if (r.ok && sizeBytes > 0) {
    result.timeline = [];
    let cursor = 0;
    for (const file of entries) {
      const duration = await probeDuration(file);
      result.timeline.push({start:cursor,duration,epoch:epochs.get(file)!});
      cursor += duration;
    }
    result.ok = true;
    yield { stage: "merge", message: `  ${label} 完成 (${(sizeBytes / 1_048_576).toFixed(1)} MB)` };
  } else {
    result.ok = false;
    // 清掉失敗殘留(0-byte 或半成品),避免後續被當成有效影片。
    await fs.rm(outPath, { force: true }).catch(() => {});
    result.error = r.ok ? "輸出為空(0 bytes)" : r.error ?? "未知錯誤";
    yield { stage: "merge", message: `  ${label} 失敗:${result.error}` };
  }
}

function sourceFilename(seg: Segment, camera: "F" | "R"): string {
  return (camera === "F" ? seg.frontFilename : seg.rearFilename) ?? `${seg.base}${camera}.mp4`;
}

function fmtHM(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}
