import crypto from "node:crypto";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { makeRequireUser, makeRequireOwner, type AppContext } from "../context.js";
import { YoutubeService, type UploadRow } from "../youtube/service.js";
import { getTrip } from "../trips/repo.js";
import { PARAMETERS, variables, metadata } from "../youtube/templates.js";
import { sendRange } from "./video.js";

const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`數值須為 ${min}–${max} 的整數`);
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new Error("文字欄位格式或長度不正確");
  return value;
}
function dto(row: UploadRow) {
  return {
    id: row.id,
    trip_id: row.trip_id,
    camera: row.camera,
    date: row.date,
    trip_no: row.trip_no,
    title: row.title,
    description: row.description,
    privacy: row.privacy,
    made_for_kids: !!row.made_for_kids,
    status: row.status,
    source_size: row.source_size,
    uploaded_bytes: row.uploaded_bytes,
    progress: Math.round((row.uploaded_bytes / row.source_size) * 100),
    message: row.message,
    not_before: row.not_before,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    verified_at: row.verified_at,
    transfer_complete: !!row.video_id && row.uploaded_bytes >= row.source_size,
    can_restart: !!row.upload_secret || !!row.video_id,
    video_url: row.video_id ? `https://www.youtube.com/watch?v=${row.video_id}` : null,
    studio_url: row.video_id ? `https://studio.youtube.com/video/${row.video_id}/edit` : null,
    youtube: row.yt_synced_at
      ? {
          title: row.yt_title ?? null,
          privacy: row.yt_privacy ?? null,
          upload_status: row.yt_upload_status ?? null,
          views: row.yt_views ?? null,
          comments: row.yt_comments ?? null,
          likes: row.yt_likes ?? null,
          missing: !!row.yt_missing,
          synced_at: row.yt_synced_at,
        }
      : null,
  };
}
export function registerYoutube(app: FastifyInstance, ctx: AppContext): void {
  const service = (ctx.youtube ??= new YoutubeService(ctx));
  const requireUser = makeRequireUser(ctx),
    requireOwner = makeRequireOwner(ctx);
  // No cross-origin cookie-authenticated writes. OAuth callback is a bound, single-use GET.
  const sameOrigin = async (req: FastifyRequest) => {
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host === req.host) return;
      } catch {}
      throw Object.assign(new Error("不接受跨站請求"), { statusCode: 403 });
    }
  };
  const write = { preHandler: [requireUser, sameOrigin] };
  const protect = { preHandler: requireUser };
  const guard = (fn: (req: any) => Promise<unknown> | unknown) => async (req: any, reply: any) => {
    reply.header("Cache-Control", "no-store");
    try {
      return await fn(req);
    } catch (error) {
      return reply.code(400).send({
        detail:
          error instanceof Error && !/https?:|ENOENT|EACCES/.test(error.message)
            ? error.message
            : "操作失敗，請確認資料與授權設定",
      });
    }
  };
  const owned = (req: any) => {
    const row = service.get(Number(req.params.id));
    if (!row || row.user_id !== req.user.id) throw new Error("找不到自己的上傳紀錄");
    return row;
  };
  app.addHook("onReady", () => service.start());
  app.addHook("onClose", () => service.stop());
  app.get(
    "/api/youtube/account",
    protect,
    guard((req) => {
      const account = service.account(req.user.id),
        config = service.config();
      return {
        configured: !!config,
        defaults: service.defaults(),
        parameters: PARAMETERS,
        account: account
          ? {
              channel_title: account.channel_title,
              channel_id: account.channel_id,
              paused: !!account.paused,
              daily_limit: account.daily_limit,
              blocked_until: account.blocked_until,
              ...service.allowance(account, config?.project_daily_limit ?? 100),
            }
          : null,
      };
    }),
  );
  app.get(
    "/api/youtube/config",
    { preHandler: requireOwner },
    guard(() => {
      const config = service.config();
      return {
        configured: !!config,
        client_id: config?.client_id ?? "",
        redirect_uri: config?.redirect_uri ?? "",
        project_daily_limit: config?.project_daily_limit ?? 100,
        has_secret: !!config?.client_secret,
      };
    }),
  );
  app.put(
    "/api/youtube/config",
    { preHandler: [requireOwner, sameOrigin] },
    guard((req) => {
      const body = req.body ?? {},
        existing = service.config();
      const client_id = text(body.client_id, 300).trim();
      const client_secret = body.client_secret
        ? text(body.client_secret, 500)
        : (existing?.client_secret ?? "");
      const redirect_uri = text(body.redirect_uri, 500).trim();
      const parsed = new URL(redirect_uri);
      if (!client_id.endsWith(".apps.googleusercontent.com") || !client_secret)
        throw new Error("請提供 Google OAuth 網頁應用程式的 Client ID 與 Client Secret");
      if (
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        parsed.pathname !== "/api/youtube/callback" ||
        (parsed.protocol !== "https:" &&
          !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname)))
      )
        throw new Error("回呼網址必須為 HTTPS 網址加 /api/youtube/callback");
      service.setConfig({
        client_id,
        client_secret,
        redirect_uri,
        project_daily_limit: integer(body.project_daily_limit ?? 100, 1, 100000),
      });
      return { status: "saved" };
    }),
  );
  app.post(
    "/api/youtube/connect",
    write,
    guard((req) => {
      if (req.body?.accept_policy !== true)
        throw new Error("請先同意 YouTube 功能的使用條款與隱私說明");
      const config = service.config();
      if (!config) throw new Error("請由站台擁有者先設定 Google OAuth");
      const state = crypto.randomBytes(32).toString("base64url"),
        verifier = crypto.randomBytes(32).toString("base64url");
      ctx.db
        .prepare("DELETE FROM youtube_states WHERE expires_at<? OR user_id=?")
        .run(Date.now(), req.user.id);
      ctx.db
        .prepare(
          "INSERT INTO youtube_states(state_hash,user_id,session_hash,verifier_secret,expires_at) VALUES(?,?,?,?,?)",
        )
        .run(
          hash(state),
          req.user.id,
          hash(req.cookies.session_token),
          service.vault.seal(verifier, `youtube:state:${hash(state)}`),
          Date.now() + 600_000,
        );
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: config.client_id,
        redirect_uri: config.redirect_uri,
        response_type: "code",
        scope:
          "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl",
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      }).toString();
      return { url: url.toString() };
    }),
  );
  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>(
    "/api/youtube/callback",
    protect,
    async (req, reply) => {
      reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const entry = ctx.db
        .prepare(
          "SELECT * FROM youtube_states WHERE state_hash=? AND user_id=? AND session_hash=? AND expires_at>?",
        )
        .get(hash(state), req.user!.id, hash(req.cookies.session_token ?? ""), Date.now()) as
        | { verifier_secret: string }
        | undefined;
      if (!entry)
        return reply.code(400).send({ detail: "授權要求已過期或不屬於此登入，請重新連結" });
      ctx.db.prepare("DELETE FROM youtube_states WHERE state_hash=?").run(hash(state));
      if (req.query.error || !req.query.code)
        return reply.redirect("/youtube?oauth=cancelled", 303);
      try {
        const config = service.config();
        if (!config) throw new Error("OAuth 未設定");
        const tokens = await service.api.tokens(config, {
          grant_type: "authorization_code",
          code: req.query.code,
          redirect_uri: config.redirect_uri,
          code_verifier: service.vault.open<string>(
            entry.verifier_secret,
            `youtube:state:${hash(state)}`,
          ),
        });
        await service.connect(req.user!.id, tokens);
        return reply.redirect("/youtube?oauth=connected", 303);
      } catch {
        return reply.redirect("/youtube?oauth=failed", 303);
      }
    },
  );
  app.delete(
    "/api/youtube/account",
    write,
    guard(async (req) => ({
      status: "disconnected",
      revoked: await service.disconnect(req.user.id),
    })),
  );
  app.patch(
    "/api/youtube/account",
    write,
    guard((req) => {
      if (!service.account(req.user.id)) throw new Error("尚未連結 YouTube");
      if (req.body?.daily_limit !== undefined)
        service.setDailyLimit(req.user.id, integer(req.body.daily_limit, 1, 1000));
      if (req.body?.paused !== undefined) {
        if (typeof req.body.paused !== "boolean") throw new Error("paused 格式不正確");
        service.pause(req.user.id, req.body.paused);
      }
      return { status: "saved" };
    }),
  );
  app.post(
    "/api/youtube/preview",
    write,
    guard(async (req) => {
      const row = getTrip(ctx.db, text(req.body?.trip_id, 1000));
      if (!row || row.owner_id !== req.user.id) throw new Error("只能預覽自己的旅程");
      const camera = req.body?.camera === "rear" ? "rear" : "front";
      const source = await service.source(row, camera);
      return metadata(
        text(req.body?.title_template, 2000),
        text(req.body?.description_template, 10000),
        variables(row, camera, path.basename(source.file)),
      );
    }),
  );
  app.post(
    "/api/youtube/uploads",
    write,
    guard(async (req) => {
      const body = req.body ?? {};
      if (
        !Array.isArray(body.trip_ids) ||
        !body.trip_ids.length ||
        body.trip_ids.length > 500 ||
        !body.trip_ids.every((v: unknown) => typeof v === "string" && v.length < 1000)
      )
        throw new Error("請選擇 1–500 趟旅程");
      if (
        !["both", "front", "rear"].includes(body.camera) ||
        !["private", "unlisted", "public"].includes(body.privacy) ||
        typeof body.made_for_kids !== "boolean"
      )
        throw new Error("鏡頭、隱私或兒童內容設定不正確");
      const not_before =
        body.not_before === undefined
          ? Date.now()
          : integer(body.not_before, 0, Date.now() + 366 * 86_400_000);
      return service.enqueue(req.user.id, body.trip_ids, {
        camera: body.camera,
        privacy: body.privacy,
        made_for_kids: body.made_for_kids,
        not_before: Math.max(Date.now(), not_before),
        title_template: text(body.title_template, 2000),
        description_template: text(body.description_template, 10000),
        pair: body.pair !== false,
      });
    }),
  );
  app.get<{ Querystring: { page?: string; limit?: string; filter?: string } }>(
    "/api/youtube/uploads",
    protect,
    guard((req) => {
      const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1));
      const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 6));
      const archive = req.query.filter === "archive";
      const condition = archive ? " AND video_id IS NOT NULL" : "";
      const total = (
        ctx.db
          .prepare(`SELECT COUNT(*) AS n FROM youtube_uploads WHERE user_id=?${condition}`)
          .get(req.user.id) as { n: number }
      ).n;
      const rows = ctx.db
        .prepare(
          `SELECT * FROM youtube_uploads WHERE user_id=?${condition} ORDER BY id DESC LIMIT ? OFFSET ?`,
        )
        .all(req.user.id, limit, (page - 1) * limit) as UploadRow[];
      const counts = ctx.db
        .prepare("SELECT status,COUNT(*) AS n FROM youtube_uploads WHERE user_id=? GROUP BY status")
        .all(req.user.id);
      const transferred = (
        ctx.db
          .prepare(
            "SELECT COUNT(*) AS n FROM youtube_uploads WHERE user_id=? AND video_id IS NOT NULL AND uploaded_bytes>=source_size AND status!='cancelled' AND yt_missing=0",
          )
          .get(req.user.id) as { n: number }
      ).n;
      const pairs = service.pairFor(req.user.id, [...new Set(rows.map((r) => r.trip_id))]);
      return {
        uploads: rows.map((row) => {
          const pair = pairs.get(row.trip_id);
          return {
            ...dto(row),
            playlist_url: pair?.playlist_id
              ? `https://www.youtube.com/playlist?list=${pair.playlist_id}`
              : null,
            pair_status: pair ? (pair.done_at ? "done" : pair.failed ? "failed" : "pending") : null,
            pair_message: pair?.message ?? null,
          };
        }),
        total,
        counts,
        transferred,
        page,
        limit,
      };
    }),
  );
  // 精靈選旅程時標示「已上傳／上傳中」：每趟每個鏡頭最新一筆（不含已取消）的狀態。
  app.get<{ Querystring: { ids?: string } }>(
    "/api/youtube/trip-status",
    protect,
    guard((req) => {
      const ids = (typeof req.query.ids === "string" ? req.query.ids.split("\n") : [])
        .filter((id: string) => id && id.length < 1000)
        .slice(0, 50);
      const out: Record<string, Record<string, string>> = {};
      if (!ids.length) return { trips: out };
      const rows = ctx.db
        .prepare(
          `SELECT trip_id,camera,status,yt_missing FROM youtube_uploads WHERE id IN (
             SELECT MAX(id) FROM youtube_uploads WHERE user_id=? AND status!='cancelled'
             AND trip_id IN (${ids.map(() => "?").join(",")}) GROUP BY trip_id,camera)`,
        )
        .all(req.user.id, ...ids) as Array<{
        trip_id: string;
        camera: string;
        status: string;
        yt_missing: number;
      }>;
      for (const r of rows) (out[r.trip_id] ??= {})[r.camera] = r.yt_missing ? "missing" : r.status;
      return { trips: out };
    }),
  );
  app.get(
    "/api/youtube/uploads/:id",
    protect,
    guard((req) => {
      const row = owned(req),
        page = Math.max(1, Number(req.query.page) || 1),
        limit = 8;
      const total = (
        ctx.db
          .prepare("SELECT COUNT(*) AS n FROM youtube_events WHERE upload_id=?")
          .get(row.id) as { n: number }
      ).n;
      const events = ctx.db
        .prepare(
          "SELECT id,stage,message,bytes,created_at FROM youtube_events WHERE upload_id=? ORDER BY id DESC LIMIT ? OFFSET ?",
        )
        .all(row.id, limit, (page - 1) * limit);
      return { upload: dto(row), events, total, page, limit };
    }),
  );
  app.post(
    "/api/youtube/uploads/:id/test",
    write,
    guard(async (req) => {
      const row = owned(req);
      return { upload: dto(await service.runOne(req.user.id, row.id)) };
    }),
  );
  app.post(
    "/api/youtube/uploads/:id/retry",
    write,
    guard((req) => {
      const row = owned(req);
      service.retry(row.id, req.body?.restart_confirmed === true);
      return { status: "queued" };
    }),
  );
  app.post(
    "/api/youtube/uploads/:id/cancel",
    write,
    guard(async (req) => {
      await service.cancel(owned(req).id);
      return { status: "cancelled" };
    }),
  );
  app.post(
    "/api/youtube/uploads/:id/verify",
    write,
    guard(async (req) => {
      const row = owned(req);
      if (!row.video_id) throw new Error("尚未完成傳輸");
      return { ready: await service.verify(row) };
    }),
  );
  // 與 YouTube 同步：讀回已上傳影片目前的標題、可見性、觀看數，及是否已在 YouTube 刪除。
  app.post(
    "/api/youtube/sync",
    write,
    guard(async (req) => service.sync(req.user.id)),
  );
  app.post(
    "/api/youtube/cleanup",
    write,
    guard(async (req) => {
      const ids = req.body?.trip_ids;
      if (
        req.body?.confirm_delete !== true ||
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 100 ||
        !ids.every((id: unknown) => typeof id === "string")
      )
        throw new Error("必須明確確認要清理的本機旅程");
      const results: Array<{ trip_id: string; deleted: boolean; detail?: string }> = [];
      for (const id of [...new Set(ids)] as string[]) {
        try {
          await service.cleanup(req.user.id, id);
          results.push({ trip_id: id, deleted: true });
        } catch (error) {
          results.push({
            trip_id: id,
            deleted: false,
            detail:
              error instanceof Error && !/ENOENT|EACCES|https?:/.test(error.message)
                ? error.message
                : "本機清理失敗，請檢查紀錄",
          });
        }
      }
      return { results };
    }),
  );
  app.get<{ Params: { id: string } }>(
    "/api/youtube/uploads/:id/download",
    protect,
    async (req, reply) => {
      const uploaded = service.get(Number(req.params.id));
      if (!uploaded || uploaded.user_id !== req.user!.id)
        return reply.code(404).send({ detail: "找不到影片" });
      const current = getTrip(ctx.db, uploaded.trip_id);
      if (!current || current.owner_id !== req.user!.id || uploaded.deleted_at)
        return reply.code(410).send({
          detail:
            "本機原檔已清理；請使用 YouTube Studio 或 Google Takeout 匯出，畫質由 YouTube 提供",
        });
      try {
        const source = await service.source(current, uploaded.camera);
        if (
          source.file !== uploaded.source_path ||
          source.size !== uploaded.source_size ||
          source.mtime !== uploaded.source_mtime
        )
          return reply.code(409).send({ detail: "本機影片已變更，請從旅程頁下載目前版本" });
        reply
          .header(
            "Content-Disposition",
            `attachment; filename="dashcam-${uploaded.date}-${uploaded.trip_no}-${uploaded.camera}.mp4"`,
          )
          .header("Cache-Control", "no-store");
        return sendRange(req, reply, source.file);
      } catch {
        return reply.code(404).send({ detail: "本機影片不存在" });
      }
    },
  );
}
