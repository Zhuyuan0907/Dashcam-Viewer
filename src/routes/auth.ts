/**
 * 認證 API:首次設定、登入、登出、查詢自己。
 */
import type { FastifyInstance } from "fastify";
import { COOKIE_SECURE, SESSION_TTL, LOGIN_RATE_MAX, LOGIN_RATE_WINDOW_MS } from "../config.js";
import {
  hashPasswordAsync,
  verifyPasswordAsync,
  newSessionToken,
  lookupSession,
  DUMMY_PASSWORD_HASH,
} from "../auth.js";
import { effectiveGravatar } from "../gravatar.js";
import { defaultDevice } from "../devices/repo.js";
import type { AppContext } from "../context.js";

interface Credentials {
  username?: string;
  password?: string;
  email?: string;
}

export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.post(
    "/api/setup",
    // 與登入同等的速率限制:setup 是唯一未認證即可寫入的端點。
    { config: { rateLimit: { max: LOGIN_RATE_MAX, timeWindow: LOGIN_RATE_WINDOW_MS } } },
    async (req, reply) => {
      const c = (db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
      if (c > 0) return reply.code(400).send({ detail: "已有帳號存在,請從登入頁進入" });

      const body = (req.body ?? {}) as Credentials;
      const username = (body.username ?? "").trim();
      const password = body.password ?? "";
      const email = (body.email ?? "").trim().toLowerCase();

      if (username.length < 2) return reply.code(400).send({ detail: "帳號至少 2 個字元" });
      if (password.length < 6) return reply.code(400).send({ detail: "密碼至少 6 個字元" });

      // 首位帳號即總管理員(is_owner):否則全新安裝永遠沒有 owner,
      // 「僅總管理員」的操作(授予/降級管理員、刪管理員)全部無人能執行。
      // INSERT ... WHERE NOT EXISTS:上面的 count 檢查與這裡之間隔著 PBKDF2 的 await,
      // 兩個並發 setup 都可能通過檢查 —— 由這條原子語句做最終把關。
      const hash = await hashPasswordAsync(password);
      const info = db
        .prepare(
          `INSERT INTO users (username, password_hash, role, email, created_at, is_owner)
           SELECT ?, ?, 'admin', ?, ?, 1
           WHERE NOT EXISTS (SELECT 1 FROM users)`,
        )
        .run(username, hash, email, Math.floor(Date.now() / 1000));
      if (info.changes === 0) {
        return reply.code(400).send({ detail: "已有帳號存在,請從登入頁進入" });
      }

      return { status: "ok", message: `管理員帳號 ${username} 建立完成` };
    },
  );

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
        .prepare(
          "SELECT id, username, password_hash, role, email, must_change_password FROM users WHERE username = ?",
        )
        .get(username) as
        | {
            id: number;
            username: string;
            password_hash: string;
            role: string;
            email: string;
            must_change_password: number;
          }
        | undefined;

      // 無密碼帳號(password_hash 為空):以空白密碼登入,登入後由前端導到強制改密碼頁。
      // 一律執行一次 PBKDF2(帳號不存在/無密碼帳號時比對假雜湊)以消除「帳號是否存在」的
      // 登入計時側通道(否則存在者慢、不存在者快 → 可用回應時間列舉有效帳號)。
      let ok = false;
      if (user && user.password_hash) {
        ok = await verifyPasswordAsync(password, user.password_hash);
      } else {
        await verifyPasswordAsync(password, DUMMY_PASSWORD_HASH);
        ok = !!user && password === ""; // 無密碼帳號仍允許空白密碼登入(首次改密碼流程)
      }
      if (!user || !ok) {
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
        must_change_password: user.must_change_password ? 1 : 0,
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
        "SELECT email, pref_camera, pref_speed, pref_theme, device_note, trips_public, must_change_password FROM users WHERE id = ?",
      )
      .get(u.id) as
      | {
          email: string;
          pref_camera: string | null;
          pref_speed: number | null;
          pref_theme: string | null;
          device_note: string | null;
          trips_public: number | null;
          must_change_password: number | null;
        }
      | undefined;
    const device = defaultDevice(db, u.id);
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
        // 舊前端相容欄位;新 UI 透過 /api/account/devices 管理完整清單。
        device_note: device
          ? [device.model, device.note].filter(Boolean).join(" - ")
          : (p?.device_note ?? ""),
        trips_public: p?.trips_public ? 1 : 0,
        is_owner: u.is_owner ? 1 : 0,
        display_name: u.display_name ?? "",
        must_change_password: p?.must_change_password ? 1 : 0,
      },
    };
  });
}
