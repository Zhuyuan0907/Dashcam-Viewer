/**
 * 旅程影片編輯:精確裁剪(重編碼、背景 + SSE 進度)與還原(擁有者或管理員)。
 *
 *   POST   /api/trip-trim/*          開始裁剪(body { start, end } 秒),背景執行
 *   GET    /api/trip-trim-events/*   SSE 進度(events 用獨立前綴,因 wildcard 後不可再接靜態段)
 *   DELETE /api/trip-trim/*          還原原始影片(從 .orig.mp4 復原)
 *
 * 裁剪一律以「原始檔備份」`前鏡頭.orig.mp4` / `後鏡頭.orig.mp4` 為來源,可重複裁剪與還原。
 * 前後鏡頭以相同起訖點裁剪以保持同步。輸出先寫 `.trim.tmp.mp4` 再原子 rename 覆蓋播放檔。
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { getTrip, canEditTrip, type TripRow } from "../trips/repo.js";
import { trimReencode } from "../media/ffmpeg.js";
import { TRIM_THREADS } from "../config.js";
import { makeRequireUser, type AppContext } from "../context.js";

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

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

export function registerEdit(app: FastifyInstance, ctx: AppContext): void {
  const { db, sse } = ctx;
  const requireUser = makeRequireUser(ctx);
  const trimKey = (id: string): string => `trim:${id}`;
  // 進行中的裁剪:tripId → AbortController(供取消 / 中斷時 kill ffmpeg)。
  const running = new Map<string, AbortController>();

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
      const baseDur = row.orig_duration_sec ?? row.duration_sec;
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
      if (sse.has(trimKey(tripId))) {
        return reply.code(409).send({ detail: "此旅程正在裁剪中,請稍候" });
      }
      startTrim(row, start, end);
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
          reply.raw.write('data: {"stage":"done"}\n\n');
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
      if (sse.has(trimKey(tripId))) return reply.code(409).send({ detail: "此旅程正在裁剪中" });

      for (const p of [row.front_path, row.rear_path]) {
        if (!p) continue;
        const orig = origPath(p);
        if (await exists(orig)) {
          await fsp.rm(p, { force: true }).catch(() => {});
          await fsp.rename(orig, p).catch(() => {});
        }
      }
      db.prepare(
        `UPDATE trips SET start_epoch = ?, end_epoch = ?, duration_sec = ?,
           orig_start_epoch = NULL, orig_end_epoch = NULL, orig_duration_sec = NULL
         WHERE trip_id = ?`,
      ).run(row.orig_start_epoch, row.orig_end_epoch, row.orig_duration_sec, tripId);
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
      const controller = running.get(tripId);
      if (!controller) return reply.code(404).send({ detail: "沒有進行中的裁剪" });
      controller.abort();
      return { status: "ok" };
    },
  );

  /**
   * 背景裁剪:對每個鏡頭以 .orig 為來源重編碼,進度合併推播;完成後更新 DB。
   * 可取消(AbortController → kill ffmpeg)。取消 / 失敗時做完整 rollback,
   * 確保不會留下「播放檔遺失」的半裁剪狀態(首次裁剪會把 .orig 還原回播放檔)。
   */
  function startTrim(row: TripRow, start: number, end: number): void {
    const controller = new AbortController();
    running.set(row.trip_id, controller);
    const channel = sse.create(trimKey(row.trip_id));
    const wasFirstTrim = row.orig_duration_sec === null;
    void run();

    async function run(): Promise<void> {
      const cams = [row.front_path, row.rear_path].filter((p): p is string => !!p);
      const dur = end - start;
      const prog: Record<string, number> = {};
      const emit = (): void => {
        const total = cams.reduce((a, p) => a + (prog[p] ?? 0), 0);
        const pct = Math.round((total / cams.length) * 100);
        channel.push({ stage: "encode", done: pct, total: 100, message: `裁剪中… ${pct}%` });
      };
      try {
        for (const p of cams) {
          const orig = origPath(p);
          // 確保有原始備份(首次裁剪把播放檔改名為 .orig)。
          if (!(await exists(orig))) await fsp.rename(p, orig);
          const tmp = tmpPath(p);
          const r = await trimReencode(orig, tmp, start, dur, {
            onProgress: (f) => {
              prog[p] = f;
              emit();
            },
            threads: TRIM_THREADS,
            signal: controller.signal,
          });
          if (!r.ok) throw new Error(r.error || "ffmpeg 失敗");
          await fsp.rename(tmp, p); // 原子覆蓋播放檔
          prog[p] = 1;
          emit();
        }

        const baseStart = row.orig_start_epoch ?? row.start_epoch;
        const newDur = Math.round(dur);
        const newStart = baseStart + Math.round(start);
        const newEnd = newStart + newDur;
        // 首次裁剪才寫入 orig_*(COALESCE 保留既有原始值,支援重複裁剪)。
        db.prepare(
          `UPDATE trips SET
             orig_start_epoch  = COALESCE(orig_start_epoch, ?),
             orig_end_epoch    = COALESCE(orig_end_epoch, ?),
             orig_duration_sec = COALESCE(orig_duration_sec, ?),
             start_epoch = ?, end_epoch = ?, duration_sec = ?
           WHERE trip_id = ?`,
        ).run(row.start_epoch, row.end_epoch, row.duration_sec, newStart, newEnd, newDur, row.trip_id);

        if (row.trip_dir) {
          await fsp.rm(path.join(row.trip_dir, "thumb.jpg"), { force: true }).catch(() => {});
        }
        channel.push({ stage: "done", message: "裁剪完成", done: 100, total: 100 });
      } catch (err) {
        const cancelled = controller.signal.aborted;
        // 清掉半成品暫存。
        for (const p of cams) await fsp.rm(tmpPath(p), { force: true }).catch(() => {});
        // 首次裁剪失敗/取消:把已備份的 .orig 還原回播放檔,徹底回到裁剪前(避免播放檔遺失)。
        if (wasFirstTrim) {
          for (const p of cams) {
            const orig = origPath(p);
            if (await exists(orig)) {
              await fsp.rm(p, { force: true }).catch(() => {});
              await fsp.rename(orig, p).catch(() => {});
            }
          }
        }
        channel.push({
          stage: cancelled ? "cancelled" : "error",
          message: cancelled ? "已取消裁剪" : err instanceof Error ? err.message : String(err),
        });
      } finally {
        running.delete(row.trip_id);
        channel.close();
      }
    }
  }
}
