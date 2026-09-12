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
  setPublicOverride,
  canBrowseOwner,
  canViewTrip,
  canEditTrip,
  listOwners,
  tripDevice,
  type TripRow,
  type Viewer,
} from "../trips/repo.js";
import type { DashcamDeviceSnapshot } from "../devices/repo.js";
import type { DB } from "../db.js";
import { clampInt } from "../util/num.js";
import { makeRequireUser, makeRequireAdmin, type AppContext } from "../context.js";
import { readTimeline } from "../media/timeline.js";
import { inspectMediaCached } from "../media/inspect.js";
import { withinTrips } from "../util/paths.js";

/**
 * 對外旅程 DTO。資料層刻意保留完整路徑供影片、裁剪與刪除流程使用，
 * API 邊界則只允許前端實際需要的欄位，避免新增 DB 欄位時意外一併公開。
 */
interface TripDeviceDto {
  profile_key: DashcamDeviceSnapshot["profile_key"];
  model: string;
  nickname: string;
  note: string;
  show_on_trips: boolean;
}

interface TripDto {
  trip_id: string;
  date: string;
  day_order: number;
  start_epoch: number;
  end_epoch: number;
  duration_sec: number;
  segment_count: number;
  emer_count: number;
  has_front: number;
  has_rear: number;
  peak_gforce: number;
  gforce_events: number;
  owner_id: number | null;
  public_override: number | null;
  bytes: number;
  trimmed: boolean;
  device: TripDeviceDto | null;
}

function deviceDto(db: DB, row: TripRow, viewer: Viewer): TripDeviceDto | null {
  const snapshot = tripDevice(row);
  if (!snapshot) return null;
  const ownsTrip = row.owner_id !== null && row.owner_id === viewer.id;
  let showOnTrips = snapshot.show_on_trips;
  // 型號／名稱／備註維持上傳當下的不可變快照，但「是否分享裝置資訊」是現行隱私
  // 設定：使用者關閉後應立即套用到所有舊旅程，而不是仍公開過去的安裝備註。
  if (row.device_id !== null && row.owner_id !== null) {
    const current = db
      .prepare("SELECT show_on_trips FROM dashcam_devices WHERE id = ? AND user_id = ?")
      .get(row.device_id, row.owner_id) as { show_on_trips: number } | undefined;
    if (current) showOnTrips = current.show_on_trips === 1;
  }
  if (viewer.role !== "admin" && !ownsTrip && !showOnTrips) return null;
  return {
    profile_key: snapshot.profile_key,
    model: snapshot.model,
    nickname: snapshot.nickname,
    note: snapshot.note,
    show_on_trips: showOnTrips,
  };
}

function tripDto(db: DB, row: TripRow, viewer: Viewer, bytes: number): TripDto {
  return {
    trip_id: row.trip_id,
    date: row.date,
    day_order: row.day_order,
    start_epoch: row.start_epoch,
    end_epoch: row.end_epoch,
    duration_sec: row.duration_sec,
    segment_count: row.segment_count,
    emer_count: row.emer_count,
    has_front: row.has_front,
    has_rear: row.has_rear,
    peak_gforce: row.peak_gforce,
    gforce_events: row.gforce_events,
    owner_id: row.owner_id,
    public_override: row.public_override,
    bytes,
    trimmed: row.orig_duration_sec !== null,
    device: deviceDto(db, row, viewer),
  };
}

export function registerTrips(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const requireUser = makeRequireUser(ctx);
  const requireAdmin = makeRequireAdmin(ctx);

  /**
   * 解析 ?owner 為要瀏覽的擁有者 id(預設請求者本人),並檢查可見性。
   * 回傳 { ownerId } 或 { error:reply } —— 呼叫端遇 error 直接 return。
   */
  function resolveOwner(req: {
    query: { owner?: string };
    user?: { id: number; role: string };
  }): number {
    const raw = req.query.owner;
    if (raw === undefined || raw === "") return req.user!.id;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : req.user!.id;
  }

  // 可瀏覽的旅程擁有者清單(browse 使用者選單)。
  app.get<{ Params: { "*": string } }>(
    "/api/trip-media/*",
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const row = getTrip(db, req.params["*"]);
      if (!row || !canViewTrip(db, req.user!, row))
        return reply.code(404).send({ detail: "旅程不存在" });
      const result: Record<string, unknown> = {};
      for (const camera of ["front", "rear"] as const) {
        const file = row[`${camera}_path`];
        if (file && withinTrips(file))
          result[camera] = await inspectMediaCached(file).catch(() => null);
      }
      return result;
    },
  );
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

  app.get("/api/trips/stats", { preHandler: requireUser }, async (req) =>
    overallStats(db, req.user!),
  );

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
      const result = await listTrips(db, { date, ownerId, viewer: req.user!, limit, offset });
      return {
        total: result.total,
        trips: result.trips.map((row) => tripDto(db, row, req.user!, row.bytes)),
      };
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
        ...tripDto(db, row, req.user!, await tripBytes(row)),
        timeline: readTimeline(row),
        // isActive(非 has):已完成的 channel 會保留數分鐘供重連,用 has 會誤判為「裁剪中」
        // → 前端在裁剪完成後仍顯示忙碌並被 409 擋下、陷入無限重整。isActive 完成即為 false。
        trimming: ctx.sse.isActive(`trim:${tripId}`),
        note: n?.note ?? "",
        note_updated_at: n?.updated_at ?? null,
      };
    },
  );

  app.delete<{ Params: { "*": string } }>(
    "/api/trips/*",
    { preHandler: requireUser },
    async (req, reply) => {
      const tripId = req.params["*"];
      const row = getTrip(db, tripId);
      if (!row || !canEditTrip(db, req.user!, row))
        return reply.code(404).send({ detail: "旅程不存在" });
      if (ctx.jobs.busy(tripId))
        return reply.code(409).send({ detail: "請先等待或取消此旅程的背景工作" });
      ctx.jobs.registerTrim(tripId, new AbortController());
      try {
        const ok = await deleteTrip(db, tripId);
        if (!ok) return reply.code(404).send({ detail: "旅程不存在" });
        return { status: "deleted", trip_id: tripId };
      } finally {
        ctx.jobs.unregisterTrim(tripId);
      }
    },
  );

  // 旅程備註(單一、可編輯;僅管理員可寫)。獨立前綴避開 /api/trips/* catch-all。
  app.put<{ Params: { "*": string }; Body: { note?: string } }>(
    "/api/trip-note/*",
    { preHandler: requireUser },
    async (req, reply) => {
      const tripId = req.params["*"];
      const row = getTrip(db, tripId);
      if (!row) return reply.code(404).send({ detail: "旅程不存在" });
      if (!canEditTrip(db, req.user!, row))
        return reply.code(403).send({ detail: "無權編輯此旅程" });
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
      if (!canEditTrip(db, req.user!, row))
        return reply.code(403).send({ detail: "無權編輯此旅程" });
      const ov = req.body?.override;
      if (ov !== null && ov !== 0 && ov !== 1) {
        return reply.code(400).send({ detail: "override 須為 null、0 或 1" });
      }
      setPublicOverride(db, tripId, ov);
      return { status: "ok", public_override: ov };
    },
  );

  app.post("/api/rebuild-db", { preHandler: requireAdmin }, async () => {
    const imported = await rebuildFromDisk(db);
    return { status: "ok", imported };
  });
}
