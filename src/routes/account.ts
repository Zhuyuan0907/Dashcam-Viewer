/**
 * 個人設定 API(self-service,僅需登入)。
 *
 * 與 routes/users.ts(管理員專用)分離:這裡操作的一律是「自己」(req.user.id),
 * 改密碼必須驗證目前密碼。供 static/account.html 使用。
 *   PUT  /api/account/profile   { email, device_note }
 *   PUT  /api/account/prefs     { camera?, speed?, theme? }   ← 部分更新,null=清除/跟隨全域
 *   POST /api/account/password  { current, next }             ← 驗證目前密碼,並登出其他裝置
 */
import type { FastifyInstance } from "fastify";
import { hashPassword, verifyPassword } from "../auth.js";
import { effectiveGravatar } from "../gravatar.js";
import { makeRequireUser, type AppContext } from "../context.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SPEEDS = [1, 1.5, 2];

export function registerAccount(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const requireUser = makeRequireUser(ctx);

  // 個人資料:Email(影響頭像)+「使用的行車記錄器」自由文字。
  app.put<{ Body: { email?: string; device_note?: string; display_name?: string } }>(
    "/api/account/profile",
    { preHandler: requireUser },
    async (req, reply) => {
      const email = (req.body?.email ?? "").trim().toLowerCase();
      const deviceNote = (req.body?.device_note ?? "").trim();
      const displayName = (req.body?.display_name ?? "").trim();
      if (email && !EMAIL_RE.test(email)) {
        return reply.code(400).send({ detail: "Email 格式不正確" });
      }
      if (deviceNote.length > 500) {
        return reply.code(400).send({ detail: "備註長度不可超過 500 字" });
      }
      if (displayName.length > 60) {
        return reply.code(400).send({ detail: "顯示名稱不可超過 60 字" });
      }
      db.prepare("UPDATE users SET email = ?, device_note = ?, display_name = ? WHERE id = ?").run(
        email,
        deviceNote,
        displayName || null,
        req.user!.id,
      );
      return {
        status: "ok",
        email,
        device_note: deviceNote,
        display_name: displayName,
        gravatar_url: effectiveGravatar({ email, username: req.user!.username }),
      };
    },
  );

  // 看片偏好 + 主題(部分更新:只動 body 帶到的 key;傳 null 代表清除/跟隨全域)。
  app.put<{ Body: { camera?: string | null; speed?: number | null; theme?: string | null } }>(
    "/api/account/prefs",
    { preHandler: requireUser },
    async (req, reply) => {
      const body = req.body ?? {};
      const sets: string[] = [];
      const vals: Array<string | number | null> = [];

      if ("camera" in body) {
        const c = body.camera ?? null;
        if (c !== null && c !== "front" && c !== "rear") {
          return reply.code(400).send({ detail: "鏡頭須為 front 或 rear" });
        }
        sets.push("pref_camera = ?");
        vals.push(c);
      }
      if ("speed" in body) {
        const s = body.speed ?? null;
        if (s !== null && !SPEEDS.includes(s)) {
          return reply.code(400).send({ detail: "播放速度須為 1、1.5 或 2" });
        }
        sets.push("pref_speed = ?");
        vals.push(s);
      }
      if ("theme" in body) {
        const t = body.theme;
        if (t !== "auto" && t !== "light" && t !== "dark") {
          return reply.code(400).send({ detail: "主題須為 auto / light / dark" });
        }
        sets.push("pref_theme = ?");
        vals.push(t);
      }

      if (sets.length > 0) {
        vals.push(req.user!.id);
        db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
      }

      const row = db
        .prepare("SELECT pref_camera, pref_speed, pref_theme FROM users WHERE id = ?")
        .get(req.user!.id) as {
        pref_camera: string | null;
        pref_speed: number | null;
        pref_theme: string | null;
      };
      return { status: "ok", camera: row.pref_camera, speed: row.pref_speed, theme: row.pref_theme };
    },
  );

  // 旅程可見性:是否公開自己的旅程給其他使用者瀏覽。
  app.put<{ Body: { public?: boolean } }>(
    "/api/account/visibility",
    { preHandler: requireUser },
    async (req, reply) => {
      const pub = req.body?.public;
      if (typeof pub !== "boolean") {
        return reply.code(400).send({ detail: "public 需為布林值" });
      }
      db.prepare("UPDATE users SET trips_public = ? WHERE id = ?").run(pub ? 1 : 0, req.user!.id);
      return { status: "ok", public: pub };
    },
  );

  // 改密碼:驗證目前密碼,設定新密碼,並登出其他裝置(保留目前 session)。
  app.post<{ Body: { current?: string; next?: string } }>(
    "/api/account/password",
    { preHandler: requireUser },
    async (req, reply) => {
      const current = req.body?.current ?? "";
      const next = req.body?.next ?? "";
      const row = db
        .prepare("SELECT password_hash FROM users WHERE id = ?")
        .get(req.user!.id) as { password_hash: string } | undefined;
      if (!row || !verifyPassword(current, row.password_hash)) {
        return reply.code(400).send({ detail: "目前密碼不正確" });
      }
      if (next.length < 6) {
        return reply.code(400).send({ detail: "新密碼至少 6 個字元" });
      }
      if (next === current) {
        return reply.code(400).send({ detail: "新密碼不可與目前密碼相同" });
      }
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
        hashPassword(next),
        req.user!.id,
      );
      // 登出其他裝置:刪除此使用者除了目前 token 以外的所有 session。
      const token = req.cookies?.session_token ?? "";
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND token <> ?").run(req.user!.id, token);
      return { status: "ok" };
    },
  );
}
