/**
 * 維運 / 善後 API(僅限管理員)。
 *
 *   事件:列出 / 詳情 / 標記 / 刪除 / 刪來源 / 重試(重新合併,SSE 進度)
 *   健康:掃出影片缺失或 0-byte 的旅程
 *   DB 檢視:唯讀瀏覽各表(敏感欄位遮蔽)
 *
 * 重試會對隔離保留的原始素材重跑既有 processBatch;成功即清掉素材並標記事件已解決。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { TRIPS_DIR } from "../config.js";
import { makeRequireAdmin, type AppContext } from "../context.js";
import { processBatch } from "../trips/organizer.js";
import { upsertTrip, tripDirOf, renumberDay } from "../trips/repo.js";
import { parseDeviceSnapshot, type DashcamDeviceSnapshot } from "../devices/repo.js";
import { pathExists } from "../util/fsx.js";
import { clampInt } from "../util/num.js";
import {
  listIncidents,
  getIncident,
  resolveIncident,
  clearQuarantine,
  incidentCounts,
  type IncidentRow,
} from "../incidents/repo.js";

/** DB 檢視時要遮蔽的敏感欄位(表 → 欄位集合)。 */
const SENSITIVE: Record<string, Set<string>> = {
  users: new Set(["password_hash"]),
  sessions: new Set(["token"]),
  sftp_sessions: new Set(["password"]),
};
const REDACTED = "••• redacted";

async function fileSize(p: string | null): Promise<number> {
  if (!p) return 0;
  try {
    return (await fs.stat(p)).size;
  } catch {
    return 0;
  }
}

export function registerOps(app: FastifyInstance, ctx: AppContext): void {
  const { db, sse, settings, sessions, jobs } = ctx;
  const requireAdmin = makeRequireAdmin(ctx);

  // ── 事件清單 ──
  app.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>(
    "/api/admin/incidents",
    { preHandler: requireAdmin },
    async (req) => {
      const status =
        req.query.status === "all" ||
        req.query.status === "resolved" ||
        req.query.status === "dismissed"
          ? req.query.status
          : "open";
      const limit = clampInt(req.query.limit, 100, 1, 500);
      const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const { total, rows } = listIncidents(db, { status: status as never, limit, offset });
      return { total, counts: incidentCounts(db), incidents: rows.map(decorateIncident) };
    },
  );

  // ── 事件詳情 ──
  app.get<{ Params: { id: string } }>(
    "/api/admin/incidents/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const inc = getIncident(db, Number.parseInt(req.params.id, 10));
      if (!inc) return reply.code(404).send({ detail: "事件不存在" });
      const detail = decorateIncident(inc);
      // 詳情額外回傳隔離素材是否仍在磁碟上(決定能否重試)。
      detail.quarantine_exists = inc.quarantine_dir ? await pathExists(inc.quarantine_dir) : false;
      return detail;
    },
  );

  // ── 標記已解決 / 忽略 ──
  app.post<{ Params: { id: string }; Body: { status?: string; note?: string } }>(
    "/api/admin/incidents/:id/resolve",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      const inc = getIncident(db, id);
      if (!inc) return reply.code(404).send({ detail: "事件不存在" });
      const status = req.body?.status === "dismissed" ? "dismissed" : "resolved";
      const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 2000) : "";
      resolveIncident(db, id, { status, userId: req.user!.id, resolution: note });
      return { status: "ok" };
    },
  );

  // ── 刪除隔離素材(放棄重試,釋放空間),保留事件記錄 ──
  app.post<{ Params: { id: string } }>(
    "/api/admin/incidents/:id/discard-source",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      const inc = getIncident(db, id);
      if (!inc) return reply.code(404).send({ detail: "事件不存在" });
      if (inc.quarantine_dir) {
        await fs.rm(inc.quarantine_dir, { recursive: true, force: true }).catch(() => {});
        // 只有確實刪成功(目錄已消失)才清空欄位,避免 DB 與磁碟不符。
        if (!(await pathExists(inc.quarantine_dir))) {
          clearQuarantine(db, id);
        } else {
          return reply.code(500).send({ detail: "刪除隔離素材失敗(檔案系統錯誤),請稍後再試" });
        }
      }
      return { status: "ok" };
    },
  );

  // ── 刪除事件(連同隔離素材) ──
  app.delete<{ Params: { id: string } }>(
    "/api/admin/incidents/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      const inc = getIncident(db, id);
      if (!inc) return reply.code(404).send({ detail: "事件不存在" });
      if (inc.quarantine_dir) {
        await fs.rm(inc.quarantine_dir, { recursive: true, force: true }).catch(() => {});
        // 隔離夾刪不掉就別刪事件列,否則目錄變成無人引用的孤兒、永久佔用磁碟。
        if (await pathExists(inc.quarantine_dir)) {
          return reply
            .code(500)
            .send({ detail: "刪除隔離素材失敗(檔案系統錯誤),事件已保留,請稍後再試" });
        }
      }
      db.prepare("DELETE FROM incidents WHERE id = ?").run(id);
      return { status: "deleted" };
    },
  );

  // ── 重試合併(核心修復):對隔離素材重跑 processBatch,進度走 SSE ──
  app.post<{ Params: { id: string }; Querystring: { mode?: string } }>(
    "/api/admin/incidents/:id/retry",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      const inc = getIncident(db, id);
      if (!inc) return reply.code(404).send({ detail: "事件不存在" });
      if (!inc.quarantine_dir || !(await pathExists(inc.quarantine_dir))) {
        return reply.code(400).send({ detail: "找不到可重試的隔離素材(可能已被清理或重試成功)" });
      }
      const key = `inc${id}`;
      const existing = sse.get(key);
      if (existing && !existing.closed) return reply.code(409).send({ detail: "此事件正在重試中" });
      const tolerant = req.query.mode === "tolerant";
      // 沿用原上傳的切趟、擁有者與裝置快照。舊事件沒有這些欄位時才採用執行重試者，
      // 避免管理員代為重試後把使用者的旅程錯誤轉到自己名下。
      let gapMin = settings.defaultGapMin();
      let ownerId = req.user!.id;
      let ownerUsername = req.user!.username;
      let deviceId: number | null = null;
      let device: DashcamDeviceSnapshot | null = null;
      let idNamespace: string | undefined;
      let restoredOwner = false;
      try {
        const ctxObj = JSON.parse(inc.context_json) as Record<string, unknown>;
        if (typeof ctxObj.gap_min === "number" && ctxObj.gap_min > 0) gapMin = ctxObj.gap_min;
        if (
          typeof ctxObj.owner_id === "number" &&
          Number.isInteger(ctxObj.owner_id) &&
          typeof ctxObj.owner_username === "string" &&
          ctxObj.owner_username.length > 0
        ) {
          const matched = db
            .prepare("SELECT id, username FROM users WHERE id = ? AND username = ?")
            .get(ctxObj.owner_id, ctxObj.owner_username) as
            | { id: number; username: string }
            | undefined;
          if (matched) {
            ownerId = matched.id;
            ownerUsername = matched.username;
            restoredOwner = true;
          }
        }
        if (typeof ctxObj.device_id === "number" && Number.isInteger(ctxObj.device_id)) {
          deviceId = ctxObj.device_id;
        }
        device = parseDeviceSnapshot(ctxObj.device);
        if (typeof ctxObj.id_namespace === "string" && ctxObj.id_namespace.length <= 100) {
          idNamespace = ctxObj.id_namespace;
        }
      } catch {
        /* 用預設 */
      }
      if (!restoredOwner) idNamespace = undefined;
      if (deviceId !== null) {
        const ownedDevice = db
          .prepare("SELECT 1 FROM dashcam_devices WHERE id = ? AND user_id = ?")
          .get(deviceId, ownerId);
        if (!ownedDevice) deviceId = null;
      }
      const ownerStillExists = db
        .prepare("SELECT 1 FROM users WHERE id = ? AND username = ?")
        .get(ownerId, ownerUsername);
      if (!ownerStillExists) {
        return reply.code(409).send({ detail: "旅程擁有者帳號已不存在，無法啟動重試" });
      }
      // 與刪帳號形成同步互斥：刪除先開始時 revoking 會擋重試；重試先登記時
      // users route 的 hasOwnerProcess 會擋刪除，避免背景 processBatch 寫回孤兒 owner。
      if (sessions.isUserRevoking(ownerId)) {
        return reply.code(409).send({ detail: "旅程擁有者帳號正在刪除，無法啟動重試" });
      }
      jobs.registerOwnerProcess(ownerId);
      try {
        startRetry(
          id,
          inc.quarantine_dir,
          tolerant,
          gapMin,
          ownerId,
          ownerUsername,
          deviceId,
          device,
          idNamespace,
        );
      } catch (error) {
        jobs.unregisterOwnerProcess(ownerId);
        throw error;
      }
      return { status: "started", mode: tolerant ? "tolerant" : "copy" };
    },
  );

  // ── 重試進度 SSE(比照 routes/process.ts) ──
  app.get<{ Params: { id: string } }>(
    "/api/admin/incidents/:id/events",
    { preHandler: requireAdmin },
    (req, reply) => {
      const channel = sse.get(`inc${Number.parseInt(req.params.id, 10)}`);
      if (!channel) {
        reply.code(404).send({ detail: "沒有進行中的重試" });
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

  // ── 旅程健康檢查:找出影片缺失或 0-byte 的旅程 ──
  app.get("/api/admin/health/trips", { preHandler: requireAdmin }, async () => {
    const rows = db
      .prepare(
        "SELECT trip_id, date, has_front, has_rear, front_path, rear_path, trip_dir FROM trips ORDER BY date DESC",
      )
      .all() as Array<{
      trip_id: string;
      date: string;
      has_front: number;
      has_rear: number;
      front_path: string | null;
      rear_path: string | null;
      trip_dir: string | null;
    }>;
    const bad = [];
    for (const r of rows) {
      const fsz = await fileSize(r.front_path);
      const rsz = await fileSize(r.rear_path);
      const frontBad = r.has_front === 1 && fsz === 0;
      const rearBad = r.has_rear === 1 && rsz === 0;
      const nothing = fsz === 0 && rsz === 0;
      if (frontBad || rearBad || nothing) {
        bad.push({
          trip_id: r.trip_id,
          date: r.date,
          front_bytes: fsz,
          rear_bytes: rsz,
          trip_dir: r.trip_dir,
          issue: nothing ? "no_video" : "partial_empty",
        });
      }
    }
    return { checked: rows.length, problems: bad };
  });

  // ── 唯讀 DB 檢視:列出表 ──
  app.get("/api/admin/db/tables", { preHandler: requireAdmin }, async () => {
    const names = listTableNames(db);
    return {
      tables: names.map((name) => {
        const count = (db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number }).c;
        const cols = (
          db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>
        ).map((c) => c.name);
        return { name, count, columns: cols, redacted: [...(SENSITIVE[name] ?? [])] };
      }),
    };
  });

  // ── 唯讀 DB 檢視:讀某表的列(分頁 + 敏感欄位遮蔽) ──
  app.get<{ Querystring: { table?: string; limit?: string; offset?: string } }>(
    "/api/admin/db/rows",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const table = req.query.table ?? "";
      const names = listTableNames(db);
      if (!names.includes(table) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
        return reply.code(400).send({ detail: "未知的資料表" });
      }
      const limit = clampInt(req.query.limit, 50, 1, 200);
      const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c;
      const cols = (
        db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>
      ).map((c) => c.name);
      const rows = db
        .prepare(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`)
        .all(limit, offset) as Array<Record<string, unknown>>;
      const redact = SENSITIVE[table];
      if (redact) {
        for (const row of rows) {
          for (const col of redact) {
            if (row[col] !== null && row[col] !== undefined && row[col] !== "") row[col] = REDACTED;
          }
        }
      }
      return { table, columns: cols, total, limit, offset, rows };
    },
  );

  /** 對隔離素材重跑合併;成功則清素材並標記事件已解決。 */
  function startRetry(
    id: number,
    quarantineDir: string,
    tolerant: boolean,
    gapMin: number,
    ownerId: number,
    ownerUsername: string,
    deviceId: number | null,
    device: DashcamDeviceSnapshot | null,
    idNamespace?: string,
  ): void {
    const key = `inc${id}`;
    const channel = sse.create(key);
    const run = async () => {
      let produced = 0;
      let failures = 0;
      const touchedDates = new Set<string>();
      try {
        channel.push({ stage: "scan", message: tolerant ? "容錯重合開始…" : "重新合併開始…" });
        const doneIds = new Set(
          (db.prepare("SELECT trip_id FROM trips").all() as Array<{ trip_id: string }>).map(
            (r) => r.trip_id,
          ),
        );
        const tripsDir = idNamespace
          ? path.join(TRIPS_DIR, "by-user", String(ownerId), "by-device", String(deviceId ?? 0))
          : TRIPS_DIR;
        for await (const ev of processBatch({
          uploadDir: quarantineDir,
          tripsDir,
          gapSec: gapMin * 60,
          doneTripIds: doneIds,
          tolerant,
          idNamespace,
          ownerId,
          ownerUsername,
          deviceId,
          device,
        })) {
          if (ev.tripInfo) {
            // 指定 ownerId:重試產物必須有歸屬,否則 owner_id 為 NULL 在瀏覽介面對所有人隱形。
            upsertTrip(db, ev.tripInfo, tripDirOf(ev.tripInfo), ownerId);
            touchedDates.add(ev.tripInfo.date);
            produced++;
          }
          if (ev.incident) failures++;
          const { tripInfo: _t, incident: _i, ...wire } = ev;
          channel.push({ ...wire, stage: wire.stage === "done" ? "finalizing" : wire.stage });
        }
        for (const d of touchedDates) {
          try {
            renumberDay(db, d, ownerId);
          } catch {
            /* 略 */
          }
        }
        if (produced > 0 && failures === 0) {
          // 全部成功才刪素材;部分成功時素材必須保留(失敗趟次的原始片段還在裡面,
          // 刪了就永久遺失、無法用容錯模式再試)。
          await fs.rm(quarantineDir, { recursive: true, force: true });
          resolveIncident(db, id, {
            status: "resolved",
            resolution: `重試成功,產生 ${produced} 趟旅程${tolerant ? "(容錯模式)" : ""}`,
          });
          clearQuarantine(db, id);
          channel.push({
            stage: "done",
            message: `重試完成,產生 ${produced} 趟旅程`,
            done: 1,
            total: 1,
          });
        } else if (produced > 0) {
          channel.push({
            stage: "done",
            message: `重試部分成功:產生 ${produced} 趟,仍有 ${failures} 趟失敗;素材已保留,可改用容錯模式再試`,
            incidents: failures,
            done: 1,
            total: 1,
          });
        } else {
          channel.push({
            stage: "error",
            message: "重試未產生有效旅程,原始素材已保留供再次嘗試",
            done: 1,
            total: 1,
          });
        }
      } catch (err) {
        channel.push({ stage: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        jobs.unregisterOwnerProcess(ownerId);
        channel.close();
      }
    };
    if (ctx.tasks)
      ctx.tasks.enqueue(
        {
          type: "import",
          owner: ownerId,
          target: `incident:${id}`,
          payload: { incident_id: id },
          key,
        },
        channel,
        run,
      );
    else void run();
  }
}

interface DecoratedIncident extends IncidentRow {
  context: unknown;
  has_quarantine: boolean;
  quarantine_exists?: boolean;
}

/** 把 context_json 解析成物件附在回傳上(前端免再 parse)。 */
function decorateIncident(inc: IncidentRow): DecoratedIncident {
  let context: unknown = {};
  try {
    context = JSON.parse(inc.context_json);
  } catch {
    /* 略 */
  }
  return { ...inc, context, has_quarantine: Boolean(inc.quarantine_dir) };
}

/** 列出使用者資料表(排除 SQLite 內部表)。 */
function listTableNames(db: AppContext["db"]): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}
