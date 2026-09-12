/**
 * 旅程影片編輯:精確裁剪(重編碼、背景 + SSE 進度)與還原(擁有者或管理員)。
 *
 *   POST   /api/trip-trim/*          開始裁剪(body { start, end } 秒),背景執行
 *   GET    /api/trip-trim-events/*   SSE 進度(events 用獨立前綴,因 wildcard 後不可再接靜態段)
 *   DELETE /api/trip-trim/*          還原原始影片(從 .orig.mp4 復原)
 *
 * 裁剪一律以「原始檔備份」`前鏡頭.orig.mp4` / `後鏡頭.orig.mp4` 為來源,可重複裁剪與還原。
 * 前後鏡頭以相同起訖點裁剪以保持同步。
 *
 * 崩潰安全 + 原子性(修正三個缺陷):
 *   1. 首次裁剪以 **copy**(非 rename)建立 .orig 備份 → 播放檔全程存在,程序中途崩潰不會 404。
 *   2. 兩鏡頭「全部先編碼到 .trim.tmp、全部成功後才逐一覆蓋播放檔」→ 任一鏡頭失敗不動任何
 *      播放檔(前後鏡頭不會失步)。
 *   3. 重複裁剪的來源座標換算:前端送的是「目前播放檔」秒數,需換算成 .orig 的秒數再裁切。
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  getTrip,
  canEditTrip,
  applyTrim,
  clearTrim,
  type TripRow,
} from "../trips/repo.js";
import { trimReencode } from "../media/ffmpeg.js";
import { TRIM_THREADS } from "../config.js";
import { pathExists as exists } from "../util/fsx.js";
import { makeRequireUser, type AppContext } from "../context.js";
import type { DB } from "../db.js";
import { commitMedia, recoverMediaCommits } from '../media/commit.js';
import { inspectMedia } from '../media/inspect.js';
import { readTimeline, continuous, timeAt } from '../media/timeline.js';

/** 前鏡頭.mp4 → 前鏡頭.orig.mp4(同目錄的原始備份路徑)。 */
function origPath(p: string): string {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  return path.join(dir, `${base}.orig${ext}`);
}

/** 前鏡頭.mp4 → 前鏡頭.trim.tmp.mp4(裁剪暫存輸出)。 */
function tmpPath(p: string): string {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  return path.join(dir, `${base}.trim.tmp${ext}`);
}

/**
 * 由「目前播放檔座標」的選取區間算出對 .orig 的裁切計畫。(純函式,便於單元測試。)
 *
 * 目前播放檔 = 上一次裁剪後的較短影片,其 t=0 對應 .orig 的第
 * `(start_epoch - orig_start_epoch)` 秒(先前已從前面剪掉的秒數)。因此:
 *   srcStart(對 .orig 的起點)= 先前已剪掉的秒數 + 本次 start
 *   新的起始 epoch = 目前 start_epoch + 本次 start
 */
export interface TrimPlan {
  srcStart: number; // 對 .orig 的裁切起點(秒)
  dur: number; // 裁切長度(秒)
  newStart: number; // 新的 start_epoch
  newEnd: number; // 新的 end_epoch
  newDur: number; // 新的 duration_sec(整數)
  prevStart: number; // 裁剪前(目前)的 start_epoch,供 COALESCE 保留原始值
  prevEnd: number;
  prevDur: number;
}

export function computeTrimPlan(
  row: Pick<TripRow, "start_epoch" | "end_epoch" | "duration_sec" | "orig_start_epoch" | "trim_offset_sec">,
  start: number,
  end: number,
): TrimPlan {
  const origBase = row.orig_start_epoch ?? row.start_epoch;
  const alreadyTrimmedOff = row.trim_offset_sec ?? row.start_epoch - origBase;
  const srcStart = alreadyTrimmedOff + start;
  const dur = end - start;
  const newStart = row.start_epoch + start;
  const newDur = dur;
  return {
    srcStart,
    dur,
    newStart,
    newEnd: newStart + newDur,
    newDur,
    prevStart: row.start_epoch,
    prevEnd: row.end_epoch,
    prevDur: row.duration_sec,
  };
}

/**
 * 啟動時的裁剪殘留修復(供 server.ts 呼叫):
 *   - 刪掉任何 .trim.tmp(中斷的半成品編碼)。
 *   - 若播放檔遺失但 .orig 仍在(舊版行為或極短的提交視窗崩潰),以 .orig 複本還原播放檔,
 *     避免旅程永久 404。
 * 回傳修復的檔案數。
 */
export async function recoverInterruptedTrims(db: DB): Promise<number> {
  await recoverMediaCommits(db);
  const rows = db.prepare(
    "SELECT front_path, rear_path, orig_duration_sec FROM trips",
  ).all() as Array<{
    front_path: string | null;
    rear_path: string | null;
    orig_duration_sec: number | null;
  }>;
  let fixed = 0;
  for (const r of rows) {
    for (const p of [r.front_path, r.rear_path]) {
      if (!p) continue;
      const tmp = tmpPath(p);
      if (await exists(tmp)) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        fixed++;
      }
      const orig = origPath(p);
      if (!(await exists(orig))) continue;
      if (!(await exists(p))) {
        // 播放檔遺失但 .orig 仍在(極短提交視窗崩潰)→ 以 .orig 復原,避免旅程 404。
        await fsp.copyFile(orig, p).catch(() => {});
        fixed++;
      } else if (r.orig_duration_sec === null) {
        // DB 記為「未裁剪」卻存在 .orig:首次裁剪中途崩潰的殘留。可能已有部分鏡頭被
        // rename 成裁剪後內容(檔案與 DB 座標不一致),把 .orig 還原回播放檔即回到
        // 一致的未裁剪狀態;同時清掉孤兒備份(最多可佔一倍趟容量的隱形磁碟殘留)。
        await fsp.rename(orig, p).catch(() => {});
        fixed++;
      }
    }
  }
  return fixed;
}

export function registerEdit(app: FastifyInstance, ctx: AppContext): void {
  const { db, sse, jobs } = ctx;
  const requireUser = makeRequireUser(ctx);
  const trimKey = (id: string): string => `trim:${id}`;

  app.post<{ Params: { "*": string }; Body: { start?: number; end?: number } }>(
    "/api/trip-trim/*",
    { preHandler: requireUser },
    async (req, reply) => {
      const tripId = req.params["*"];
      const row = getTrip(db, tripId);
      if (!row) return reply.code(404).send({ detail: "旅程不存在" });
      if (!canEditTrip(db, req.user!, row)) return reply.code(403).send({ detail: "無權編輯此旅程" });

      const start = Number(req.body?.start);
      const end = Number(req.body?.end);
      // 範圍以「目前播放檔」長度(duration_sec)為準 —— 前端選取的是使用者看到的檔;
      // 用 orig_duration_sec 會允許超出目前檔長度、對 .orig 換算後越界。
      const baseDur = row.duration_sec;
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end <= start ||
        end > baseDur + 0.5 ||
        end - start < 1
      ) {
        return reply.code(400).send({ detail: "裁剪範圍無效(需 0 ≤ 起點 < 終點 ≤ 影片長度,且至少 1 秒)" });
      }
      // 以「實際進行中」判斷(jobs registry),而非 SSE channel 是否存在 —— 已完成的 channel
      // 會保留數分鐘供重連,用 sse.has 會把「剛裁完」誤判為「裁剪中」而擋下再次裁剪/還原。
      if (jobs.busy(tripId)) {
        return reply.code(409).send({ detail: "此旅程正在裁剪中,請稍候" });
      }
      const timeline = readTimeline(row);
      const available = [timeline.front,timeline.rear].filter(s => s.length);
      if (available.some(s => !continuous(s,start,end)) || available.some(s => Math.abs(timeAt(s,start)!-timeAt(available[0]!,start)!)>0.1)) {
        return reply.code(400).send({detail:'選取包含錄影空檔或鏡頭時間差，請先匯出單鏡頭片段'});
      }
      startTrim(row, start, end, req.user!.id);
      return { status: "started", trip_id: tripId };
    },
  );

  app.get<{ Params: { "*": string } }>(
    "/api/trip-trim-events/*",
    { preHandler: requireUser },
    (req, reply) => {
      const tripId = req.params["*"];
      const row = getTrip(db, tripId);
      if (!row || !canEditTrip(db, req.user!, row)) {
        reply.code(404).send({ detail: "旅程不存在" });
        return;
      }
      const channel = sse.get(trimKey(tripId));
      if (!channel) {
        reply.code(404).send({ detail: "沒有進行中的裁剪" });
        return;
      }
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
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

  app.delete<{ Params: { "*": string } }>(
    "/api/trip-trim/*",
    { preHandler: requireUser },
    async (req, reply) => {
      const tripId = req.params["*"];
      const row = getTrip(db, tripId);
      if (!row) return reply.code(404).send({ detail: "旅程不存在" });
      if (!canEditTrip(db, req.user!, row)) return reply.code(403).send({ detail: "無權編輯此旅程" });
      if (row.orig_duration_sec === null) return reply.code(400).send({ detail: "此旅程尚未裁剪" });
      if (jobs.busy(tripId)) return reply.code(409).send({ detail: "此旅程仍有工作進行中" });
      const controller = new AbortController();
      jobs.registerTrim(tripId, controller);
      const channel=sse.create(`restore:${tripId}`,req.user!.id);
      const restore=async()=>{try {
        const cams = [row.front_path, row.rear_path].filter((p): p is string => !!p);
        for (const p of cams) await inspectMedia(origPath(p));
        for (const p of cams) await fsp.copyFile(origPath(p), tmpPath(p));
        controller.signal.throwIfAborted();
        jobs.beginCommit(tripId);
        await commitMedia(db, tripId, cams.map(p => ({ target:p, staged:tmpPath(p) })), () => clearTrim(db, tripId, {
        start: row.orig_start_epoch ?? row.start_epoch,
        end: row.orig_end_epoch ?? row.end_epoch,
        dur: row.orig_duration_sec ?? row.duration_sec,
        }));
        channel.push({stage:'done',message:'還原完成'});
      } catch (error) {
        channel.push({stage:'error',message:'還原未完成，原始備份已保留'});
        throw error;
      } finally { jobs.unregisterTrim(tripId);channel.close(); }};
      try {
        if(ctx.tasks) await new Promise<void>((resolve,reject)=>{
          ctx.tasks!.enqueue({type:'restore',owner:req.user!.id,target:tripId,payload:{},key:`restore:${tripId}`},channel,async()=>{try{await restore();resolve();}catch(e){reject(e);throw e;}},()=>jobs.abortTrim(tripId),()=>jobs.isCommitting(tripId));
        }); else await restore();
      } catch(error) {return reply.code(409).send({detail:`還原未完成，備份已保留：${error instanceof Error?error.message:error}`});}
      if (row.trip_dir) await fsp.rm(path.join(row.trip_dir, "thumb.jpg"), { force: true }).catch(() => {});
      return { status: "ok" };
    },
  );

  // 取消進行中的裁剪(擁有者或管理員)。abort → kill ffmpeg → 背景流程做完整 rollback。
  app.post<{ Params: { "*": string } }>(
    "/api/trip-trim-cancel/*",
    { preHandler: requireUser },
    async (req, reply) => {
      const tripId = req.params["*"];
      const row = getTrip(db, tripId);
      if (!row) return reply.code(404).send({ detail: "旅程不存在" });
      if (!canEditTrip(db, req.user!, row)) return reply.code(403).send({ detail: "無權編輯此旅程" });
      // 只中止裁剪本身;同趟並行的「匯出片段」工作不受影響(abortTripJobs 會連坐,僅供刪除旅程用)。
      if (!jobs.abortTrim(tripId)) return reply.code(404).send({ detail: "沒有進行中的裁剪" });
      return { status: "ok" };
    },
  );

  /**
   * 背景裁剪:兩鏡頭皆以 .orig 為來源、以「換算後座標」重編碼到 .trim.tmp;全部成功後才逐一
   * 覆蓋播放檔並更新 DB。任一失敗/取消:只清 .trim.tmp(播放檔全程未動);首次裁剪失敗再刪掉
   * 剛建立的 .orig 備份(回到未裁剪)。
   */
  function startTrim(row: TripRow, start: number, end: number, actor: number): void {
    const controller = new AbortController();
    jobs.registerTrim(row.trip_id, controller);
    const channel = sse.create(trimKey(row.trip_id));
    const wasFirstTrim = row.orig_duration_sec === null;
    if (ctx.tasks) ctx.tasks.enqueue({type:'trim',owner:actor,target:row.trip_id,payload:{start,end},key:trimKey(row.trip_id)},channel,run,()=>jobs.abortTrim(row.trip_id),()=>jobs.isCommitting(row.trip_id));
    else void run();

    async function run(): Promise<void> {
      const cams = [row.front_path, row.rear_path].filter((p): p is string => !!p);
      const plan = computeTrimPlan(row, start, end);
      const timeline = readTimeline(row);
      plan.newStart = timeAt(timeline.front.length ? timeline.front : timeline.rear,start) ?? plan.newStart;
      plan.newEnd = plan.newStart + plan.dur;
      const prog: Record<string, number> = {};
      const emit = (): void => {
        const total = cams.reduce((a, p) => a + (prog[p] ?? 0), 0);
        const pct = Math.round((total / cams.length) * 100);
        channel.push({ stage: "encode", done: pct, total: 100, message: `裁剪中… ${pct}%` });
      };
      try {
        // 1) 確保每個鏡頭都有 .orig 備份(首次裁剪用 copy,不動播放檔 → 崩潰不 404)。
        for (const p of cams) {
          const orig = origPath(p);
          if (!(await exists(orig))) await fsp.copyFile(p, orig);
        }
        // 2) 全部鏡頭先編碼到 .trim.tmp(以 .orig 為來源、換算後的 srcStart);任一失敗即中止,
        //    此時播放檔尚未被任何覆蓋 → 前後鏡頭不會失步。
        for (const p of cams) {
          const r = await trimReencode(origPath(p), tmpPath(p), plan.srcStart, plan.dur, {
            onProgress: (f) => {
              prog[p] = f;
              emit();
            },
            threads: TRIM_THREADS,
            signal: controller.signal,
          });
          if (!r.ok) throw new Error(r.error || "ffmpeg 失敗");
          const media = await inspectMedia(tmpPath(p));
          if (Math.abs(media.duration - plan.dur) > Math.max(0.25, 2 / media.fps)) throw new Error('裁剪結果長度與選取不符');
          prog[p] = 1;
          emit();
        }
        // 3) 全部成功 → 逐鏡頭以 tmp 覆蓋播放檔(連續 rename,窗口極小且不會出現遺失檔)。
        controller.signal.throwIfAborted();
        jobs.beginCommit(row.trip_id);
        await commitMedia(db, row.trip_id, cams.map(p => ({ target:p, staged:tmpPath(p) })), () => applyTrim(db, row.trip_id, {
          prevStart: plan.prevStart,
          prevEnd: plan.prevEnd,
          prevDur: plan.prevDur,
          newStart: plan.newStart,
          newEnd: plan.newEnd,
          newDur: plan.newDur,
          offset: start,
        }));

        if (row.trip_dir) {
          await fsp.rm(path.join(row.trip_dir, "thumb.jpg"), { force: true }).catch(() => {});
        }
        channel.push({ stage: "done", message: "裁剪完成", done: 100, total: 100 });
      } catch (err) {
        const cancelled = controller.signal.aborted;
        // 清掉半成品暫存(播放檔全程未動,無需 rollback 播放檔)。
        for (const p of cams) await fsp.rm(tmpPath(p), { force: true }).catch(() => {});
        // 首次裁剪失敗/取消:刪掉剛建立的 .orig 備份,回到「未裁剪」狀態(避免殘留誤導)。
        if (wasFirstTrim && !db.prepare('SELECT 1 FROM media_commits WHERE trip_id=?').get(row.trip_id)) {
          for (const p of cams) await fsp.rm(origPath(p), { force: true }).catch(() => {});
        }
        channel.push({
          stage: cancelled ? "cancelled" : "error",
          message: cancelled ? "已取消裁剪" : err instanceof Error ? err.message : String(err),
        });
      } finally {
        jobs.unregisterTrim(row.trip_id);
        channel.close();
      }
    }
  }
}
