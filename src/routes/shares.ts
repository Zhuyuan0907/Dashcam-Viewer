/**
 * 單趟旅程快速分享：登入者管理連結，持有高熵 token 的訪客只可讀該趟 metadata
 * 與前／後鏡頭媒體。分享端點不會建立登入 session，也不會轉呼叫一般旅程 API。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { COOKIE_SECURE, STATIC_DIR } from "../config.js";
import { extractFrame } from "../media/ffmpeg.js";
import {
  DEFAULT_SHARE_DAYS,
  MAX_SHARE_DAYS,
  createTripShare,
  getSharedTrip,
  getTripShare,
  listTripShares,
  recordShareAccess,
  recoverTripShareToken,
  revokeTripShare,
  rotateTripShare,
  type CreatedTripShare,
  type SharedTripRow,
  type TripShareRow,
} from "../shares/repo.js";
import { initializeShareTokenVault } from "../shares/token-vault.js";
import { canEditTrip, getTrip, tripDevice } from "../trips/repo.js";
import { withinTrips } from "../util/paths.js";
import { makeRequireUser, type AppContext } from "../context.js";
import { sendRange } from "./video.js";

const SHARE_PAGE = path.join(STATIC_DIR, "share.html");
const SHARE_COOKIE = "dashcam_share_access";
const SHARE_COOKIE_TTL_SEC = 60 * 60;
const SHARE_ACCESS_RATE_MAX = 30;
const SHARE_ACCESS_RATE_WINDOW_MS = 60_000;

interface ShareDto {
  id: number;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_access_at: number | null;
  access_count: number;
  active: boolean;
  recoverable: boolean;
  token_version: string;
}

function shareDto(row: TripShareRow, now = Math.floor(Date.now() / 1000)): ShareDto {
  return {
    id: row.id,
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    last_access_at: row.last_access_at,
    access_count: row.access_count,
    active: row.revoked_at === null && (row.expires_at === null || row.expires_at > now),
    recoverable: row.token_ciphertext !== null,
    token_version: row.token_hash.slice(0, 16),
  };
}

function shareLinkDto(created: CreatedTripShare, now: number) {
  return {
    share: shareDto(created.share, now),
    // 明文 token／URL 只出現在這次授權回應；列表 API 永遠不含連結。
    token: created.token,
    // URL fragment 不會送進任何 HTTP request line 或反向代理紀錄。
    share_url: `/share#${created.token}`,
  };
}

/** bearer URL 不可由共享快取保存，也不可成為搜尋引擎索引或 Referer。 */
function protectShareResponse(reply: FastifyReply): FastifyReply {
  return reply
    .header("Cache-Control", "private, no-store, max-age=0")
    .header("Pragma", "no-cache")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Robots-Tag", "noindex, nofollow, noarchive");
}

function clearShareCookie(reply: FastifyReply): void {
  reply.clearCookie(SHARE_COOKIE, {
    path: "/share",
    httpOnly: true,
    sameSite: "strict",
    secure: COOKIE_SECURE,
  });
}

function sharedTripFromCookie(db: AppContext["db"], req: FastifyRequest): SharedTripRow | null {
  const token = req.cookies?.[SHARE_COOKIE];
  return typeof token === "string" ? getSharedTrip(db, token) : null;
}

function invalidShare(reply: FastifyReply): FastifyReply {
  clearShareCookie(reply);
  return protectShareResponse(reply).code(404).send({ detail: "分享連結不存在或已失效" });
}

function sharedDeviceDto(db: AppContext["db"], row: SharedTripRow) {
  const snapshot = tripDevice(row);
  if (!snapshot) return null;
  let showOnTrips = snapshot.show_on_trips;
  // 和登入版旅程 DTO 相同：顯示內容取上傳快照，是否分享則採用裝置目前設定。
  if (row.device_id !== null && row.owner_id !== null) {
    const current = db
      .prepare("SELECT show_on_trips FROM dashcam_devices WHERE id = ? AND user_id = ?")
      .get(row.device_id, row.owner_id) as { show_on_trips: number } | undefined;
    if (current) showOnTrips = current.show_on_trips === 1;
  }
  if (!showOnTrips) return null;
  return {
    profile_key: snapshot.profile_key,
    model: snapshot.model,
    nickname: snapshot.nickname,
    note: snapshot.note,
  };
}

function sharedTripDto(db: AppContext["db"], row: SharedTripRow) {
  return {
    date: row.date,
    start_epoch: row.start_epoch,
    end_epoch: row.end_epoch,
    duration_sec: row.duration_sec,
    segment_count: row.segment_count,
    emer_count: row.emer_count,
    has_front: row.has_front,
    has_rear: row.has_rear,
    peak_gforce: row.peak_gforce,
    gforce_events: row.gforce_events,
    device: sharedDeviceDto(db, row),
    expires_at: row.share_expires_at,
  };
}

function parseExpiryDays(body: { expires_in_days?: number | null } | undefined):
  | { ok: true; days: number | null }
  | { ok: false } {
  const value = body?.expires_in_days;
  if (value === undefined) return { ok: true, days: DEFAULT_SHARE_DAYS };
  if (value === null) return { ok: true, days: null };
  if (!Number.isInteger(value) || value < 1 || value > MAX_SHARE_DAYS) return { ok: false };
  return { ok: true, days: value };
}

export function registerShares(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const requireUser = makeRequireUser(ctx);
  const storedSecrets = (db.prepare("SELECT COUNT(*) AS count FROM trip_share_secrets").get() as {
    count: number;
  }).count;
  initializeShareTokenVault(storedSecrets > 0);

  // 建立分享：只有旅程擁有者本人或管理員可做。trip_id 可含斜線，故使用 wildcard。
  app.post<{ Params: { "*": string }; Body: { expires_in_days?: number | null } }>(
    "/api/trip-shares/*",
    { preHandler: requireUser },
    async (req, reply) => {
      const tripId = req.params["*"];
      const trip = getTrip(db, tripId);
      if (!trip) return reply.code(404).send({ detail: "旅程不存在" });
      if (!canEditTrip(db, req.user!, trip)) {
        return reply.code(403).send({ detail: "無權分享此旅程" });
      }
      const parsed = parseExpiryDays(req.body);
      if (!parsed.ok) {
        return reply.code(400).send({ detail: `expires_in_days 須為 1 至 ${MAX_SHARE_DAYS} 的整數或 null` });
      }
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = parsed.days === null ? null : now + parsed.days * 86_400;
      const created = createTripShare(db, tripId, req.user!.id, expiresAt, now);
      return protectShareResponse(reply).code(201).send(shareLinkDto(created, now));
    },
  );

  // 列出單趟旅程的分享紀錄（不含明文 token）。
  app.get<{ Params: { "*": string } }>(
    "/api/trip-shares/*",
    { preHandler: requireUser },
    async (req, reply) => {
      const tripId = req.params["*"];
      const trip = getTrip(db, tripId);
      if (!trip) return reply.code(404).send({ detail: "旅程不存在" });
      if (!canEditTrip(db, req.user!, trip)) {
        return reply.code(403).send({ detail: "無權管理此旅程的分享" });
      }
      const now = Math.floor(Date.now() / 1000);
      return protectShareResponse(reply).send({
        shares: listTripShares(db, tripId).map((row) => shareDto(row, now)),
      });
    },
  );

  // 原地更換分享 token。非擁有者、不存在、已到期或已撤銷一律回 404。
  app.post<{ Params: { shareId: string }; Body: { token_version?: string } }>(
    "/api/trip-shares/:shareId/rotate",
    { preHandler: requireUser },
    async (req, reply) => {
      const shareId = Number(req.params.shareId);
      if (!/^[1-9]\d*$/.test(req.params.shareId) || !Number.isSafeInteger(shareId)) {
        return protectShareResponse(reply).code(404).send({ detail: "分享不存在" });
      }
      const share = getTripShare(db, shareId);
      const trip = share ? getTrip(db, share.trip_id) : null;
      if (!share || !trip || !canEditTrip(db, req.user!, trip)) {
        return protectShareResponse(reply).code(404).send({ detail: "分享不存在" });
      }
      const now = Math.floor(Date.now() / 1000);
      if (share.revoked_at !== null || (share.expires_at !== null && share.expires_at <= now)) {
        return protectShareResponse(reply).code(404).send({ detail: "分享不存在" });
      }
      if (req.body?.token_version !== share.token_hash.slice(0, 16)) {
        return protectShareResponse(reply).code(409).send({ detail: "分享連結已變更，請重新整理" });
      }
      const rotated = rotateTripShare(db, share.id, share.token_hash, now);
      if (!rotated) {
        return protectShareResponse(reply).code(409).send({ detail: "分享連結已變更，請重新整理" });
      }
      return protectShareResponse(reply).send(shareLinkDto(rotated, now));
    },
  );

  // 登入後按下複製才解密單一有效連結；列表與資料庫都不會出現明文 token。
  app.post<{ Params: { shareId: string } }>(
    "/api/trip-shares/:shareId/link",
    { preHandler: requireUser },
    async (req, reply) => {
      if (!/^[1-9]\d*$/.test(req.params.shareId)) {
        return protectShareResponse(reply).code(404).send({ detail: "分享不存在" });
      }
      const share = getTripShare(db, Number(req.params.shareId));
      const trip = share ? getTrip(db, share.trip_id) : null;
      if (!share || !trip || !canEditTrip(db, req.user!, trip)) {
        return protectShareResponse(reply).code(404).send({ detail: "分享不存在" });
      }
      const now = Math.floor(Date.now() / 1000);
      if (share.revoked_at !== null || (share.expires_at !== null && share.expires_at <= now)) {
        return protectShareResponse(reply).code(404).send({ detail: "分享不存在" });
      }
      const token = recoverTripShareToken(share);
      if (!token) {
        return protectShareResponse(reply).code(409).send({ detail: "此舊分享無法取回，請重新產生" });
      }
      return protectShareResponse(reply).send(shareLinkDto({ token, share }, now));
    },
  );

  // 依 share id 撤銷。非擁有者統一回 404，避免由流水號探測私人旅程。
  app.delete<{ Params: { shareId: string } }>(
    "/api/trip-shares/:shareId",
    { preHandler: requireUser },
    async (req, reply) => {
      if (!/^[1-9]\d*$/.test(req.params.shareId)) {
        return reply.code(404).send({ detail: "分享不存在" });
      }
      const share = getTripShare(db, Number(req.params.shareId));
      const trip = share ? getTrip(db, share.trip_id) : null;
      if (!share || !trip || !canEditTrip(db, req.user!, trip)) {
        return reply.code(404).send({ detail: "分享不存在" });
      }
      revokeTripShare(db, share.id);
      return protectShareResponse(reply).send({ status: "revoked", id: share.id });
    },
  );

  // 固定匿名分享頁。Bearer token 只存在 URL fragment，瀏覽器不會把 fragment 送到伺服器。
  app.get("/share", async (_req, reply) => {
    try {
      const html = await fsp.readFile(SHARE_PAGE);
      return protectShareResponse(reply).type("text/html; charset=utf-8").send(html);
    } catch {
      return protectShareResponse(reply).code(500).send({ detail: "分享頁暫時無法載入" });
    }
  });

  // 以 JSON body 兌換一小時 HttpOnly cookie。Cookie 永遠不超過分享本身的期限，
  // 且 Path=/share，不會被送到一般 API、登入、上傳或管理端點。
  app.post<{ Body: { token?: string } }>(
    "/api/share/access",
    {
      config: {
        rateLimit: { max: SHARE_ACCESS_RATE_MAX, timeWindow: SHARE_ACCESS_RATE_WINDOW_MS },
      },
    },
    async (req, reply) => {
      const token = typeof req.body?.token === "string" ? req.body.token : "";
      const row = getSharedTrip(db, token);
      if (!row) return invalidShare(reply);

      const now = Math.floor(Date.now() / 1000);
      const remaining = row.share_expires_at === null
        ? SHARE_COOKIE_TTL_SEC
        : Math.max(1, row.share_expires_at - now);
      const maxAge = Math.min(SHARE_COOKIE_TTL_SEC, remaining);
      protectShareResponse(reply).setCookie(SHARE_COOKIE, token, {
        httpOnly: true,
        sameSite: "strict",
        secure: COOKIE_SECURE,
        path: "/share",
        maxAge,
      });
      return reply.send({
        status: "ok",
        expires_at: row.share_expires_at,
        access_expires_at: now + maxAge,
      });
    },
  );

  // 匿名 metadata：刻意不回 trip_id、owner_id、備註、磁碟路徑、公開／編輯狀態。
  app.get("/share/metadata", async (req, reply) => {
    const row = sharedTripFromCookie(db, req);
    if (!row) return invalidShare(reply);
    recordShareAccess(db, row.share_id);
    return protectShareResponse(reply).send(sharedTripDto(db, row));
  });

  app.get<{ Params: { camera: string } }>(
    "/share/video/:camera",
    async (req, reply) => {
      const row = sharedTripFromCookie(db, req);
      if (!row) return invalidShare(reply);
      if (req.params.camera !== "front" && req.params.camera !== "rear") {
        return protectShareResponse(reply).code(400).send({ detail: "camera 必須是 front 或 rear" });
      }
      const videoPath = req.params.camera === "front" ? row.front_path : row.rear_path;
      if (!videoPath || !withinTrips(videoPath)) {
        return protectShareResponse(reply).code(404).send({ detail: "影片檔案不存在" });
      }
      try {
        await fsp.access(videoPath, fs.constants.R_OK);
      } catch {
        return protectShareResponse(reply).code(404).send({ detail: "影片檔案不存在" });
      }
      protectShareResponse(reply).header("Content-Disposition", "inline");
      return sendRange(req, reply, videoPath);
    },
  );

  app.get("/share/thumbnail", async (req, reply) => {
    const row = sharedTripFromCookie(db, req);
    if (!row) return invalidShare(reply);
    const candidates = [row.front_path, row.rear_path].filter(
      (candidate): candidate is string => !!candidate && withinTrips(candidate),
    );
    if (candidates.length === 0) {
      return protectShareResponse(reply).code(404).send({ detail: "影片檔案不存在" });
    }

    // DB 的 trip_dir 也必須在 TRIPS_DIR 內；不可信時退回已驗證影片所在目錄。
    const tripDir = row.trip_dir && withinTrips(row.trip_dir)
      ? row.trip_dir
      : path.dirname(candidates[0]!);
    const thumbPath = path.join(tripDir, "thumb.jpg");
    let ready = false;
    try {
      await fsp.access(thumbPath, fs.constants.R_OK);
      ready = true;
    } catch {
      for (const videoPath of candidates) {
        try {
          const stat = await fsp.stat(videoPath);
          if (stat.size === 0) continue;
        } catch {
          continue;
        }
        if (await extractFrame(videoPath, thumbPath)) {
          ready = true;
          break;
        }
      }
    }
    if (!ready) {
      return protectShareResponse(reply).code(404).send({ detail: "無法產生縮圖" });
    }
    try {
      const { size } = await fsp.stat(thumbPath);
      protectShareResponse(reply)
        .header("Content-Type", "image/jpeg")
        .header("Content-Length", String(size));
      return reply.send(createReadStream(thumbPath));
    } catch {
      return protectShareResponse(reply).code(404).send({ detail: "縮圖不存在" });
    }
  });
}
