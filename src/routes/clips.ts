/**
 * 匯出片段(非破壞性「另存片段」)—— 從旅程目前的播放檔裁切出一段獨立影片,原旅程不動。
 *
 *   POST   /api/trip-clips/*          開始匯出(body { start, end, layout, quality, label?, main? }),背景執行
 *   GET    /api/trip-clip-events/:jobId  SSE 進度(完成時附上新片段資料)
 *   GET    /api/trip-clips/*          列出該趟旅程的片段
 *   GET    /api/trip-clip-download/:clipId  下載片段檔(attachment)
 *   DELETE /api/trip-clip/:clipId     刪除片段(檔案 + DB 列)
 *   POST   /api/trip-clip-cancel/:jobId  取消進行中的匯出
 *
 * 與 routes/edit.ts 的「整趟裁剪」不同:此處產生的是獨立檔(存於 <trip_dir>/clips/),
 * 不覆寫旅程播放檔、不動 trips.orig_*。SSE 以隨機 jobId 命名 → 同一趟可並行多個匯出。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getTrip, canEditTrip, type TripRow } from "../trips/repo.js";
import {
  insertClip,
  getClip,
  listClipsForTrip,
  listClipsForViewer,
  deleteClipRow,
  setClipReport,
  type ClipRow,
  type ClipWithTrip,
  type ClipLayout,
  type ClipQuality,
  type ClipReport,
} from "../clips/repo.js";
import { exportClip, extractFrame } from "../media/ffmpeg.js";
import { sendRange } from "./video.js";
import { withinTrips } from "../util/paths.js";
import { TRIM_THREADS, CLIP_MAX_SEC, CLIP_CONCURRENCY } from "../config.js";
import { makeRequireUser, type AppContext } from "../context.js";
import type { DB } from "../db.js";
import { inspectMedia } from '../media/inspect.js';
import { readTimeline, continuous, timeAt } from '../media/timeline.js';
import { reserveForMedia } from '../media/space.js';

/**
 * 啟動時清理孤兒片段檔(供 server.ts 呼叫):掃描各旅程 <trip_dir>/clips/ 下的檔案,
 * 刪除任何在 trip_clips 表沒有對應列的 .mp4(崩潰/重啟時進行中匯出留下的半成品,無 DB 列
 * 也無清理機制)與其縮圖。回傳刪除的檔案數。
 */
export async function cleanupOrphanClips(db: DB): Promise<number> {
  const dirs = (
    db.prepare("SELECT DISTINCT trip_dir FROM trips WHERE trip_dir IS NOT NULL").all() as Array<{
      trip_dir: string;
    }>
  ).map((r) => r.trip_dir);
  const known = new Set(
    (db.prepare("SELECT file_path FROM trip_clips").all() as Array<{ file_path: string }>).map(
      (r) => r.file_path,
    ),
  );
  let removed = 0;
  for (const dir of dirs) {
    const clipsDir = path.join(dir, "clips");
    if (!withinTrips(clipsDir)) continue;
    let names: string[];
    try {
      names = await fsp.readdir(clipsDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".mp4")) continue;
      const full = path.join(clipsDir, name);
      if (known.has(full)) continue;
      await fsp.rm(full, { force: true }).catch(() => {});
      // 連同同名縮圖一併清掉。
      await fsp
        .rm(path.join(clipsDir, `${path.basename(name, path.extname(name))}.jpg`), { force: true })
        .catch(() => {});
      removed++;
    }
  }
  return removed;
}

/** 已關閉的 SSE channel 保留約 6 分鐘供重連(略長於 registry 的 5 分 TTL);對應的 job→trip 授權資訊也保留這麼久。 */
const AUTH_TTL_MS = 6 * 60_000;

const clipKey = (jobId: string): string => `clip:${jobId}`;

/** 片段縮圖檔路徑:與片段檔同資料夾、同檔名但副檔名改 .jpg(<jobId>.jpg)。 */
function clipThumbPath(filePath: string): string {
  return path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.jpg`);
}

/** 秒 → m:ss(供下載檔名)。 */
function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** 對外揭露的片段欄位(隱藏絕對 file_path)。 */
function publicClip(c: ClipRow): Record<string, unknown> {
  let report: ClipReport = {};
  try {
    const parsed = JSON.parse(c.report_json || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) report = parsed as ClipReport;
  } catch {
    /* 損壞的草稿視為空 */
  }
  return {
    id: c.id,
    label: c.label,
    start_sec: c.start_sec,
    end_sec: c.end_sec,
    layout: c.layout,
    quality: c.quality,
    main_cam: c.main_cam,
    size_bytes: c.size_bytes,
    duration_sec: c.duration_sec,
    created_at: c.created_at,
    report,
    reported_at: c.reported_at,
    source_start_epoch: c.source_start_epoch,
    source_end_epoch: c.source_end_epoch,
    source_version: c.source_version,
  };
}

export function registerClips(app: FastifyInstance, ctx: AppContext): void {
  const { db, sse, jobs } = ctx;
  const requireUser = makeRequireUser(ctx);

  // 進行中的匯出:jobId → AbortController(供取消 / 併發計數)。完成即刪。
  const running = new Map<string, AbortController>();
  // jobId → tripId,供 SSE 授權;完成後仍保留 AUTH_TTL_MS,讓晚到的訂閱者(重播 done)通過授權。
  const jobTrip = new Map<string, string>();

  // ── 開始匯出 ─────────────────────────────────────────────────────────────────
  app.post<{
    Params: { "*": string };
    Body: { start?: number; end?: number; layout?: string; quality?: string; label?: string; main?: string };
  }>("/api/trip-clips/*", { preHandler: requireUser }, async (req, reply) => {
    const tripId = req.params["*"];
    const row = getTrip(db, tripId);
    if (!row) return reply.code(404).send({ detail: "旅程不存在" });
    if (!canEditTrip(db, req.user!, row)) return reply.code(403).send({ detail: "無權編輯此旅程" });

    const start = Number(req.body?.start);
    const end = Number(req.body?.end);
    const baseDur = row.duration_sec; // 從「目前播放檔」裁切(使用者看到的),非 orig。
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > baseDur + 0.5 ||
      end - start < 1
    ) {
      return reply.code(400).send({ detail: "片段範圍無效(需 0 ≤ 起點 < 終點 ≤ 影片長度,且至少 1 秒)" });
    }
    if (end - start > CLIP_MAX_SEC) {
      return reply.code(400).send({ detail: `單一片段最長 ${Math.round(CLIP_MAX_SEC / 60)} 分鐘` });
    }

    const layout = req.body?.layout;
    const quality = req.body?.quality;
    if (layout !== "front" && layout !== "rear" && layout !== "pip") {
      return reply.code(400).send({ detail: "版面須為 front、rear 或 pip" });
    }
    if (quality !== "precise" && quality !== "fast") {
      return reply.code(400).send({ detail: "畫質須為 precise 或 fast" });
    }
    if (layout === "pip" && quality === "fast") {
      return reply.code(400).send({ detail: "子母畫面不支援快速(無損)模式" });
    }

    // 解析來源鏡頭。
    let mainPath: string | null;
    let pipPath: string | null = null;
    let mainCam: string | null = null;
    if (layout === "front") {
      mainPath = row.front_path;
    } else if (layout === "rear") {
      mainPath = row.rear_path;
    } else {
      const main = req.body?.main === "rear" ? "rear" : "front";
      mainCam = main;
      mainPath = main === "rear" ? row.rear_path : row.front_path;
      pipPath = main === "rear" ? row.front_path : row.rear_path;
      if (!pipPath) return reply.code(400).send({ detail: "子母畫面需要前後兩個鏡頭" });
    }
    if (!mainPath) return reply.code(400).send({ detail: "找不到來源鏡頭影片" });
    const timeline = readTimeline(row);
    const spans = layout === 'rear' || (layout === 'pip' && mainCam === 'rear') ? timeline.rear : timeline.front;
    if (!continuous(spans,start,end)) return reply.code(400).send({detail:'選取跨越錄影空檔或超過此鏡頭長度，請分段匯出'});
    if (layout === 'pip' && (!continuous(timeline.front,start,end) || !continuous(timeline.rear,start,end) || Math.abs(timeAt(timeline.front,start)!-timeAt(timeline.rear,start)!)>0.1)) {
      return reply.code(400).send({detail:'此範圍前後鏡頭時間不一致，請使用單鏡頭匯出'});
    }
    if (!withinTrips(mainPath) || (pipPath && !withinTrips(pipPath))) {
      return reply.code(400).send({ detail: "影片路徑不合法" });
    }
    for (const src of [mainPath, pipPath].filter((p): p is string => !!p)) {
      try {
        await fsp.access(src, fs.constants.R_OK);
      } catch {
        return reply.code(400).send({ detail: "來源影片不存在" });
      }
    }

    if (running.size >= 100) {
      return reply.code(429).send({ detail: "匯出佇列已滿,請待其他片段完成後再試" });
    }
    // 整趟裁剪會在完成瞬間 rename 覆蓋播放檔;此時開始的匯出可能讀到新舊混合的位元組。
    if (jobs.hasTrim(tripId)) {
      return reply.code(409).send({ detail: "此旅程正在裁剪中,請待裁剪完成後再匯出片段" });
    }

    // The row was read before async access checks. Recheck after them to reject stale coordinates.
    const current = getTrip(db, tripId);
    if (!current || current.start_epoch !== row.start_epoch || current.duration_sec !== row.duration_sec) {
      return reply.code(409).send({ detail: '影片已更新，請重新載入選取範圍' });
    }
    const label = (typeof req.body?.label === "string" ? req.body.label : "").trim().slice(0, 100);
    const duplicate=ctx.tasks?.findActive({type:'clip',owner:req.user!.id,target:tripId,payload:{start,end,layout,quality,label,main:mainCam}});
    if(duplicate)return {status:'started',job_id:duplicate.channel_key.slice(5)};
    const jobId = startExport({
      row,
      start,
      end,
      layout,
      quality,
      label,
      mainCam,
      mainPath,
      pipPath,
      ownerId: req.user!.id,
    });
    return { status: "started", job_id: jobId };
  });

  // ── SSE 進度 ─────────────────────────────────────────────────────────────────
  app.get<{ Params: { jobId: string } }>(
    "/api/trip-clip-events/:jobId",
    { preHandler: requireUser },
    (req, reply) => {
      const { jobId } = req.params;
      const tripId = jobTrip.get(jobId);
      if (!tripId) {
        reply.code(404).send({ detail: "沒有此匯出工作" });
        return;
      }
      const row = getTrip(db, tripId);
      if (!row || !canEditTrip(db, req.user!, row)) {
        reply.code(404).send({ detail: "沒有此匯出工作" });
        return;
      }
      const channel = sse.get(clipKey(jobId));
      if (!channel) {
        reply.code(404).send({ detail: "沒有此匯出工作" });
        return;
      }
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      // 注意:與整趟裁剪不同,完成事件本身帶 { stage:'done', clip },關閉(null)只結束串流,
      // 不再合成第二個 done(否則前端會收到不含 clip 的空 done)。
      const unsub = channel.subscribe((event) => {
        if (event === null) {
          reply.raw.end();
        } else {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      });
      req.raw.on("close", () => unsub());
      reply.hijack();
    },
  );

  // ── 列出片段 ─────────────────────────────────────────────────────────────────
  app.get<{ Params: { "*": string } }>(
    "/api/trip-clips/*",
    { preHandler: requireUser },
    async (req, reply) => {
      const tripId = req.params["*"];
      const row = getTrip(db, tripId);
      if (!row) return reply.code(404).send({ detail: "旅程不存在" });
      if (!canEditTrip(db, req.user!, row)) return reply.code(403).send({ detail: "無權編輯此旅程" });
      return listClipsForTrip(db, tripId).map(publicClip);
    },
  );

  // ── 列出檢視者可管理的全部片段(片段頁用)──────────────────────────────────────
  app.get("/api/clips", { preHandler: requireUser }, async (req) => {
    return listClipsForViewer(db, req.user!).map((c: ClipWithTrip) => ({
      ...publicClip(c),
      trip_id: c.trip_id,
      date: c.date,
      day_order: c.day_order,
      trip_start_epoch: c.trip_start_epoch,
    }));
  });

  // ── 檢舉資料草稿:儲存車牌/地點/違規事實等,並可標記「已檢舉」──────────────────
  app.put<{
    Params: { clipId: string };
    Body: { plate?: string; location?: string; violation?: string; desc?: string; reported?: boolean };
  }>("/api/trip-clip-report/:clipId", { preHandler: requireUser }, async (req, reply) => {
    const id = Number(req.params.clipId);
    if (!Number.isInteger(id)) return reply.code(404).send({ detail: "片段不存在" });
    const clip = getClip(db, id);
    if (!clip) return reply.code(404).send({ detail: "片段不存在" });
    const row = getTrip(db, clip.trip_id);
    if (!row) return reply.code(404).send({ detail: "片段不存在" });
    if (!canEditTrip(db, req.user!, row)) return reply.code(403).send({ detail: "無權編輯此片段" });

    const body = req.body ?? {};
    const field = (v: unknown, max: number): string =>
      (typeof v === "string" ? v : "").trim().slice(0, max);
    const report: ClipReport = {
      plate: field(body.plate, 20),
      location: field(body.location, 200),
      violation: field(body.violation, 100),
      desc: field(body.desc, 1000),
    };
    // reported 未帶 → 沿用現值;true → 蓋章(保留最早的檢舉時間);false → 清除。
    let reportedAt = clip.reported_at;
    if (typeof body.reported === "boolean") {
      reportedAt = body.reported ? (clip.reported_at ?? Math.floor(Date.now() / 1000)) : null;
    }
    setClipReport(db, id, report, reportedAt);
    return publicClip(getClip(db, id)!);
  });

  // ── 串流片段(inline,支援 Range;供片段頁 <video> 預覽播放)─────────────────────
  app.get<{ Params: { clipId: string } }>(
    "/api/trip-clip-stream/:clipId",
    { preHandler: requireUser },
    async (req, reply) => {
      const id = Number(req.params.clipId);
      if (!Number.isInteger(id)) return reply.code(404).send({ detail: "片段不存在" });
      const clip = getClip(db, id);
      if (!clip) return reply.code(404).send({ detail: "片段不存在" });
      const row = getTrip(db, clip.trip_id);
      if (!row) return reply.code(404).send({ detail: "片段不存在" });
      if (!canEditTrip(db, req.user!, row)) return reply.code(403).send({ detail: "無權存取此片段" });
      if (!withinTrips(clip.file_path)) return reply.code(404).send({ detail: "片段檔案不存在" });
      try {
        await fsp.access(clip.file_path, fs.constants.R_OK);
      } catch {
        return reply.code(404).send({ detail: "片段檔案不存在" });
      }
      return sendRange(req, reply, clip.file_path);
    },
  );

  // ── 片段縮圖:按需以 ffmpeg 從片段檔擷取一格、快取到 <jobId>.jpg,後續直接送快取 ──────
  app.get<{ Params: { clipId: string } }>(
    "/api/trip-clip-thumb/:clipId",
    { preHandler: requireUser },
    async (req, reply) => {
      const id = Number(req.params.clipId);
      if (!Number.isInteger(id)) return reply.code(404).send({ detail: "片段不存在" });
      const clip = getClip(db, id);
      if (!clip) return reply.code(404).send({ detail: "片段不存在" });
      const row = getTrip(db, clip.trip_id);
      if (!row) return reply.code(404).send({ detail: "片段不存在" });
      if (!canEditTrip(db, req.user!, row)) return reply.code(403).send({ detail: "無權存取此片段" });
      if (!withinTrips(clip.file_path)) return reply.code(404).send({ detail: "片段檔案不存在" });

      const thumbPath = clipThumbPath(clip.file_path);
      let ready = false;
      try {
        await fsp.access(thumbPath, fs.constants.R_OK);
        ready = true;
      } catch {
        try {
          if ((await fsp.stat(clip.file_path)).size > 0) {
            // 短片段可能短於預設 3 秒:取中點(上限 1 秒),extractFrame 自身也會退回第 0 秒。
            const at = Math.min(1, Math.max(0, clip.duration_sec / 2));
            ready = await extractFrame(clip.file_path, thumbPath, at);
          }
        } catch {
          ready = false;
        }
      }
      if (!ready) return reply.code(404).send({ detail: "無法產生縮圖" });

      let size: number;
      try {
        ({ size } = await fsp.stat(thumbPath));
      } catch {
        return reply.code(404).send({ detail: "縮圖不存在" });
      }
      reply
        .header("Content-Type", "image/jpeg")
        .header("Cache-Control", "public, max-age=86400")
        .header("Content-Length", String(size));
      return reply.send(createReadStream(thumbPath));
    },
  );

  // ── 下載片段 ─────────────────────────────────────────────────────────────────
  app.get<{ Params: { clipId: string } }>(
    "/api/trip-clip-download/:clipId",
    { preHandler: requireUser },
    async (req, reply) => {
      const id = Number(req.params.clipId);
      if (!Number.isInteger(id)) return reply.code(404).send({ detail: "片段不存在" });
      const clip = getClip(db, id);
      if (!clip) return reply.code(404).send({ detail: "片段不存在" });
      const row = getTrip(db, clip.trip_id);
      if (!row) return reply.code(404).send({ detail: "片段不存在" });
      if (!canEditTrip(db, req.user!, row)) return reply.code(403).send({ detail: "無權存取此片段" });
      if (!withinTrips(clip.file_path)) return reply.code(404).send({ detail: "片段檔案不存在" });
      let size: number;
      try {
        size = (await fsp.stat(clip.file_path)).size;
      } catch {
        return reply.code(404).send({ detail: "片段檔案不存在" });
      }
      const stem = clip.label || `${row.date}_第${row.day_order}趟_${clip.layout}_${mmss(clip.start_sec)}-${mmss(clip.end_sec)}`;
      const fname = `${stem}.mp4`;
      reply
        .header("Content-Type", "video/mp4")
        .header("Content-Length", String(size))
        .header(
          "Content-Disposition",
          `attachment; filename="clip_${clip.id}.mp4"; filename*=UTF-8''${encodeURIComponent(fname)}`,
        );
      return reply.send(createReadStream(clip.file_path));
    },
  );

  // ── 刪除片段 ─────────────────────────────────────────────────────────────────
  app.delete<{ Params: { clipId: string } }>(
    "/api/trip-clip/:clipId",
    { preHandler: requireUser },
    async (req, reply) => {
      const id = Number(req.params.clipId);
      if (!Number.isInteger(id)) return reply.code(404).send({ detail: "片段不存在" });
      const clip = getClip(db, id);
      if (!clip) return reply.code(404).send({ detail: "片段不存在" });
      const row = getTrip(db, clip.trip_id);
      if (!row) return reply.code(404).send({ detail: "片段不存在" });
      if (!canEditTrip(db, req.user!, row)) return reply.code(403).send({ detail: "無權刪除此片段" });
      if (withinTrips(clip.file_path)) {
        await fsp.rm(clip.file_path, { force: true }).catch(() => {});
        await fsp.rm(clipThumbPath(clip.file_path), { force: true }).catch(() => {});
      }
      deleteClipRow(db, id);
      return { status: "ok" };
    },
  );

  // ── 取消匯出 ─────────────────────────────────────────────────────────────────
  app.post<{ Params: { jobId: string } }>(
    "/api/trip-clip-cancel/:jobId",
    { preHandler: requireUser },
    async (req, reply) => {
      const { jobId } = req.params;
      const tripId = jobTrip.get(jobId);
      if (!tripId) return reply.code(404).send({ detail: "沒有進行中的匯出" });
      const row = getTrip(db, tripId);
      if (!row) return reply.code(404).send({ detail: "沒有進行中的匯出" });
      if (!canEditTrip(db, req.user!, row)) return reply.code(403).send({ detail: "無權操作此匯出" });
      const controller = running.get(jobId);
      if (!controller) return reply.code(404).send({ detail: "沒有進行中的匯出" });
      controller.abort();
      return { status: "ok" };
    },
  );

  /**
   * 背景匯出:以 exportClip 產生片段檔到 <trip_dir>/clips/<jobId>.mp4,進度經 SSE 推播;
   * 成功則寫入 trip_clips 並把新片段附在 done 事件回傳;失敗/取消清掉半成品。
   */
  function startExport(p: {
    row: TripRow;
    start: number;
    end: number;
    layout: ClipLayout;
    quality: ClipQuality;
    label: string;
    mainCam: string | null;
    mainPath: string;
    pipPath: string | null;
    ownerId: number;
  }): string {
    const jobId = randomUUID();
    const controller = new AbortController();
    running.set(jobId, controller);
    jobTrip.set(jobId, p.row.trip_id);
    // 同時登記到共用 registry,讓「刪除旅程」能中止這趟所有進行中的匯出(avoid ffmpeg 對已刪檔空轉)。
    jobs.registerClip(jobId, p.row.trip_id, controller);
    const channel = sse.create(clipKey(jobId));

    const baseDir = p.row.trip_dir ?? path.dirname(p.mainPath);
    const clipsDir = path.join(baseDir, "clips");
    const outPath = path.join(clipsDir, `${jobId}.mp4`);
    const dur = p.end - p.start;

    if (ctx.tasks) ctx.tasks.enqueue({type:'clip',owner:p.ownerId,target:p.row.trip_id,payload:{start:p.start,end:p.end,layout:p.layout,quality:p.quality,label:p.label,main:p.mainCam},key:clipKey(jobId)},channel,run,()=>{controller.abort();return true;});
    else void run();
    return jobId;

    async function run(): Promise<void> {
      let release=()=>{};
      try {
        controller.signal.throwIfAborted();
        release=await reserveForMedia([p.mainPath,...(p.pipPath?[p.pipPath]:[])],2);
        await fsp.mkdir(clipsDir, { recursive: true });
        channel.push({ stage: "encode", done: 0, total: 100, message: "匯出中… 0%" });
        const r = await exportClip({
          mainInput: p.mainPath,
          pipInput: p.pipPath,
          output: outPath,
          startSec: p.start,
          durSec: dur,
          layout: p.layout,
          quality: p.quality,
          threads: TRIM_THREADS,
          signal: controller.signal,
          onProgress: (f) => {
            const pct = Math.round(f * 100);
            // 多帶目前處理到的秒數與來源起點,前端可顯示時間碼(缺欄位時退回百分比)。
            channel.push({
              stage: "encode",
              done: pct,
              total: 100,
              cur: f * dur,
              dur,
              start: p.start,
              message: `匯出中… ${pct}%`,
            });
          },
        });
        if (!r.ok) throw new Error(r.error || "ffmpeg 失敗");

        let size = 0;
        try {
          size = (await fsp.stat(outPath)).size;
        } catch {
          throw new Error("輸出檔遺失");
        }
        const actual = await inspectMedia(outPath);
        controller.signal.throwIfAborted();
        if (size <= 0) throw new Error('輸出檔案為空');
        const clip = insertClip(db, {
          trip_id: p.row.trip_id,
          owner_id: p.ownerId,
          label: p.label,
          start_sec: p.start,
          end_sec: p.end,
          layout: p.layout,
          quality: p.quality,
          main_cam: p.layout === "pip" ? p.mainCam : null,
          file_path: outPath,
          size_bytes: size,
          duration_sec: actual.duration,
          source_start_epoch: timeAt(readTimeline(p.row)[p.layout === 'rear' || p.mainCam === 'rear' ? 'rear' : 'front'],p.start),
          source_end_epoch: timeAt(readTimeline(p.row)[p.layout === 'rear' || p.mainCam === 'rear' ? 'rear' : 'front'],p.end),
          source_version: `${p.row.start_epoch}:${p.row.duration_sec}`,
        });
        channel.push({ stage: "done", message: "匯出完成", clip: publicClip(clip) });
      } catch (err) {
        const cancelled = controller.signal.aborted;
        await fsp.rm(outPath, { force: true }).catch(() => {});
        channel.push({
          stage: cancelled ? "cancelled" : "error",
          message: cancelled ? "已取消匯出" : err instanceof Error ? err.message : String(err),
        });
      } finally {
        release();
        running.delete(jobId);
        jobs.unregisterClip(jobId);
        channel.close();
        // 授權資訊延後清除,讓完成後短時間內(重播 done)仍能通過 SSE 授權。
        setTimeout(() => jobTrip.delete(jobId), AUTH_TTL_MS).unref?.();
      }
    }
  }
}
