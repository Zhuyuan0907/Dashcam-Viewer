/**
 * 應用程式共用情境 + 認證守衛(Fastify preHandler)。
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DB } from "./db.js";
import { SftpSessionManager } from "./sftp/sessions.js";
import { SSERegistry } from "./uploads/sse.js";
import { lookupSession, type SessionUser } from "./auth.js";
import { SettingsStore } from "./settings/store.js";
import { JobRegistry } from "./jobs.js";

export interface AppContext {
  db: DB;
  sessions: SftpSessionManager;
  sse: SSERegistry;
  settings: SettingsStore;
  /** 進行中背景工作(裁剪/匯出)的集中登記處。 */
  jobs: JobRegistry;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

/**
 * must_change_password=1 的帳號在改密碼前仍可存取的 API 白名單(其餘一律 403)。
 * 讓「首次強制改密碼」在伺服器端真正生效,而非僅靠前端導向。
 */
const MUST_CHANGE_ALLOW = new Set([
  "/api/account/first-password",
  "/api/auth/logout",
  "/api/auth/me",
]);

/** 從 cookie 取出登入使用者;未登入丟 401。回傳 reply 表示已短路回應。 */
export function makeRequireUser(ctx: AppContext) {
  return async function requireUser(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    const token = req.cookies?.session_token;
    const user = lookupSession(ctx.db, token);
    if (!user) {
      return reply.code(401).send({ detail: "未登入或 Session 已過期" });
    }
    // 伺服器端強制首次改密碼:未改密碼前,除白名單外一律 403(session 形同「只能改密碼」)。
    if (user.must_change_password && !MUST_CHANGE_ALLOW.has(req.routeOptions?.url ?? req.url)) {
      return reply.code(403).send({ detail: "請先變更密碼", must_change_password: 1 });
    }
    req.user = user;
    return undefined;
  };
}

/** 要求管理員;非 admin 丟 403。 */
export function makeRequireAdmin(ctx: AppContext) {
  const requireUser = makeRequireUser(ctx);
  return async function requireAdmin(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    const r = await requireUser(req, reply);
    if (r) return r; // 已被 requireUser 回應(401)
    if (req.user!.role !== "admin") {
      return reply.code(403).send({ detail: "需要管理員權限" });
    }
    return undefined;
  };
}

/** 要求總管理員(擁有者);非 owner 丟 403。 */
export function makeRequireOwner(ctx: AppContext) {
  const requireUser = makeRequireUser(ctx);
  return async function requireOwner(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    const r = await requireUser(req, reply);
    if (r) return r;
    if (!req.user!.is_owner) {
      return reply.code(403).send({ detail: "需要總管理員權限" });
    }
    return undefined;
  };
}
