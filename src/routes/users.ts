/**
 * 使用者管理 API(僅限管理員)。
 */
import type { FastifyInstance } from "fastify";
import { hashPasswordAsync } from "../auth.js";
import { effectiveGravatar } from "../gravatar.js";
import { makeRequireAdmin, makeRequireOwner, type AppContext } from "../context.js";

interface UserBody {
  username?: string;
  password?: string;
  role?: string;
  email?: string;
  must_change_password?: boolean;
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
    // 勾選「首次登入須改密碼」→ 密碼可留空(建成無密碼帳號,首次以空白密碼登入後強制改)。
    const requireChange = !!body.must_change_password;

    if (username.length < 2) return reply.code(400).send({ detail: "帳號至少 2 個字元" });
    if (requireChange) {
      // 留空 = 無密碼;有填則仍須至少 6 個字元。
      if (password !== "" && password.length < 6) {
        return reply.code(400).send({ detail: "密碼至少 6 個字元(或留空,首次登入時再設定)" });
      }
    } else if (password.length < 6) {
      return reply.code(400).send({ detail: "密碼至少 6 個字元" });
    }
    if (role !== "admin" && role !== "viewer") return reply.code(400).send({ detail: "角色須為 admin 或 viewer" });
    // 只有總管理員能授予管理員角色。
    if (role === "admin" && !req.user!.is_owner) {
      return reply.code(403).send({ detail: "只有總管理員能新增管理員" });
    }

    // 無密碼帳號存空字串 hash;verifyPassword 對空字串一律 false,登入端另行放行空白密碼。
    const passwordHash = password === "" ? "" : await hashPasswordAsync(password);
    try {
      db.prepare(
        "INSERT INTO users (username, password_hash, role, email, created_at, must_change_password) VALUES (?,?,?,?,?,?)",
      ).run(username, passwordHash, role, email, Math.floor(Date.now() / 1000), requireChange ? 1 : 0);
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
      const tripCount = (
        db.prepare("SELECT COUNT(*) AS count FROM trips WHERE owner_id = ?").get(userId) as { count: number }
      ).count;
      if (tripCount > 0) {
        return reply.code(409).send({
          detail: `此帳號仍有 ${tripCount} 趟旅程，請先處理旅程歸屬後再刪除`,
          trip_count: tripCount,
        });
      }
      if (ctx.jobs.hasOwnerProcess(userId)) {
        return reply.code(409).send({ detail: "此帳號仍有事件素材正在重試，請等待重試完成後再刪除" });
      }
      const revoked = await ctx.sessions.beginRevokeForUser(userId);
      if (!revoked.ok) {
        return reply.code(409).send({ detail: "此帳號仍有傳輸或影片處理工作，請先完成或取消後再刪除" });
      }
      try {
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
        return { status: "ok", revoked_upload_sessions: revoked.removed };
      } finally {
        ctx.sessions.finishRevokeForUser(userId);
      }
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
      if (!getTarget(Number.parseInt(req.params.id, 10))) {
        return reply.code(404).send({ detail: "使用者不存在" });
      }
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
      const userId = Number.parseInt(req.params.id, 10);
      const target = getTarget(userId);
      if (!target) return reply.code(404).send({ detail: "使用者不存在" });
      // 與刪除 / 改角色相同的保護:非本人不得重設總管理員密碼(否則可竄改後登入接管、提權);
      // 非總管理員不得重設其他管理員密碼(避免橫向奪取 admin 帳號)。
      if (target.is_owner && userId !== req.user!.id) {
        return reply.code(403).send({ detail: "無法重設總管理員的密碼" });
      }
      if (target.role === "admin" && !target.is_owner && !req.user!.is_owner && userId !== req.user!.id) {
        return reply.code(403).send({ detail: "只有總管理員能重設其他管理員的密碼" });
      }
      const password = req.body?.password ?? "";
      if (password.length < 6) return reply.code(400).send({ detail: "密碼至少 6 個字元" });
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
        await hashPasswordAsync(password),
        userId,
      );
      // 重設密碼的意義通常是「奪回帳號控制權」:撤銷該帳號所有既有登入 session,
      // 否則舊裝置(或已入侵者)的 session 會繼續有效。自己重設自己時保留目前這個 session。
      const cur = req.cookies?.session_token ?? "";
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(userId, cur);
      return { status: "ok" };
    },
  );
}
