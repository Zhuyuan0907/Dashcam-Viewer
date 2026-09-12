/**
 * 頁面路由(回傳已注入 UI 字串的 HTML)。
 *
 * 字串注入(取代舊的前端 i18n):伺服器讀取每頁原始 HTML,於出頁時依 DATA_DIR/strings.yml:
 *   - 把 [data-i18n] 元素的文字、[data-i18n-attr] 的屬性、<title> 依字串覆寫並移除該 data-* 屬性;
 *   - 注入 window.__S(僅含該頁需要的字串命名空間),供動態 JS(renderTripCard 等)的 t() 查找。
 * 如此 admin/ops 等內部字串不會再透過公開的 /api/config 外洩。
 */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { STATIC_DIR } from "../config.js";
import { lookupSession } from "../auth.js";
import type { AppContext } from "../context.js";

/** 每頁要注入給動態 JS 的字串命名空間(key 前綴)。靜態文字替換用全量,不受此限。 */
const PAGE_NS: Record<string, string[]> = {
  "index.html": ["common", "nav", "title", "index", "trip"],
  "browse.html": ["common", "nav", "title", "browse", "trip", "index"],
  "trip.html": ["common", "nav", "title", "trip"],
  "login.html": ["common", "nav", "title", "auth"],
  "setup.html": ["common", "nav", "title", "auth"],
  "change-password.html": ["common", "nav", "title", "auth"],
  "upload.html": ["common", "nav", "title", "upload"],
  "clips.html": ["common", "nav", "title", "clips", "trip"],
  // admin 頁的動態 JS 有用到 upload.*(即時上傳狀況)、trip.*(fmtElapsed 時間單位)、
  // auth.*(建立帳號送出鈕);ops 頁重試完成 fallback 用 upload.done —— 缺了會顯示原始 key。
  "admin.html": ["common", "nav", "title", "admin", "upload", "trip", "auth"],
  "ops.html": ["common", "nav", "title", "ops", "upload"],
  "account.html": ["common", "nav", "title", "account"],
};

// HTML 快取以 mtime 失效:改 static/*.html 立即生效(不必重啟),同時避免每請求重讀磁碟。
const rawCache = new Map<string, { html: string; mtimeMs: number }>();
function rawHtml(name: string): string {
  const file = path.join(STATIC_DIR, name);
  const { mtimeMs } = fs.statSync(file);
  const hit = rawCache.get(name);
  if (hit && hit.mtimeMs === mtimeMs) return hit.html;
  const html = fs.readFileSync(file, "utf8");
  rawCache.set(name, { html, mtimeMs });
  return html;
}

function escHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}
function escAttr(s: string): string {
  return s.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!);
}

/** 在單一開始標籤字串內,設定(或新增)某屬性值。 */
function setTagAttr(tag: string, attr: string, value: string): string {
  const re = new RegExp(`\\s${attr}="[^"]*"`);
  const inject = ` ${attr}="${escAttr(value)}"`;
  if (re.test(tag)) return tag.replace(re, inject);
  // 無此屬性 → 插在標籤名後
  return tag.replace(/^<([a-zA-Z0-9]+)/, `<$1${inject}`);
}

/**
 * 把 HTML 內的 i18n 標記依字串表注入,並移除 data-* 標記。
 * brandTitle 用於 <title> 組裝(titleTemplate)。
 */
function injectStrings(
  html: string,
  strings: Record<string, string>,
  brandTitle: string,
  titleTemplate: string,
): string {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(strings, k);

  // <title data-i18n-title="key">
  html = html.replace(
    /<title\b([^>]*?)\sdata-i18n-title="([^"]+)"([^>]*)>([\s\S]*?)<\/title>/,
    (_m, pre, key, post, inner) => {
      const page = has(key) ? strings[key] : "";
      const title =
        page && page !== brandTitle
          ? titleTemplate.replace("{page}", page).replace("{brand}", brandTitle)
          : brandTitle || page || inner;
      return `<title${pre}${post}>${escHtml(title)}</title>`;
    },
  );

  // 任意元素的 data-i18n-attr="attr:key;attr2:key2"
  html = html.replace(/<[a-zA-Z0-9]+\b[^>]*\sdata-i18n-attr="([^"]+)"[^>]*>/g, (tag, spec: string) => {
    let out = tag;
    for (const pair of spec.split(";")) {
      const [attr, key] = pair.split(":").map((x) => x.trim());
      if (attr && key && has(key)) out = setTagAttr(out, attr, strings[key]!);
    }
    return out.replace(/\sdata-i18n-attr="[^"]*"/, "");
  });

  // 元素文字 data-i18n="key"(對應舊 applyI18n 的 textContent 行為:僅在 key 存在時覆寫)
  html = html.replace(
    /<([a-zA-Z0-9]+)\b([^>]*?)\sdata-i18n="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/g,
    (_m, tag, pre, key, post, inner) => {
      const open = `<${tag}${pre}${post}>`;
      const body = has(key) ? escHtml(strings[key]!) : inner;
      return `${open}${body}</${tag}>`;
    },
  );

  return html;
}

/** 取字串子集(命名空間前綴白名單),供 window.__S 注入。 */
function pickStrings(strings: Record<string, string>, prefixes: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(strings)) {
    const ns = k.split(".", 1)[0]!;
    if (prefixes.includes(ns)) out[k] = v;
  }
  return out;
}

export function registerPages(app: FastifyInstance, ctx: AppContext): void {
  const { settings } = ctx;

  function renderPage(name: string, reply: FastifyReply): FastifyReply {
    const strings = settings.readStrings();
    const brandTitle = settings.get("site_title");
    let html = injectStrings(rawHtml(name), strings, brandTitle, "{page} — {brand}");

    // 注入該頁需要的字串給動態 JS(t() 讀 window.__S);只含該頁命名空間,避免外洩。
    // `<` 一律轉成 <:字串值(可由管理員自訂)含 </script> 時才不會提前關閉標籤。
    const subset = pickStrings(strings, PAGE_NS[name] ?? ["common", "nav", "title"]);
    const blob = `<script>window.__S=${JSON.stringify(subset).replace(/</g, "\\u003c")};</script>`;
    if (html.includes('<script src="/static/app.js">')) {
      html = html.replace('<script src="/static/app.js">', `${blob}\n<script src="/static/app.js">`);
    } else {
      html = html.replace("</body>", `${blob}\n</body>`);
    }

    return reply.type("text/html").header("Cache-Control", "no-cache").send(html);
  }

  const page = (name: string) => (_req: unknown, reply: FastifyReply) => renderPage(name, reply);

  // 管理員頁:出頁前先驗 session(非管理員導回首頁/登入頁)。頁內注入了 admin/ops
  // 字串命名空間與後台介面結構,伺服器端就該把關,而非只靠前端 checkAuth 導走。
  const adminPage = (name: string) => (req: FastifyRequest, reply: FastifyReply) => {
    const user = lookupSession(ctx.db, req.cookies?.session_token);
    if (!user) return reply.redirect("/login", 302);
    if (user.role !== "admin") return reply.redirect("/", 302);
    return renderPage(name, reply);
  };

  app.get("/login", page("login.html"));
  app.get("/change-password", page("change-password.html"));
  app.get("/", page("index.html"));
  app.get("/browse", page("browse.html"));
  app.get("/trip/*", page("trip.html"));
  app.get("/upload", page("upload.html"));
  app.get("/clips", page("clips.html"));
  app.get("/admin", adminPage("admin.html"));
  app.get("/ops", adminPage("ops.html"));
  app.get("/account", page("account.html"));

  app.get("/setup", (_req, reply) => {
    const c = (ctx.db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
    if (c > 0) return reply.redirect("/", 302);
    return renderPage("setup.html", reply);
  });
}
