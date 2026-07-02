/**
 * 應用程式共用情境 + 認證守衛(Fastify preHandler)。
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DB } from "./db.js";
import { SftpSessionManager } from "./sftp/sessions.js";
import { SSERegistry } from "./uploads/sse.js";
import { lookupSession, type SessionUser } from "./auth.js";
import { SettingsStore } from "./settings/store.js";

export interface AppContext {
  db: DB;
  sessions: SftpSessionManager;
  sse: SSERegistry;
  settings: SettingsStore;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

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
