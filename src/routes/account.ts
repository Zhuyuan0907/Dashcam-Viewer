/**
 * 個人設定 API(self-service,僅需登入)。
 *
 * 與 routes/users.ts(管理員專用)分離:這裡操作的一律是「自己」(req.user.id),
 * 改密碼必須驗證目前密碼。供 static/account.html 使用。
 *   PUT  /api/account/profile   { email, display_name }
 *   GET/POST/PUT/DELETE /api/account/devices  多台行車記錄器管理
 *   PUT  /api/account/prefs     { camera?, speed?, theme? }   ← 部分更新,null=清除/跟隨全域
 *   POST /api/account/password  { current, next }             ← 驗證目前密碼,並登出其他裝置
 */
import type { FastifyInstance } from "fastify";
import { hashPasswordAsync, verifyPasswordAsync } from "../auth.js";
import { effectiveGravatar } from "../gravatar.js";
import { makeRequireUser, type AppContext } from "../context.js";
import {
  archiveDevice,
  createDevice,
  defaultDevice,
  getDevice,
  isDeviceProfile,
  listDevices,
  setDefaultDevice,
  updateDevice,
  type DeviceInput,
} from "../devices/repo.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SPEEDS = [1, 1.5, 2];

export function registerAccount(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const requireUser = makeRequireUser(ctx);

  // 個人資料:Email(影響頭像)+顯示名稱。device_note 僅保留舊 client 相容。
  app.put<{ Body: { email?: string; device_note?: string; display_name?: string } }>(
    "/api/account/profile",
    { preHandler: requireUser },
    async (req, reply) => {
      const old = db.prepare("SELECT email, display_name FROM users WHERE id = ?").get(req.user!.id) as {
        email: string;
        display_name: string | null;
      };
      const email = (req.body?.email ?? old.email ?? "").trim().toLowerCase();
      const deviceNote = typeof req.body?.device_note === "string" ? req.body.device_note.trim() : null;
      const displayName = (req.body?.display_name ?? old.display_name ?? "").trim();
      if (email && !EMAIL_RE.test(email)) {
        return reply.code(400).send({ detail: "Email 格式不正確" });
      }
      if (deviceNote !== null && deviceNote.length > 500) {
        return reply.code(400).send({ detail: "備註長度不可超過 500 字" });
      }
      if (displayName.length > 60) {
        return reply.code(400).send({ detail: "顯示名稱不可超過 60 字" });
      }
      db.prepare("UPDATE users SET email = ?, display_name = ? WHERE id = ?").run(
        email,
        displayName || null,
        req.user!.id,
      );
      // 舊版 account.html 仍可能送 device_note。只有尚未遷移出任何裝置時才轉成第一台,
      // 避免多裝置環境被舊 client 靜默覆寫預設裝置。
      if (deviceNote && listDevices(db, req.user!.id).length === 0) {
        createDevice(db, req.user!.id, {
          profile_key: /MiVue\s*[™ ]?\s*MP20/i.test(deviceNote) ? "mivue-mp20" : "custom",
          model: deviceNote,
          nickname: "",
          note: "",
          show_on_trips: true,
          is_default: true,
        });
      }
      const legacyDevice = defaultDevice(db, req.user!.id);
      return {
        status: "ok",
        email,
        device_note: legacyDevice ? [legacyDevice.model, legacyDevice.note].filter(Boolean).join(" - ") : "",
        display_name: displayName,
        gravatar_url: effectiveGravatar({ email, username: req.user!.username }),
      };
    },
  );

  function presentDevice(d: ReturnType<typeof listDevices>[number]): Record<string, unknown> {
    return {
      ...d,
      show_on_trips: d.show_on_trips === 1,
      is_default: d.is_default === 1,
    };
  }

  function parseDeviceInput(body: Record<string, unknown>, current?: ReturnType<typeof getDevice>): DeviceInput | string {
    const profile = String(body.profile_key ?? current?.profile_key ?? "").trim();
    const model = String(body.model ?? current?.model ?? "").trim();
    const nickname = String(body.nickname ?? current?.nickname ?? "").trim();
    const note = String(body.note ?? current?.note ?? "").trim();
    const showRaw = body.show_on_trips ?? (current ? current.show_on_trips === 1 : true);
    if (!isDeviceProfile(profile)) return "不支援的記錄器類型";
    if (!model) return "請填寫記錄器型號";
    if (model.length > 120) return "型號不可超過 120 字";
    if (nickname.length > 60) return "名稱不可超過 60 字";
    if (note.length > 500) return "安裝備註不可超過 500 字";
    if (typeof showRaw !== "boolean") return "show_on_trips 需為布林值";
    return {
      profile_key: profile,
      model,
      nickname,
      note,
      show_on_trips: showRaw,
      is_default: body.is_default === true,
    };
  }

  app.get("/api/account/devices", { preHandler: requireUser }, async (req) => ({
    profiles: [
      { key: "mivue-mp20", label: "MiVue MP20" },
      { key: "polaroid-ms279wg", label: "Polaroid MS279WG" },
      { key: "custom", label: "其他 / 自訂" },
    ],
    devices: listDevices(db, req.user!.id).map(presentDevice),
  }));

  app.post<{ Body: Record<string, unknown> }>(
    "/api/account/devices",
    { preHandler: requireUser },
    async (req, reply) => {
      const input = parseDeviceInput(req.body ?? {});
      if (typeof input === "string") return reply.code(400).send({ detail: input });
      try {
        const device = createDevice(db, req.user!.id, input);
        return reply.code(201).send({ status: "created", device: presentDevice(device) });
      } catch (e) {
        return reply.code(400).send({ detail: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/account/devices/:id",
    { preHandler: requireUser },
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      const current = getDevice(db, req.user!.id, id);
      if (!current) return reply.code(404).send({ detail: "找不到此行車記錄器" });
      const input = parseDeviceInput(req.body ?? {}, current);
      if (typeof input === "string") return reply.code(400).send({ detail: input });
      const device = updateDevice(db, req.user!.id, id, input);
      return { status: "ok", device: presentDevice(device!) };
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/account/devices/:id/default",
    { preHandler: requireUser },
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      const device = setDefaultDevice(db, req.user!.id, id);
      if (!device) return reply.code(404).send({ detail: "找不到此行車記錄器" });
      return { status: "ok", device: presentDevice(device) };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/account/devices/:id",
    { preHandler: requireUser },
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!archiveDevice(db, req.user!.id, id)) {
        return reply.code(404).send({ detail: "找不到此行車記錄器" });
      }
      return { status: "archived" };
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
        const t = body.theme ?? null;
        if (t !== null && !['harbor','terracotta','slate','auto','light','dark'].includes(t)) {
          return reply.code(400).send({ detail: "請選擇港灣、陶土或暮山主題" });
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
      if (!row || !(await verifyPasswordAsync(current, row.password_hash))) {
        return reply.code(400).send({ detail: "目前密碼不正確" });
      }
      if (next.length < 6) {
        return reply.code(400).send({ detail: "新密碼至少 6 個字元" });
      }
      if (next === current) {
        return reply.code(400).send({ detail: "新密碼不可與目前密碼相同" });
      }
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
        await hashPasswordAsync(next),
        req.user!.id,
      );
      // 登出其他裝置:刪除此使用者除了目前 token 以外的所有 session。
      const token = req.cookies?.session_token ?? "";
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND token <> ?").run(req.user!.id, token);
      return { status: "ok" };
    },
  );

  // 首次強制改密碼:僅對 must_change_password=1 的帳號開放(免驗證目前密碼,因可能為無密碼帳號)。
  // 設定新密碼後清除旗標並登出其他裝置。供 static/change-password.html 使用。
  app.post<{ Body: { next?: string } }>(
    "/api/account/first-password",
    { preHandler: requireUser },
    async (req, reply) => {
      const next = req.body?.next ?? "";
      const row = db
        .prepare("SELECT password_hash, must_change_password FROM users WHERE id = ?")
        .get(req.user!.id) as { password_hash: string; must_change_password: number } | undefined;
      if (!row || row.must_change_password !== 1) {
        return reply.code(400).send({ detail: "此帳號無待變更的密碼" });
      }
      if (next.length < 6) {
        return reply.code(400).send({ detail: "新密碼至少 6 個字元" });
      }
      if (row.password_hash && (await verifyPasswordAsync(next, row.password_hash))) {
        return reply.code(400).send({ detail: "新密碼不可與目前密碼相同" });
      }
      db.prepare(
        "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
      ).run(await hashPasswordAsync(next), req.user!.id);
      const token = req.cookies?.session_token ?? "";
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND token <> ?").run(req.user!.id, token);
      return { status: "ok" };
    },
  );
}
