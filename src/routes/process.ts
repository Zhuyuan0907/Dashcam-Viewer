/**
 * 旅程處理 + SSE 進度(所有登入者;由上傳工作階段確認觸發)。
 *
 * 由上傳工作階段的「確認」觸發(routes/upload.ts):先匯入已整理旅程(prebuilt,搬移),
 * 再整理原始片段(raw,ffmpeg 合併)。每趟完成時透過 repo.upsertTrip 寫入 DB(唯一寫入者),
 * 進度走 SSE channel;完成後移除工作階段(刪資料夾 + 列)。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { UPLOAD_DIR, PREBUILT_DIR, TRIPS_DIR, QUARANTINE_DIR } from "../config.js";
import { importPrebuiltTrips } from "../trips/prebuilt.js";
import { processBatch, type ProgressEvent, type IncidentPayload } from "../trips/organizer.js";
import { upsertTrip, type TripInfo } from "../trips/repo.js";
import { recordIncident } from "../incidents/repo.js";
import { makeRequireUser, type AppContext } from "../context.js";

function tripDirOf(info: TripInfo): string | null {
  const p = info.front_path ?? info.rear_path;
  return p ? path.dirname(p) : null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 跨檔案系統安全的目錄搬移(同分割區走 rename,跨裝置 fallback)。 */
export async function moveDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  try {
    await fs.rename(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EXDEV") {
      await fs.cp(src, dst, { recursive: true });
      await fs.rm(src, { recursive: true, force: true });
    } else {
      throw e;
    }
  }
}

/**
 * 開始處理一個已 ingest 的工作階段(背景執行,進度走 SSE channel)。
 * 假設 ingestFlatFolder 已把檔案整理成 UPLOAD_DIR/<sid>/{F,R,NMEA} 與 PREBUILT_DIR/<sid>。
 */
export function startProcessing(
  ctx: AppContext,
  sessionId: string,
  gapMin: number,
  uploadType: "raw" | "prebuilt" | "mixed" | "empty",
): void {
  const { db, sessions, sse } = ctx;
  const channel = sse.create(sessionId);
  // 擷取本工作階段的擁有者,處理出來的旅程都歸給他(session 結束前有效)。
  const ownerId = sessions.get(sessionId)?.userId ?? null;
  sessions.setStatus(sessionId, "processing");

  const prebuiltSrc = path.join(PREBUILT_DIR, sessionId);
  const rawSrc = path.join(UPLOAD_DIR, sessionId);
  // 本次處理收集到的失敗事件;結束時持久化到 incidents 表(供善後系統)。
  const incidents: IncidentPayload[] = [];

  void runSession();

  async function forward(ev: ProgressEvent): Promise<void> {
    if (ev.tripInfo) {
      upsertTrip(db, ev.tripInfo, tripDirOf(ev.tripInfo), ownerId);
    }
    if (ev.incident) incidents.push(ev.incident);
    const { tripInfo: _omitT, incident: _omitI, ...wire } = ev;
    channel.push(wire);
  }

  async function runSession(): Promise<void> {
    let prebuiltCount = 0;
    let quarantined: string | null = null;
    // 以 ingest 的分類結果決定要跑哪段,而非「資料夾還在不在」。
    // 純 prebuilt 上傳搬走影片後,uploads/<sid> 仍會殘留 macOS 垃圾檔(.DS_Store/._*)與空夾,
    // 若只看 exists(rawSrc) 會誤判成「有原始片段」,跑去掃空的 F/ 夾而報假性失敗。
    const hasPrebuilt = uploadType === "prebuilt" || uploadType === "mixed";
    const hasRaw = uploadType === "raw" || uploadType === "mixed";
    try {
      if (hasPrebuilt) {
        channel.push({ stage: "merge", message: "開始匯入已整理旅程…" });
        for await (const ev of importPrebuiltTrips(prebuiltSrc, { tripsDir: TRIPS_DIR, mode: "move" })) {
          if (ev.tripInfo) prebuiltCount++;
          await forward(ev);
        }
        await fs.rm(prebuiltSrc, { recursive: true, force: true });
      }

      if (hasRaw) {
        if (hasPrebuilt) channel.push({ stage: "scan", message: "開始整理原始片段…" });
        const doneIds = new Set(
          (db.prepare("SELECT trip_id FROM trips").all() as Array<{ trip_id: string }>).map(
            (r) => r.trip_id,
          ),
        );
        for await (const ev of processBatch({
          uploadDir: rawSrc,
          tripsDir: TRIPS_DIR,
          gapSec: gapMin * 60,
          doneTripIds: doneIds,
        })) {
          await forward(ev);
        }
        // 若本次有失敗事件,把原始素材「隔離保留」而非刪除,讓管理員之後能重試合併;
        // 否則維持原行為刪掉,釋放空間。
        if (await exists(rawSrc)) {
          if (incidents.length > 0) {
            quarantined = path.join(QUARANTINE_DIR, sessionId);
            await moveDir(rawSrc, quarantined).catch(() => {
              quarantined = null;
            });
          } else {
            await fs.rm(rawSrc, { recursive: true, force: true });
          }
        }
      }

      const suffix = hasPrebuilt ? `,已整理旅程 ${prebuiltCount} 趟` : "";
      const rawSuffix = hasRaw ? "＋原始片段已整理" : "";
      const warn = incidents.length > 0 ? `(有 ${incidents.length} 筆問題待處理)` : "";
      channel.push({ stage: "done", message: `完成${suffix}${rawSuffix}${warn}`, done: 1, total: 1 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      channel.push({ stage: "error", message: msg });
      incidents.push({
        kind: "processing_error",
        severity: "error",
        title: "處理過程發生例外",
        detail: err instanceof Error ? (err.stack ?? err.message) : String(err),
        context: { sessionId },
      });
      // 例外時也盡量保留原始素材供重試。
      if ((await exists(rawSrc)) && !quarantined) {
        quarantined = path.join(QUARANTINE_DIR, sessionId);
        await moveDir(rawSrc, quarantined).catch(() => {
          quarantined = null;
        });
      }
    } finally {
      for (const inc of incidents) {
        recordIncident(db, {
          session_id: sessionId,
          kind: inc.kind,
          severity: inc.severity,
          trip_label: inc.trip_label ?? null,
          title: inc.title,
          detail: inc.detail,
          context: inc.context,
          quarantine_dir: quarantined,
        });
      }
      await sessions.remove(sessionId);
      channel.close();
    }
  }
}

export function registerProcess(app: FastifyInstance, ctx: AppContext): void {
  const { sse } = ctx;
  // 上傳開放給所有登入者,故處理進度 SSE 亦然(session id 為隨機、不可猜)。
  const requireUser = makeRequireUser(ctx);

  app.get<{ Params: { session_id: string } }>(
    "/api/process/:session_id/events",
    { preHandler: requireUser },
    (req, reply) => {
      const sessionId = req.params.session_id;
      const channel = sse.get(sessionId);
      if (!channel) {
        reply.code(404).send({ detail: "找不到此 session" });
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
}
