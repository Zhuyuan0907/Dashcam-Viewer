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
import { upsertTrip, type TripInfo } from "../trips/repo.js";
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

function tripDirOf(info: TripInfo): string | null {
  const p = info.front_path ?? info.rear_path;
  return p ? path.dirname(p) : null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(p: string | null): Promise<number> {
  if (!p) return 0;
  try {
    return (await fs.stat(p)).size;
  } catch {
    return 0;
  }
}

export function registerOps(app: FastifyInstance, ctx: AppContext): void {
  const { db, sse, settings } = ctx;
  const requireAdmin = makeRequireAdmin(ctx);

  // ── 事件清單 ──
  app.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>(
    "/api/admin/incidents",
    { preHandler: requireAdmin },
    async (req) => {
      const status = req.query.status === "all" || req.query.status === "resolved" || req.query.status === "dismissed"
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
        clearQuarantine(db, id);
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
      startRetry(id, inc.quarantine_dir, tolerant);
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
      .prepare("SELECT trip_id, date, has_front, has_rear, front_path, rear_path, trip_dir FROM trips ORDER BY date DESC")
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
        const cols = (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        );
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
      const cols = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      const rows = db.prepare(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`).all(limit, offset) as Array<
        Record<string, unknown>
      >;
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
  function startRetry(id: number, quarantineDir: string, tolerant: boolean): void {
    const key = `inc${id}`;
    const channel = sse.create(key);
    void (async () => {
      let produced = 0;
      try {
        channel.push({ stage: "scan", message: tolerant ? "容錯重合開始…" : "重新合併開始…" });
        const doneIds = new Set(
          (db.prepare("SELECT trip_id FROM trips").all() as Array<{ trip_id: string }>).map((r) => r.trip_id),
        );
        for await (const ev of processBatch({
          uploadDir: quarantineDir,
          tripsDir: TRIPS_DIR,
          gapSec: settings.defaultGapMin() * 60,
          doneTripIds: doneIds,
          tolerant,
        })) {
          if (ev.tripInfo) {
            upsertTrip(db, ev.tripInfo, tripDirOf(ev.tripInfo));
            produced++;
          }
          const { tripInfo: _t, incident: _i, ...wire } = ev;
          channel.push(wire);
        }
        if (produced > 0) {
          await fs.rm(quarantineDir, { recursive: true, force: true }).catch(() => {});
          resolveIncident(db, id, {
            status: "resolved",
            resolution: `重試成功,產生 ${produced} 趟旅程${tolerant ? "(容錯模式)" : ""}`,
          });
          clearQuarantine(db, id);
          channel.push({ stage: "done", message: `重試完成,產生 ${produced} 趟旅程`, done: 1, total: 1 });
        } else {
          channel.push({
            stage: "done",
            message: "重試未產生有效旅程,原始素材已保留供再次嘗試",
            done: 1,
            total: 1,
          });
        }
      } catch (err) {
        channel.push({ stage: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        channel.close();
      }
    })();
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
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function clampInt(raw: string | undefined, dflt: number, min: number, max: number): number {
  if (raw === undefined) return dflt;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
