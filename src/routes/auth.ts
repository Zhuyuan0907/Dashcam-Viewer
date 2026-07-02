/**
 * 認證 API:首次設定、登入、登出、查詢自己。
 */
import type { FastifyInstance } from "fastify";
import { COOKIE_SECURE, SESSION_TTL, LOGIN_RATE_MAX, LOGIN_RATE_WINDOW_MS } from "../config.js";
import { hashPassword, verifyPassword, newSessionToken, lookupSession } from "../auth.js";
import { effectiveGravatar } from "../gravatar.js";
import type { AppContext } from "../context.js";

interface Credentials {
  username?: string;
  password?: string;
  email?: string;
}

export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.post("/api/setup", async (req, reply) => {
    const c = (db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
    if (c > 0) return reply.code(400).send({ detail: "已有帳號存在,請從登入頁進入" });

    const body = (req.body ?? {}) as Credentials;
    const username = (body.username ?? "").trim();
    const password = body.password ?? "";
    const email = (body.email ?? "").trim().toLowerCase();

    if (username.length < 2) return reply.code(400).send({ detail: "帳號至少 2 個字元" });
    if (password.length < 6) return reply.code(400).send({ detail: "密碼至少 6 個字元" });

    db.prepare(
      "INSERT INTO users (username, password_hash, role, email, created_at) VALUES (?,?,?,?,?)",
    ).run(username, hashPassword(password), "admin", email, Math.floor(Date.now() / 1000));

    return { status: "ok", message: `管理員帳號 ${username} 建立完成` };
  });

  app.post(
    "/api/auth/login",
    {
      config: {
        rateLimit: { max: LOGIN_RATE_MAX, timeWindow: LOGIN_RATE_WINDOW_MS },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as Credentials;
      const username = (body.username ?? "").trim();
      const password = body.password ?? "";

      const user = db
        .prepare("SELECT id, username, password_hash, role, email FROM users WHERE username = ?")
        .get(username) as
        | { id: number; username: string; password_hash: string; role: string; email: string }
        | undefined;

      if (!user || !verifyPassword(password, user.password_hash)) {
        return reply.code(400).send({ detail: "帳號或密碼錯誤" });
      }

      const token = newSessionToken();
      const now = Math.floor(Date.now() / 1000);
      db.prepare(
        "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)",
      ).run(token, user.id, now, now + SESSION_TTL);

      reply.setCookie("session_token", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: COOKIE_SECURE,
        maxAge: SESSION_TTL,
        path: "/",
      });
      return {
        username: user.username,
        role: user.role,
        gravatar_url: effectiveGravatar(user),
      };
    },
  );

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies?.session_token;
    if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    reply.clearCookie("session_token", { path: "/" });
    return { status: "ok" };
  });

  // 查詢自己:未登入屬正常狀態(如登入頁),回 200 { user: null } 而非噴 401。
  app.get("/api/auth/me", async (req) => {
    const u = lookupSession(db, req.cookies?.session_token);
    if (!u) return { user: null };
    // 個人偏好欄位 lookupSession 不載入,這裡補一次查詢(供前端主題/看片偏好使用)。
    const p = db
      .prepare(
        "SELECT email, pref_camera, pref_speed, pref_theme, device_note, trips_public FROM users WHERE id = ?",
      )
      .get(u.id) as
      | {
          email: string;
          pref_camera: string | null;
          pref_speed: number | null;
          pref_theme: string | null;
          device_note: string | null;
          trips_public: number | null;
        }
      | undefined;
    return {
      user: {
        id: u.id,
        username: u.username,
        role: u.role,
        email: p?.email ?? "",
        gravatar_url: effectiveGravatar({ email: p?.email, username: u.username }),
        pref_camera: p?.pref_camera ?? null,
        pref_speed: p?.pref_speed ?? null,
        pref_theme: p?.pref_theme ?? null,
        device_note: p?.device_note ?? "",
        trips_public: p?.trips_public ? 1 : 0,
        is_owner: u.is_owner ? 1 : 0,
        display_name: u.display_name ?? "",
      },
    };
  });
}
