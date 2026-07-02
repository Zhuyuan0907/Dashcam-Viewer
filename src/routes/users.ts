/**
 * 使用者管理 API(僅限管理員)。
 */
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../auth.js";
import { effectiveGravatar } from "../gravatar.js";
import { makeRequireAdmin, makeRequireOwner, type AppContext } from "../context.js";

interface UserBody {
  username?: string;
  password?: string;
  role?: string;
  email?: string;
}

export function registerUsers(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const requireAdmin = makeRequireAdmin(ctx);
  const requireOwner = makeRequireOwner(ctx);

  /** 取得目標使用者的 role / is_owner;不存在回 null。 */
  function getTarget(id: number): { role: string; is_owner: number } | null {
    return (
      (db.prepare("SELECT role, is_owner FROM users WHERE id = ?").get(id) as
        | { role: string; is_owner: number }
        | undefined) ?? null
    );
  }

  app.get("/api/users", { preHandler: requireAdmin }, async () => {
    const rows = db
      .prepare(
        "SELECT id, username, role, email, created_at, upload_idle_sec, is_owner, display_name FROM users ORDER BY id",
      )
      .all() as Array<{
      id: number;
      username: string;
      role: string;
      email: string;
      created_at: number;
      upload_idle_sec: number | null;
      is_owner: number;
      display_name: string | null;
    }>;
    return rows.map((r) => ({ ...r, gravatar_url: effectiveGravatar(r) }));
  });

  app.post("/api/users", { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as UserBody;
    const username = (body.username ?? "").trim();
    const password = body.password ?? "";
    const role = body.role ?? "viewer";
    const email = (body.email ?? "").trim().toLowerCase();

    if (username.length < 2) return reply.code(400).send({ detail: "帳號至少 2 個字元" });
    if (password.length < 6) return reply.code(400).send({ detail: "密碼至少 6 個字元" });
    if (role !== "admin" && role !== "viewer") return reply.code(400).send({ detail: "角色須為 admin 或 viewer" });
    // 只有總管理員能授予管理員角色。
    if (role === "admin" && !req.user!.is_owner) {
      return reply.code(403).send({ detail: "只有總管理員能新增管理員" });
    }

    try {
      db.prepare(
        "INSERT INTO users (username, password_hash, role, email, created_at) VALUES (?,?,?,?,?)",
      ).run(username, hashPassword(password), role, email, Math.floor(Date.now() / 1000));
    } catch (e) {
      if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        return reply.code(400).send({ detail: "帳號已存在" });
      }
      throw e;
    }
    return { status: "ok", username, role };
  });

  app.delete<{ Params: { id: string } }>(
    "/api/users/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const userId = Number.parseInt(req.params.id, 10);
      if (userId === req.user!.id) return reply.code(400).send({ detail: "不能刪除自己的帳號" });
      const target = getTarget(userId);
      if (!target) return reply.code(404).send({ detail: "使用者不存在" });
      // 總管理員帳號受保護,任何人都不能刪除。
      if (target.is_owner) return reply.code(403).send({ detail: "無法刪除總管理員帳號" });
      // 只有總管理員能刪除其他管理員。
      if (target.role === "admin" && !req.user!.is_owner) {
        return reply.code(403).send({ detail: "只有總管理員能刪除管理員" });
      }
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
      return { status: "ok" };
    },
  );

  // 變更使用者角色(admin ↔ viewer):僅總管理員。總管理員本身不可被降級。
  app.put<{ Params: { id: string }; Body: { role?: string } }>(
    "/api/users/:id/role",
    { preHandler: requireOwner },
    async (req, reply) => {
      const userId = Number.parseInt(req.params.id, 10);
      const role = req.body?.role;
      if (role !== "admin" && role !== "viewer") {
        return reply.code(400).send({ detail: "角色須為 admin 或 viewer" });
      }
      const target = getTarget(userId);
      if (!target) return reply.code(404).send({ detail: "使用者不存在" });
      if (target.is_owner) return reply.code(403).send({ detail: "無法變更總管理員的角色" });
      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
      return { status: "ok", id: userId, role };
    },
  );

  // 逐帳號設定上傳工作階段 idle 逾時:null=依角色預設(admin 不限)、0=不限、其他=秒(60..86400)。
  app.put<{ Params: { id: string }; Body: { seconds?: number | null } }>(
    "/api/users/:id/upload-idle",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const raw = req.body?.seconds;
      let value: number | null;
      if (raw === null || raw === undefined) {
        value = null;
      } else {
        const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
        if (!Number.isInteger(n) || n < 0 || n > 86400) {
          return reply.code(400).send({ detail: "秒數需為 0(不限)或 60–86400,或留空用角色預設" });
        }
        if (n !== 0 && n < 60) {
          return reply.code(400).send({ detail: "有限時間至少 60 秒(或填 0 表示不限)" });
        }
        value = n;
      }
      db.prepare("UPDATE users SET upload_idle_sec = ? WHERE id = ?").run(
        value,
        Number.parseInt(req.params.id, 10),
      );
      return { status: "ok", upload_idle_sec: value };
    },
  );

  app.post<{ Params: { id: string }; Body: { password?: string } }>(
    "/api/users/:id/password",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const password = req.body?.password ?? "";
      if (password.length < 6) return reply.code(400).send({ detail: "密碼至少 6 個字元" });
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
        hashPassword(password),
        Number.parseInt(req.params.id, 10),
      );
      return { status: "ok" };
    },
  );
}
