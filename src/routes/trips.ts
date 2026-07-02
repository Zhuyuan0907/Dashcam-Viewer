/**
 * 旅程查詢 / 刪除 / 重建 DB。
 */
import type { FastifyInstance } from "fastify";
import {
  listDates,
  overallStats,
  listTrips,
  getTrip,
  deleteTrip,
  rebuildFromDisk,
  getTripNote,
  setTripNote,
  tripBytes,
  canBrowseOwner,
  canViewTrip,
  canEditTrip,
  listOwners,
} from "../trips/repo.js";
import { makeRequireUser, makeRequireAdmin, type AppContext } from "../context.js";

export function registerTrips(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const requireUser = makeRequireUser(ctx);
  const requireAdmin = makeRequireAdmin(ctx);

  /**
   * 解析 ?owner 為要瀏覽的擁有者 id(預設請求者本人),並檢查可見性。
   * 回傳 { ownerId } 或 { error:reply } —— 呼叫端遇 error 直接 return。
   */
  function resolveOwner(req: { query: { owner?: string }; user?: { id: number; role: string } }): number {
    const raw = req.query.owner;
    if (raw === undefined || raw === "") return req.user!.id;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : req.user!.id;
  }

  // 可瀏覽的旅程擁有者清單(browse 使用者選單)。
  app.get("/api/trip-owners", { preHandler: requireUser }, async (req) =>
    listOwners(db, req.user!),
  );

  app.get<{ Querystring: { owner?: string } }>(
    "/api/trips/dates",
    { preHandler: requireUser },
    async (req, reply) => {
      const ownerId = resolveOwner(req);
      if (!canBrowseOwner(db, req.user!, ownerId)) {
        return reply.code(403).send({ detail: "無權瀏覽此使用者的旅程" });
      }
      return listDates(db, ownerId, req.user!);
    },
  );

  app.get("/api/trips/stats", { preHandler: requireUser }, async () => overallStats(db));

  app.get<{ Querystring: { date?: string; owner?: string; limit?: string; offset?: string } }>(
    "/api/trips",
    { preHandler: requireUser },
    async (req, reply) => {
      const ownerId = resolveOwner(req);
      if (!canBrowseOwner(db, req.user!, ownerId)) {
        return reply.code(403).send({ detail: "無權瀏覽此使用者的旅程" });
      }
      const date = req.query.date ?? null;
      const limit = clampInt(req.query.limit, 50, 1, 200);
      const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      return listTrips(db, { date, ownerId, viewer: req.user!, limit, offset });
    },
  );

  app.get<{ Params: { "*": string } }>(
    "/api/trips/*",
    { preHandler: requireUser },
    async (req, reply) => {
      const tripId = req.params["*"];
      const row = getTrip(db, tripId);
      // 找不到、或無權瀏覽 → 一律 404(不洩露旅程是否存在)。
      if (!row || !canViewTrip(db, req.user!, row)) {
        return reply.code(404).send({ detail: "旅程不存在" });
      }
      const n = getTripNote(db, tripId);
      return {
        ...row,
        bytes: tripBytes(row),
        trimmed: row.orig_duration_sec !== null,
        trimming: ctx.sse.has(`trim:${tripId}`),
        note: n?.note ?? "",
        note_updated_at: n?.updated_at ?? null,
      };
    },
  );

  app.delete<{ Params: { "*": string } }>(
    "/api/trips/*",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const tripId = req.params["*"];
      const ok = await deleteTrip(db, tripId);
      if (!ok) return reply.code(404).send({ detail: "旅程不存在" });
      return { status: "deleted", trip_id: tripId };
    },
  );

  // 旅程備註(單一、可編輯;僅管理員可寫)。獨立前綴避開 /api/trips/* catch-all。
  app.put<{ Params: { "*": string }; Body: { note?: string } }>(
    "/api/trip-note/*",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const tripId = req.params["*"];
      if (!getTrip(db, tripId)) return reply.code(404).send({ detail: "旅程不存在" });
      const note = typeof req.body?.note === "string" ? req.body.note : "";
      if (note.length > 5000) return reply.code(400).send({ detail: "備註過長(上限 5000 字)" });
      setTripNote(db, tripId, note, req.user!.id);
      return { status: "ok" };
    },
  );

  // 單一旅程可見性覆寫(擁有者或管理員)。獨立前綴避開 /api/trips/* catch-all。
  app.put<{ Params: { "*": string }; Body: { override?: number | null } }>(
    "/api/trip-visibility/*",
    { preHandler: requireUser },
    async (req, reply) => {
      const tripId = req.params["*"];
      const row = getTrip(db, tripId);
      if (!row) return reply.code(404).send({ detail: "旅程不存在" });
      if (!canEditTrip(db, req.user!, row)) return reply.code(403).send({ detail: "無權編輯此旅程" });
      const ov = req.body?.override;
      if (ov !== null && ov !== 0 && ov !== 1) {
        return reply.code(400).send({ detail: "override 須為 null、0 或 1" });
      }
      db.prepare("UPDATE trips SET public_override = ? WHERE trip_id = ?").run(ov, tripId);
      return { status: "ok", public_override: ov };
    },
  );

  app.post("/api/rebuild-db", { preHandler: requireAdmin }, async () => {
    const imported = await rebuildFromDisk(db);
    return { status: "ok", imported };
  });
}

function clampInt(raw: string | undefined, dflt: number, min: number, max: number): number {
  if (raw === undefined) return dflt;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
