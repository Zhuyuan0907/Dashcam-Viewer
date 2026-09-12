/**
 * ffmpeg / ffprobe 包裝 — 全部非阻塞(spawn + Promise)。
 *
 * 舊 Python 版的致命缺陷之一:get_video_duration() 用同步 subprocess.run,
 * 卻在 async 流程裡直接呼叫,處理影片時會凍住整個 event loop。
 * 這裡一律走 spawn,絕不阻塞;且永遠用陣列參數,不經 shell(避免命令注入)。
 */
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

export const FALLBACK_DURATION = 120; // 無法取得時長時的預設秒數

// 縮圖暫存檔的程序內唯一序號,避免同一輸出路徑的併發產生互相覆蓋暫存檔。
let thumbTmpSeq = 0;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGKILL");
        resolve({ code: null, stdout, stderr });
      }
    }, timeoutMs);

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: stderr || "spawn error" });
      }
    });
    proc.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      }
    });
  });
}

/** 取得影片時長(秒);失敗回 FALLBACK_DURATION。 */
export async function probeDuration(file: string): Promise<number> {
  const r = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
    30_000,
  );
  if (r.code !== 0) return FALLBACK_DURATION;
  const dur = Number.parseFloat(r.stdout.trim());
  if (!Number.isFinite(dur)) return FALLBACK_DURATION;
  return Math.max(0.001, dur);
}

/**
 * 判斷影片是否可被 ffprobe 正常解析(有有效時長)。用於容錯合併:
 * 在 concat 前過濾掉損毀/不可讀的片段(否則 concat -c copy 遇到第一段壞檔會整個失敗)。
 */
export async function probeReadable(file: string): Promise<boolean> {
  const r = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
    30_000,
  );
  if (r.code !== 0) return false;
  return Number.isFinite(Number.parseFloat(r.stdout.trim()));
}

/**
 * 從影片擷取單一畫格為縮圖(JPEG)。預設取第 atSec 秒(避開開頭黑畫面)。
 * 用 input seeking(-ss 在 -i 前)以求快速。成功回 true。
 *
 * 原子寫入:先寫唯一暫存檔,完成且非空才 rename 到最終路徑。避免併發的讀取端把
 * ffmpeg 正在寫入一半的縮圖當成已完成快取送出(且以 24 小時 Cache-Control 快取)。
 */
export async function extractFrame(
  videoPath: string,
  outPath: string,
  atSec = 3,
  width = 640,
): Promise<boolean> {
  // 暫存檔名帶 pid + 程序內唯一序號,確保同一輸出路徑的併發產生各寫各的暫存檔。
  const tmp = `${outPath}.tmp.${process.pid}.${thumbTmpSeq++}.jpg`;
  const args = (ss: string): string[] => [
    "-ss", ss,
    "-i", videoPath,
    "-frames:v", "1",
    "-vf", `scale=${width}:-2`,
    "-q:v", "3",
    "-y", tmp,
  ];
  let r = await run("ffmpeg", args(String(atSec)), 30_000);
  if (r.code !== 0) {
    // 影片可能短於 atSec:退而取第 0 秒再試一次。
    r = await run("ffmpeg", args("0"), 30_000);
  }
  try {
    if (r.code === 0 && (await fs.stat(tmp)).size > 0) {
      await fs.rename(tmp, outPath); // 原子替換:讀取端只會看到完整檔
      return true;
    }
  } catch {
    /* 落到清理 */
  }
  await fs.rm(tmp, { force: true }).catch(() => {});
  return false;
}

export interface TrimResult {
  ok: boolean;
  error?: string;
  /** 是否因取消(abort)而結束。 */
  aborted?: boolean;
}

/**
 * 精確裁剪並重編碼一段影片。`-ss` 在 `-i` 前 + 重編碼 → 切點精準到幀。
 * 監聽 stderr 的 `time=HH:MM:SS.xx` 回報進度(0..1)。
 * @param startSec 起點秒數(相對原片)
 * @param durSec   輸出長度秒數
 */
export interface TrimOptions {
  onProgress?: (frac: number) => void;
  /** ffmpeg 執行緒上限;0/undefined = 不指定(交給 ffmpeg)。 */
  threads?: number;
  /** 取消訊號:abort 時送 SIGKILL 結束 ffmpeg(promise 以 ok:false 回覆)。 */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * 執行一段以 stderr 的 `time=HH:MM:SS.xx` 回報進度的 ffmpeg 工作 —— 重編碼裁剪、
 * 片段匯出(含無損 remux)共用此骨架。`args` 由呼叫端組好(不經 shell、純陣列參數)。
 * @param durSec 用來把 `time=` 換算成進度(0..1)的輸出長度;≤0 則不回報進度。
 */
function spawnFfmpegWithProgress(
  args: string[],
  durSec: number,
  opts: TrimOptions = {},
): Promise<TrimResult> {
  const { onProgress, signal } = opts;
  // 預設逾時隨輸出長度縮放(至少 1 小時,另給每輸出秒 6 秒的重編碼餘裕):
  // 低速機器上長趟裁剪的實際耗時可能超過固定 1 小時,固定值會讓長趟「必定失敗」。
  const timeoutMs = opts.timeoutMs ?? Math.max(60 * 60_000, durSec * 6_000);
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, error: "已取消", aborted: true });
      return;
    }
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    let aborted = false;

    // 降低 ffmpeg 優先權,避免壓垮串流/其他請求(失敗不致命)。
    try {
      if (proc.pid) os.setPriority(proc.pid, 15);
    } catch {
      /* 權限不足或平台不支援 → 略過 */
    }

    const onAbort = (): void => {
      aborted = true;
      proc.kill("SIGKILL");
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (signal) signal.removeEventListener("abort", onAbort);
        proc.kill("SIGKILL");
        resolve({ ok: false, error: "處理逾時" });
      }
    }, timeoutMs);
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
      if (onProgress && durSec > 0) {
        const ms = [...s.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
        const last = ms[ms.length - 1];
        if (last) {
          const t = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number.parseFloat(last[3]!);
          onProgress(Math.max(0, Math.min(1, t / durSec)));
        }
      }
    });
    proc.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve({ ok: false, error: aborted ? "已取消" : stderr || "spawn error", aborted });
      }
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (aborted) return resolve({ ok: false, error: "已取消", aborted: true });
      if (code === 0) return resolve({ ok: true });
      const lines = stderr.trim().split("\n").filter(Boolean);
      resolve({ ok: false, error: lines[lines.length - 1] ?? "未知錯誤" });
    });
  });
}

export function trimReencode(
  input: string,
  output: string,
  startSec: number,
  durSec: number,
  opts: TrimOptions = {},
): Promise<TrimResult> {
  const { threads } = opts;
  const args = [
    "-y",
    "-ss", String(startSec),
    "-i", input,
    "-t", String(durSec),
    ...(threads && threads > 0 ? ["-threads", String(threads)] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac",
    "-movflags", "+faststart",
    output,
  ];
  return spawnFfmpegWithProgress(args, durSec, opts);
}

// ── 匯出片段(非破壞性另存) ─────────────────────────────────────────────────────
export type ClipLayout = "front" | "rear" | "pip";
export type ClipQuality = "precise" | "fast";

export interface ClipArgsSpec {
  /** 主畫面來源(單鏡頭即該鏡頭;pip 為主畫面鏡頭)。 */
  mainInput: string;
  /** pip 的第二路(疊在右上的小窗);單鏡頭不用。 */
  pipInput?: string | null;
  output: string;
  startSec: number;
  durSec: number;
  layout: ClipLayout;
  quality: ClipQuality;
  /** ffmpeg 執行緒上限;0/undefined = 交給 ffmpeg。 */
  threads?: number;
}

/**
 * 組出「匯出片段」的 ffmpeg 參數陣列(純函式、無 I/O → 便於單元測試)。
 *  - fast 單鏡頭:`-c copy` 無損 remux(快;但只能切在關鍵幀 → 起點近似)
 *  - precise 單鏡頭:libx264 重編碼(幀準,與 trimReencode 相同)
 *  - pip 子母畫面:雙輸入 overlay 重編碼(主畫面滿版 + 另一鏡頭縮到右上角小窗)
 *
 * `-ss` 一律放在對應 `-i` 之前:單鏡頭求快速 seek;pip 兩路以「相同來源時間」對齊 → 同步。
 * pip 疊圖用 `scale='trunc(iw/6)*2':-2` 縮到約 1/3 寬且長寬皆偶數(libx264 yuv420p 要求),
 * `overlay=W-w-24:24` 內縮 24px 貼右上(與觀看台 PiP 一致),尾接 `format=yuv420p` 保證可播。
 */
export function buildClipArgs(p: ClipArgsSpec): string[] {
  const S = String(p.startSec);
  const D = String(p.durSec);
  const T = p.threads && p.threads > 0 ? ["-threads", String(p.threads)] : [];

  if (p.layout === "pip") {
    if (!p.pipInput) throw new Error("pip 版面需要第二路輸入(pipInput)");
    if (p.quality === "fast") throw new Error("pip 版面不支援快速(無損)模式");
    return [
      "-y",
      "-ss", S, "-i", p.mainInput,
      "-ss", S, "-i", p.pipInput,
      "-t", D,
      ...T,
      "-filter_complex",
      "[1:v]scale='trunc(iw/6)*2':-2[p];[0:v][p]overlay=W-w-24:24,format=yuv420p[v]",
      "-map", "[v]", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac",
      "-movflags", "+faststart",
      p.output,
    ];
  }

  if (p.quality === "fast") {
    // -c copy 的輸入端 -ss 會退到「≤ 起點的關鍵幀」開始複製;若 -t 仍用選取長度,
    // 退幾秒就會在**結尾**少幾秒(使用者要的最後片刻被切掉)。把 -t 補一段 GOP 餘裕,
    // 保證輸出完整涵蓋選取區間 —— 代價是頭尾多帶少許畫面(對檢舉佐證反而是加分)。
    const FAST_TAIL_PAD_SEC = 5;
    return [
      "-y",
      "-ss", S, "-i", p.mainInput,
      "-t", String(p.durSec + FAST_TAIL_PAD_SEC),
      "-c", "copy",
      "-movflags", "+faststart",
      p.output,
    ];
  }

  return [
    "-y",
    "-ss", S, "-i", p.mainInput,
    "-t", D,
    ...T,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac",
    "-movflags", "+faststart",
    p.output,
  ];
}

/** 依 buildClipArgs 產生片段;進度/取消/逾時沿用共用骨架。 */
export function exportClip(p: ClipArgsSpec & TrimOptions): Promise<TrimResult> {
  const args = buildClipArgs(p);
  return spawnFfmpegWithProgress(args, p.durSec, p);
}

export interface ConcatResult {
  ok: boolean;
  error?: string;
  sizeBytes?: number;
}

/**
 * 用 ffmpeg concat demuxer 把多支影片無損串接(-c copy)。
 * @param sources 來源檔絕對路徑(已存在者)
 * @param outPath 輸出檔
 */
export async function concatCopy(sources: string[], outPath: string): Promise<ConcatResult> {
  if (sources.length === 0) return { ok: false, error: "no sources" };

  // concat 清單:每行 file '<path>'。單引號需跳脫成 '\'' 以免破壞語法。
  const listPath = path.join(path.dirname(outPath), `_concat_${path.basename(outPath)}.txt`);
  const listBody = sources.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  await fs.writeFile(listPath, listBody, "utf-8");

  try {
    const r = await run(
      "ffmpeg",
      ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath],
      6 * 60 * 60 * 1000, // 逾時上限 6 小時(大量片段合併可能很久)
    );
    await fs.rm(listPath, { force: true });

    if (r.code === 0) {
      try {
        const st = await fs.stat(outPath);
        return { ok: true, sizeBytes: st.size };
      } catch {
        return { ok: false, error: "output missing" };
      }
    }
    const lines = r.stderr.trim().split("\n").filter(Boolean);
    return { ok: false, error: lines[lines.length - 1] ?? "未知錯誤" };
  } catch (e) {
    await fs.rm(listPath, { force: true }).catch(() => {});
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
