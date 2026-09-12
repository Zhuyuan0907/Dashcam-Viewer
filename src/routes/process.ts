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
import { upsertTrip, tripDirOf, renumberDay } from "../trips/repo.js";
import { recordIncident } from "../incidents/repo.js";
import { pathExists as exists } from "../util/fsx.js";
import { makeRequireUser, type AppContext } from "../context.js";

/** 目錄下是否還有影片檔(*.mp4)—— 用來判斷 prebuilt 匯入後是否有未匯入的殘留素材。 */
async function hasVideoFiles(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (await hasVideoFiles(full)) return true;
    } else if (e.name.toLowerCase().endsWith(".mp4")) {
      return true;
    }
  }
  return false;
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
  // 擷取本工作階段的擁有者,處理出來的旅程都歸給他(session 結束前有效);
  // 同時記在 channel 上,供進度 SSE 端點驗證只有擁有者(或管理員)能訂閱。
  const session = sessions.get(sessionId);
  const ownerId = session?.userId ?? null;
  const ownerUsername = session?.username ?? null;
  const deviceId = session?.deviceId ?? null;
  const device = session?.deviceSnapshot ?? null;
  const idNamespace = `v2|u:${ownerId ?? 0}|d:${deviceId ?? 0}`;
  const tripsDir = path.join(
    TRIPS_DIR,
    "by-user",
    String(ownerId ?? 0),
    "by-device",
    String(deviceId ?? 0),
  );
  const channel = sse.create(sessionId, ownerId);
  sessions.setStatus(sessionId, "processing");

  const prebuiltSrc = path.join(PREBUILT_DIR, sessionId);
  const rawSrc = path.join(UPLOAD_DIR, sessionId);
  // 本次處理收集到的失敗事件;結束時持久化到 incidents 表(供善後系統)。
  const incidents: IncidentPayload[] = [];
  // 本次寫入旅程涉及的日期(結束後重新編號 day_order,避免同日分批的重複「第N趟」)。
  const touchedDates = new Set<string>();

  void runSession();

  async function forward(ev: ProgressEvent): Promise<void> {
    if (ev.tripInfo) {
      upsertTrip(db, ev.tripInfo, tripDirOf(ev.tripInfo), ownerId);
      touchedDates.add(ev.tripInfo.date);
    }
    if (ev.incident) incidents.push(ev.incident);
    const { tripInfo: _omitT, incident: _omitI, ...wire } = ev;
    channel.push(wire);
  }

  async function runSession(): Promise<void> {
    let prebuiltCount = 0;
    let quarantined: string | null = null;
    // 任何一段素材該隔離卻隔離失敗(磁碟滿等)且仍留在 session 區:結束時不可 remove session。
    let quarantineFailed = false;
    // 以 ingest 的分類結果決定要跑哪段,而非「資料夾還在不在」。
    // 純 prebuilt 上傳搬走影片後,uploads/<sid> 仍會殘留 macOS 垃圾檔(.DS_Store/._*)與空夾,
    // 若只看 exists(rawSrc) 會誤判成「有原始片段」,跑去掃空的 F/ 夾而報假性失敗。
    const hasPrebuilt = uploadType === "prebuilt" || uploadType === "mixed";
    const hasRaw = uploadType === "raw" || uploadType === "mixed";
    try {
      if (hasPrebuilt) {
        channel.push({ stage: "merge", message: "開始匯入已整理旅程…" });
        for await (const ev of importPrebuiltTrips(prebuiltSrc, {
          tripsDir,
          mode: "move",
          idNamespace,
          ownerId,
          ownerUsername,
          deviceId,
          device,
        })) {
          if (ev.tripInfo) prebuiltCount++;
          await forward(ev);
        }
        // 匯入完成後,若暫存區仍有未被匯入的影片(名稱格式不符 / 缺影片等被略過的旅程),
        // 不可無條件刪除 —— 那會把使用者的素材直接毀掉。改為隔離保留並記事件供善後。
        if (await hasVideoFiles(prebuiltSrc)) {
          const q = path.join(QUARANTINE_DIR, `${sessionId}-prebuilt`);
          await moveDir(prebuiltSrc, q).catch(() => {});
          if (await exists(q)) {
            incidents.push({
              kind: "processing_error",
              severity: "warn",
              title: "部分已整理旅程未能匯入,素材已隔離保留",
              detail:
                "匯入時有旅程因資料夾名稱格式不符或缺少影片而被略過。相關素材未刪除,已隔離保留供人工檢查。",
              context: { sessionId, quarantine: q },
              quarantine_dir: q,
            });
          } else if (await hasVideoFiles(prebuiltSrc)) {
            // 隔離搬移失敗且素材還在暫存區:標記,結束時不可 remove session(否則素材被連夾刪除)。
            quarantineFailed = true;
            incidents.push({
              kind: "processing_error",
              severity: "error",
              title: "未匯入的已整理旅程素材隔離失敗,仍留在上傳暫存區",
              detail: "移動素材到隔離區失敗(可能磁碟空間不足)。工作階段已保留,請釋放空間後再確認一次。",
              context: { sessionId, prebuiltSrc },
            });
          }
        } else {
          await fs.rm(prebuiltSrc, { recursive: true, force: true });
        }
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
          tripsDir,
          gapSec: gapMin * 60,
          doneTripIds: doneIds,
          idNamespace,
          ownerId,
          ownerUsername,
          deviceId,
          device,
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
      // 帶結構化 incidents 數:前端據此決定「完成但有問題 → 不自動跳走、顯示警告」。
      channel.push({
        stage: "done",
        message: `完成${suffix}${rawSuffix}${warn}`,
        done: 1,
        total: 1,
        incidents: incidents.length,
      });
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
      // 各日重新編號 day_order(全域一致,修正同日分批上傳/匯入的重複「第N趟」)。
      for (const d of touchedDates) {
        try {
          renumberDay(db, d, ownerId);
        } catch {
          /* 編號失敗不致命 */
        }
      }
      for (const inc of incidents) {
        recordIncident(db, {
          session_id: sessionId,
          kind: inc.kind,
          severity: inc.severity,
          trip_label: inc.trip_label ?? null,
          title: inc.title,
          detail: inc.detail,
          // 記下本次切趟採用的 gap,供 ops 重試時沿用(而非退回全域預設造成切趟不同)。
          context: {
            ...inc.context,
            gap_min: gapMin,
            owner_id: ownerId,
            owner_username: ownerUsername,
            device_id: deviceId,
            device,
            id_namespace: idNamespace,
          },
          // 事件自帶的隔離夾優先(如 prebuilt 隔離),否則用 session 層級的 raw 隔離夾。
          quarantine_dir: inc.quarantine_dir ?? quarantined,
        });
      }
      // 孤兒隔離夾防護:raw 有被隔離、但每筆事件都自帶自己的隔離夾(如 mixed 上傳只有
      // prebuilt 失敗)→ raw 隔離夾沒有任何事件引用,ops 介面看不到、逾期清理也掃不到。
      // 補記一筆事件讓它可見、可重試、可清理。
      if (quarantined && incidents.length > 0 && incidents.every((i) => i.quarantine_dir)) {
        recordIncident(db, {
          session_id: sessionId,
          kind: "processing_error",
          severity: "warn",
          title: "原始片段已隔離保留(同批其他素材處理失敗)",
          detail: "本批處理有失敗事件,原始片段依政策隔離保留;確認旅程無誤後可刪除素材釋放空間。",
          context: {
            sessionId,
            gap_min: gapMin,
            owner_id: ownerId,
            owner_username: ownerUsername,
            device_id: deviceId,
            device,
            id_namespace: idNamespace,
          },
          quarantine_dir: quarantined,
        });
      }
      // 有失敗但隔離搬移也失敗(磁碟滿等)且素材仍留在 session 區:絕不可 remove
      //(會連夾帶素材一起刪)。改把 session 復位成 active,讓使用者稍後可再次確認重試。
      if (hasRaw && incidents.length > 0 && !quarantined && (await exists(rawSrc))) {
        quarantineFailed = true;
      }
      if (quarantineFailed) {
        sessions.setStatus(sessionId, "active");
      } else {
        await sessions.remove(sessionId);
      }
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
      // 只有建立此工作階段的擁有者(或管理員)能訂閱進度,避免跨使用者讀取他人上傳處理進度。
      if (
        req.user!.role !== "admin" &&
        channel.ownerId !== null &&
        channel.ownerId !== req.user!.id
      ) {
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
