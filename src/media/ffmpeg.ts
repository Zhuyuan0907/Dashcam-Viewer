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
  return Math.max(1, Math.round(dur));
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
 */
export async function extractFrame(
  videoPath: string,
  outPath: string,
  atSec = 3,
  width = 640,
): Promise<boolean> {
  const r = await run(
    "ffmpeg",
    [
      "-ss", String(atSec),
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", `scale=${width}:-2`,
      "-q:v", "3",
      "-y", outPath,
    ],
    30_000,
  );
  if (r.code !== 0) {
    // 影片可能短於 atSec:退而取第 0 秒再試一次。
    const r2 = await run(
      "ffmpeg",
      ["-ss", "0", "-i", videoPath, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "3", "-y", outPath],
      30_000,
    );
    if (r2.code !== 0) return false;
  }
  try {
    const st = await fs.stat(outPath);
    return st.size > 0;
  } catch {
    return false;
  }
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

export function trimReencode(
  input: string,
  output: string,
  startSec: number,
  durSec: number,
  opts: TrimOptions = {},
): Promise<TrimResult> {
  const { onProgress, threads, signal } = opts;
  const timeoutMs = opts.timeoutMs ?? 60 * 60_000;
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, error: "已取消", aborted: true });
      return;
    }
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
        resolve({ ok: false, error: "裁剪逾時" });
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
      0 === 0 ? 6 * 60 * 60 * 1000 : 0, // 最長 6 小時(大量片段合併可能很久)
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
