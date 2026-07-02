/**
 * 自訂化設定 API。
 *
 *   GET  /api/config              公開 — 品牌 + UI 字串 + 行為,給前端套用(登入/初始頁也需要)
 *   GET  /api/admin/settings      管理員 — 純量設定(表單用)
 *   PUT  /api/admin/settings      管理員 — 白名單驗證後寫入
 *   GET  /api/admin/strings       管理員 — 字串檔原始文字(編輯器用)
 *   PUT  /api/admin/strings       管理員 — 驗證 JSON + key 白名單後原子寫入
 */
import type { FastifyInstance } from "fastify";
import { ICON_MAX_BYTES } from "../config.js";
import { makeRequireAdmin, type AppContext } from "../context.js";
import { buildPublicConfig } from "../settings/store.js";

class ValidationError extends Error {}

// ── 各鍵驗證器:回傳清洗後的值,或丟 ValidationError ──

function str(v: unknown, max: number): string {
  if (typeof v !== "string") throw new ValidationError("必須是字串");
  if (v.length > max) throw new ValidationError(`長度不可超過 ${max}`);
  return v;
}

function int(v: unknown, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new ValidationError("必須是整數");
  if (n < min || n > max) throw new ValidationError(`必須介於 ${min}–${max}`);
  return n;
}

function enumOf<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new ValidationError(`必須是 ${allowed.join(" / ")} 之一`);
  }
  return v as T;
}

/** CSS 色值/長度:擋掉會跳脫 setProperty 的危險字元。 */
function cssToken(v: unknown, max = 64): string {
  const s = str(v, max);
  if (s === "") return "";
  if (/[;{}<>]|url\(|expression|@import|\/\*|\n|\r/i.test(s)) {
    throw new ValidationError("含不允許的字元");
  }
  return s.trim();
}

function hostname(v: unknown): string {
  const s = str(v, 255);
  if (s === "") return "";
  if (!/^[A-Za-z0-9.\-:]+$/.test(s)) throw new ValidationError("主機名格式不正確");
  return s;
}

function dataUrl(v: unknown): string {
  const s = str(v, Math.ceil(ICON_MAX_BYTES * 1.4) + 100); // base64 膨脹 ~1.37x
  if (s === "") return "";
  const m = /^data:image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m || !m[2]) throw new ValidationError("僅接受 PNG / ICO / SVG 的 base64 data-URL");
  const bytes = Math.floor((m[2].length * 3) / 4);
  if (bytes > ICON_MAX_BYTES) throw new ValidationError(`圖片過大(上限 ${ICON_MAX_BYTES} 位元組)`);
  return s;
}

function cssColorOrDataUrl(v: unknown): string {
  const s = str(v, Math.ceil(ICON_MAX_BYTES * 1.4) + 100);
  if (s === "") return "";
  if (s.startsWith("data:image/")) return dataUrl(s);
  return cssToken(s, 200); // 否則當 CSS 色值/背景簡寫
}

function links(v: unknown): Array<{ label: string; href: string }> {
  if (!Array.isArray(v)) throw new ValidationError("links 必須是陣列");
  if (v.length > 10) throw new ValidationError("連結最多 10 個");
  return v.map((item) => {
    if (!item || typeof item !== "object") throw new ValidationError("連結項目格式錯誤");
    const label = str((item as Record<string, unknown>).label, 60);
    const href = str((item as Record<string, unknown>).href, 300);
    if (!/^(https?:\/\/|\/)/.test(href)) throw new ValidationError("連結網址只能是 http(s):// 或 /");
    return { label, href };
  });
}

/** key → 驗證器。未列於此的 key 一律拒絕。 */
const VALIDATORS: Record<string, (v: unknown) => unknown> = {
  site_title: (v) => str(v, 200),
  footer_text: (v) => str(v, 200),
  login_tagline: (v) => str(v, 200),
  icon_data_url: dataUrl,
  favicon_data_url: dataUrl,
  login_bg: cssColorOrDataUrl,
  locale: (v) => {
    const s = str(v, 35);
    if (s !== "" && !/^[A-Za-z\-]+$/.test(s)) throw new ValidationError("locale 格式不正確");
    return s;
  },
  units: (v) => enumOf(v, ["km", "mi"] as const),
  items_per_page: (v) => int(v, 1, 200),
  default_camera: (v) => enumOf(v, ["front", "rear"] as const),
  sftp_public_host: hostname,
  sftp_port: (v) => int(v, 1, 65535),
  upload_session_idle_sec: (v) => int(v, 60, 86400),
  default_gap_min: (v) => int(v, 1, 120),
  quarantine_retention_days: (v) => int(v, 1, 90),
  links,
};

export function registerConfig(app: FastifyInstance, ctx: AppContext): void {
  const requireAdmin = makeRequireAdmin(ctx);
  const { settings } = ctx;

  // ── 公開 config ──
  app.get("/api/config", async (_req, reply) => {
    reply.header("Cache-Control", "no-cache");
    return buildPublicConfig(settings);
  });

  // ── 管理:純量設定 ──
  app.get("/api/admin/settings", { preHandler: requireAdmin }, async () => {
    return settings.getAll();
  });

  app.put("/api/admin/settings", { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply.code(400).send({ detail: "請求格式錯誤" });
    }
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      const validate = VALIDATORS[k];
      if (!validate) return reply.code(400).send({ detail: `未知的設定鍵:${k}` });
      try {
        clean[k] = validate(v);
      } catch (e) {
        const msg = e instanceof ValidationError ? e.message : "驗證失敗";
        return reply.code(400).send({ detail: `${k}:${msg}` });
      }
    }
    settings.setMany(clean);
    return { status: "ok", saved: Object.keys(clean) };
  });

  // UI 字串改由直接編輯 DATA_DIR/strings.yml 維護,不再有後台編輯端點。
}
