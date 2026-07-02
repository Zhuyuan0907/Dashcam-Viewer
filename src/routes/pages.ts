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
import type { FastifyInstance, FastifyReply } from "fastify";
import { STATIC_DIR } from "../config.js";
import type { AppContext } from "../context.js";

/** 每頁要注入給動態 JS 的字串命名空間(key 前綴)。靜態文字替換用全量,不受此限。 */
const PAGE_NS: Record<string, string[]> = {
  "index.html": ["common", "nav", "title", "index", "trip"],
  "browse.html": ["common", "nav", "title", "browse", "trip", "index"],
  "trip.html": ["common", "nav", "title", "trip"],
  "login.html": ["common", "nav", "title", "auth"],
  "setup.html": ["common", "nav", "title", "auth"],
  "upload.html": ["common", "nav", "title", "upload"],
  "admin.html": ["common", "nav", "title", "admin"],
  "ops.html": ["common", "nav", "title", "ops"],
  "account.html": ["common", "nav", "title", "account"],
};

const rawCache = new Map<string, string>();
function rawHtml(name: string): string {
  let s = rawCache.get(name);
  if (s === undefined) {
    s = fs.readFileSync(path.join(STATIC_DIR, name), "utf8");
    rawCache.set(name, s);
  }
  return s;
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
    const subset = pickStrings(strings, PAGE_NS[name] ?? ["common", "nav", "title"]);
    const blob = `<script>window.__S=${JSON.stringify(subset)};</script>`;
    if (html.includes('<script src="/static/app.js">')) {
      html = html.replace('<script src="/static/app.js">', `${blob}\n<script src="/static/app.js">`);
    } else {
      html = html.replace("</body>", `${blob}\n</body>`);
    }

    return reply.type("text/html").header("Cache-Control", "no-cache").send(html);
  }

  const page = (name: string) => (_req: unknown, reply: FastifyReply) => renderPage(name, reply);

  app.get("/login", page("login.html"));
  app.get("/", page("index.html"));
  app.get("/browse", page("browse.html"));
  app.get("/trip/*", page("trip.html"));
  app.get("/upload", page("upload.html"));
  app.get("/admin", page("admin.html"));
  app.get("/ops", page("ops.html"));
  app.get("/account", page("account.html"));

  app.get("/setup", (_req, reply) => {
    const c = (ctx.db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
    if (c > 0) return reply.redirect("/", 302);
    return renderPage("setup.html", reply);
  });
}
