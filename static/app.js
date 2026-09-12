/* ── 共用工具 ────────────────────────────────────────────────────────────────── */

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2,'0')}s`;
  return `${s}s`;
}

function cfgLocale() {
  return (__cfg.behavior && __cfg.behavior.locale) || 'zh-TW';
}

/** 使用者顯示名稱:優先 display_name,否則帳號。 */
function userDisplayName(u) {
  return (u && (u.display_name || u.username)) || '';
}

// 顯示一律以 UTC 呈現:行車記錄器檔名牆鐘以 UTC 存入(見後端 organizer.parseEpoch),
// 故 UTC 顯示 == 檔名時間,與伺服器/瀏覽器時區無關。
function fmtTime(epoch) {
  return new Date(epoch * 1000).toLocaleTimeString(cfgLocale(), {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
  });
}

function fmtSecs(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2,'0')}`;
}

/** HTML escape(用於把錯誤訊息等不可信字串安全插入 innerHTML)。 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/** 檔案大小:GB / MB / KB(十進位,與 upload/admin 一致)。 */
function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(0) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
  return (b || 0) + ' B';
}

function gBadgeClass(g) {
  if (g >= 2.5) return 'badge-g-crit';
  if (g >= 1.8) return 'badge-g-warn';
  return 'badge-g-ok';
}

function showToast(msg, type = '') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = Object.assign(document.createElement('div'), { id: 'toast-container' });
    document.body.appendChild(container);
  }
  container.setAttribute('role', 'status');
  container.setAttribute('aria-live', 'polite');
  const t = Object.assign(document.createElement('div'), {
    className: `toast${type ? ' ' + type : ''}`,
    textContent: msg,
  });
  container.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function renderTripCard(trip) {
  const start = fmtTime(trip.start_epoch);
  const end   = fmtTime(trip.end_epoch);
  const dur   = fmtDuration(trip.duration_sec);
  const g     = trip.peak_gforce || 0;
  const seq   = String(trip.day_order ?? 0).padStart(2, '0');

  const gBadge = g > 0
    ? `<span class="badge ${gBadgeClass(g)}">${g.toFixed(2)}g</span>` : '';
  const emerBadge = trip.emer_count > 0
    ? `<span class="badge badge-emer">EMER ×${trip.emer_count}</span>` : '';
  const rec = trip.emer_count > 0 ? `<span class="trip-rec">REC</span>` : '';

  const cams = [];
  if (trip.has_front) cams.push(t('trip.camFrontShort'));
  if (trip.has_rear)  cams.push(t('trip.camRearShort'));
  const deviceName = trip.device && (trip.device.nickname || trip.device.model);
  const deviceMeta = deviceName
    ? `<span class="trip-meta-item" title="${escapeHtml(trip.device.model)}">${escapeHtml(deviceName)}</span>`
    : '';

  // dashcam 畫格 + OSD 時間碼;序號用 day_order(真實序列)
  const size = trip.bytes ? `<span class="trip-meta-item">${fmtBytes(trip.bytes)}</span>` : '';
  // 縮圖蓋在 icon/漸層之上;載入失敗(無片或產生失敗)即移除,露出後方 icon。
  const thumb = `<img class="trip-thumb-img" loading="lazy" alt="" src="/video/${encodeURIComponent(trip.trip_id)}/thumbnail" onerror="this.remove()">`;

  return `
    <a class="trip-card" href="/trip/${encodeURIComponent(trip.trip_id)}">
      <div class="trip-frame">
        <div class="trip-frame-icon">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
        </div>
        ${thumb}
        <span class="trip-seq">${seq}</span>
        ${rec}
        <div class="trip-osd">
          <span class="trip-osd-date">${trip.date}</span>
          <span class="trip-osd-tc">${start}</span>
        </div>
        <div class="trip-badges">
          <span class="badge badge-dark">${dur}</span>${gBadge}${emerBadge}
        </div>
      </div>
      <div class="trip-body">
        <div class="trip-time">${start} — ${end}</div>
        <div class="trip-meta">
          <span class="trip-meta-item">${cams.join('+')||'—'}${t('trip.camSuffix')}</span>
          ${deviceMeta}
          ${size}
          <span class="trip-meta-item">${trip.segment_count} ${t('common.segUnit')}</span>
        </div>
      </div>
    </a>`;
}

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    // 只取後端的 detail 當人話訊息,不把原始 JSON 丟給使用者看。
    let detail = '';
    try { detail = (await res.json()).detail || ''; } catch {}
    const err = new Error(detail || `請求失敗（${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* ── 自訂化 config ────────────────────────────────────────────────────────────── */
let __cfg = { brand: {}, behavior: {}, titleTemplate: '{page} — {brand}', defaults: {} };

function domReady() {
  return document.readyState === 'loading'
    ? new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }))
    : Promise.resolve();
}

/**
 * 載入 /api/config 並套用品牌 + 翻譯靜態文字。每頁的 IIFE 應先 `await configReady`
 * 再渲染動態內容(確保 t() 可用、且不閃爍)。
 */
/* ── sessionStorage 快取(消除切頁時頁首/品牌的 0.5s 空窗) ─────────────────────── */
function cacheGet(k) { try { return JSON.parse(sessionStorage.getItem('dc.' + k)); } catch { return null; } }
function cacheSet(k, v) { try { sessionStorage.setItem('dc.' + k, JSON.stringify(v)); } catch {} }
function cacheClear(k) { try { sessionStorage.removeItem('dc.' + k); } catch {} }

const configReady = (async () => {
  const cached = cacheGet('cfg');
  if (cached) { __cfg = cached; window.__cfg = __cfg; }  // 先用快取,避免閃爍
  await domReady();
  try {
    const fresh = await apiFetch('/api/config');
    __cfg = fresh; window.__cfg = fresh; cacheSet('cfg', fresh);
  } catch { /* 失敗:沿用快取或 HTML 內建文字 */ }
  applyBranding(__cfg);
  return __cfg;
})();

/** 字串查找(用於動態 JS 產生的內容);字串由伺服器注入 window.__S。miss 回 key 本身。 */
function t(key, params) {
  const ui = window.__S || {};
  let s = Object.prototype.hasOwnProperty.call(ui, key) ? ui[key] : key;
  if (params) s = String(s).replace(/\{(\w+)\}/g, (_, k) => (k in params ? params[k] : `{${k}}`));
  return s;
}

/** 套用品牌:favicon、品牌文字/icon、登入底圖、頁尾。(主題與色彩已固定走 style.css 預設) */
function applyBranding(cfg) {
  const b = cfg.brand || {};
  if (b.faviconDataUrl) setFavicon(b.faviconDataUrl);
  if (b.title) {
    document.querySelectorAll('.hdr-brand-text, .auth-brand-text, .auth-brand-name').forEach(el => {
      el.textContent = b.title;
    });
  }
  if (b.iconDataUrl) {
    document.querySelectorAll('.hdr-brand-mark, .auth-brand-mark').forEach(el => {
      el.innerHTML = `<img src="${b.iconDataUrl}" alt="" style="width:100%;height:100%;object-fit:contain;border-radius:inherit">`;
    });
  }
  if (b.loginBg) {
    const a = document.querySelector('.auth-wrap, .auth-page, body.auth');
    if (a) a.style.background = b.loginBg.startsWith('data:') ? `center/cover no-repeat url("${b.loginBg}")` : b.loginBg;
  }
  applyFooter(b);
}

/** 重新載入 config 並即時套用品牌(管理頁存檔後免重整)。
 *  注意:UI 字串改由伺服器出頁時注入,修改 strings.yml 後需重新整理頁面才會反映。 */
async function reloadConfig() {
  try { __cfg = await apiFetch('/api/config'); window.__cfg = __cfg; } catch {}
  applyBranding(__cfg);
  return __cfg;
}

function injectStylesheet(href, id) {
  let l = document.getElementById(id);
  if (!l) { l = document.createElement('link'); l.id = id; l.rel = 'stylesheet'; document.head.appendChild(l); }
  l.href = href;
}
function setFavicon(href) {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  link.href = href;
}
function applyFooter(b) {
  const hasContent = b.footerText || (b.links && b.links.length);
  let f = document.getElementById('app-footer');
  // 認證頁(.auth-wrap)不放頁尾
  if (!f) {
    if (!hasContent || document.querySelector('.auth-wrap')) return;
    f = document.createElement('footer');
    f.id = 'app-footer';
    document.body.appendChild(f);
  }
  f.replaceChildren();
  if (b.footerText) {
    const span = document.createElement('span');
    span.textContent = b.footerText;
    f.appendChild(span);
  }
  (b.links || []).forEach(l => {
    const a = document.createElement('a');
    a.href = l.href; a.textContent = l.label; a.rel = 'noopener';
    f.appendChild(a);
  });
  f.style.display = hasContent ? '' : 'none';
}

/* ── 主題(深/淺色) ───────────────────────────────────────────────────────────────
 * 無閃爍由各頁 <head> 的 inline 片段負責(在 CSS 套用前先設 data-theme)。
 * 這裡負責「切換」與「依登入者偏好同步」。style.css 只有 [data-theme="dark"],
 * 故 auto 需用 matchMedia 解析,而非單純移除屬性。 */
function resolveDark(mode) {
  return mode === 'dark' || (mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
}
function applyTheme(mode) {
  const m = mode || 'auto';
  try { localStorage.setItem('dc.theme', m); } catch {}
  if (resolveDark(m)) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
}
// auto 模式下,系統深淺色切換即時反映
try {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    let m = 'auto'; try { m = localStorage.getItem('dc.theme') || 'auto'; } catch {}
    if (m === 'auto') applyTheme('auto');
  });
} catch {}

/* ── 認證 ─────────────────────────────────────────────────────────────────────── */

async function checkAuth({ redirect = true, adminOnly = false } = {}) {
  try {
    const { user } = await apiFetch('/api/auth/me');  // 未登入回 { user: null },不再噴 401
    if (!user) {
      cacheClear('user');
      if (redirect) location.href = '/login';
      return null;
    }
    cacheSet('user', user);
    // 依登入者的跨裝置主題偏好同步(未設定則保留本機 localStorage 的選擇)
    if (user.pref_theme) applyTheme(user.pref_theme);
    // 首次登入須改密碼:一律導到強制改密碼頁(改密碼頁本身豁免以免迴圈)
    if (user.must_change_password && !location.pathname.startsWith('/change-password')) {
      location.href = '/change-password';
      return null;
    }
    if (adminOnly && user.role !== 'admin') {
      if (redirect) location.href = '/';
      return null;
    }
    return user;
  } catch {
    cacheClear('user');
    if (redirect) location.href = '/login';
    return null;
  }
}

function renderHeader(user) {
  if (!user) return;

  // Show admin-only nav links
  if (user.role === 'admin') {
    document.querySelectorAll('.admin-only').forEach(el => {
      el.style.display = '';
    });
  }

  // Populate hdr-ctrls with user chip + logout
  const ctrls = document.getElementById('hdr-ctrls');
  if (!ctrls) return;
  const dname = userDisplayName(user);
  const initial = (dname[0] || '?').toUpperCase();
  const roleClass = user.role === 'admin' ? 'admin' : 'viewer';
  const roleLabel = user.role === 'admin' ? t('common.role.admin') : t('common.role.viewer');
  const avatarHtml = user.gravatar_url
    ? `<img class="user-chip-avatar" src="${user.gravatar_url}" alt="${initial}"
            onerror="this.outerHTML='<div class=\\'user-chip-avatar\\'>${initial}</div>'">`
    : `<div class="user-chip-avatar">${initial}</div>`;
  ctrls.innerHTML = `
    <a class="user-chip" href="/account" title="${t('nav.account')}" style="text-decoration:none;color:inherit;">
      ${avatarHtml}
      ${escapeHtml(dname)}
      <span class="role-badge ${roleClass}">${roleLabel}</span>
    </a>
    <button class="btn btn--ghost btn--sm" onclick="logout()">${t('common.logout')}</button>
  `;

  initNavActive();
  buildMobileNav(user);
}

async function logout() {
  try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch {}
  cacheClear('user'); cacheClear('cfg');
  location.href = '/login';
}

/* ── Header scroll effect ────────────────────────────────────────────────────── */
function initHdrScroll() {
  const hdr = document.querySelector('.hdr');
  if (!hdr) return;
  const update = () => hdr.classList.toggle('is-scrolled', window.scrollY > 8);
  window.addEventListener('scroll', update, { passive: true });
  update();
}

/* ── Active nav link ─────────────────────────────────────────────────────────── */
function initNavActive() {
  const path = location.pathname;
  document.querySelectorAll('.hdr-link[data-href]').forEach(a => {
    const h = a.dataset.href;
    const active = (h === '/' && path === '/') ||
                   (h !== '/' && path.startsWith(h));
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

/* ── 行動版導覽(漢堡 + 右側拉抽屜) ─────────────────────────────────────────────
 * 桌機維持 .hdr-nav 置中膠囊列;窄螢幕(≤860px,由 style.css 控制顯隱)隱藏桌機列,
 * 改用注入的 .hdr-burger 開啟 .m-drawer。抽屜內容(使用者、連結、登出)由
 * buildMobileNav(user) 依登入者/角色填入,故與 renderHeader 的權限/i18n 一致。 */
const MNAV = [
  { href: '/',       key: 'nav.home',   fb: '首頁' },
  { href: '/browse', key: 'nav.browse', fb: '瀏覽旅程' },
  { href: '/clips',  key: 'nav.clips',  fb: '片段' },
  { href: '/upload', key: 'nav.upload', fb: '上傳' },
  { href: '/admin',  key: 'nav.admin',  fb: '管理', admin: true },
  { href: '/ops',    key: 'nav.ops',    fb: '維運', admin: true },
];
function tFb(key, fb) { const s = t(key); return s === key ? fb : s; }

function mnavOpen() {
  document.documentElement.classList.add('m-nav-open');
  const b = document.querySelector('.hdr-burger');
  if (b) b.setAttribute('aria-expanded', 'true');
  const d = document.getElementById('m-drawer');
  if (d) { d.setAttribute('aria-hidden', 'false'); d.querySelector('.m-close')?.focus(); }
}
function mnavClose() {
  if (!document.documentElement.classList.contains('m-nav-open')) return;
  document.documentElement.classList.remove('m-nav-open');
  const b = document.querySelector('.hdr-burger');
  if (b) { b.setAttribute('aria-expanded', 'false'); b.focus(); }
  document.getElementById('m-drawer')?.setAttribute('aria-hidden', 'true');
}
function mnavToggle() {
  document.documentElement.classList.contains('m-nav-open') ? mnavClose() : mnavOpen();
}

/** 建立漢堡鈕 + 遮罩 + 抽屜骨架(冪等),並掛上開關事件。認證頁(無 .hdr)直接略過。 */
function initMobileNav() {
  const hdr = document.querySelector('.hdr');
  if (!hdr) return;
  const inner = hdr.querySelector('.hdr-inner');
  if (inner && !inner.querySelector('.hdr-burger')) {
    const b = document.createElement('button');
    b.className = 'hdr-burger'; b.type = 'button';
    b.setAttribute('aria-label', tFb('nav.menu', '選單'));
    b.setAttribute('aria-controls', 'm-drawer');
    b.setAttribute('aria-expanded', 'false');
    b.innerHTML = '<span></span><span></span><span></span>';
    b.addEventListener('click', mnavToggle);
    inner.appendChild(b);
  }
  if (!document.getElementById('m-drawer')) {
    const scrim = document.createElement('div');
    scrim.className = 'm-scrim'; scrim.id = 'm-scrim';
    scrim.addEventListener('click', mnavClose);
    const drawer = document.createElement('aside');
    drawer.className = 'm-drawer'; drawer.id = 'm-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', tFb('nav.menu', '選單'));
    drawer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(scrim);
    document.body.appendChild(drawer);
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') mnavClose(); });
  // 旋轉/縮放回到桌機尺寸時自動收起(與 CSS max-width:860px 接壤,避免出現「漢堡消失但抽屜還開」的縫隙)
  try { matchMedia('(min-width: 860px)').addEventListener('change', e => { if (e.matches) mnavClose(); }); } catch {}
  buildMobileNav(cacheGet('user'));   // 先用快取使用者填一次(避免首開空白)
}

/** 依登入者填入抽屜:使用者區塊(連個人設定)+ 導覽連結(含 admin-only)+ 登出。 */
function buildMobileNav(user) {
  const drawer = document.getElementById('m-drawer');
  if (!drawer) return;
  const isAdmin = !!(user && user.role === 'admin');
  const brandTitle = (window.__cfg && __cfg.brand && __cfg.brand.title)
    || document.querySelector('.hdr-brand-text')?.textContent || '行車記錄';
  const markHtml = document.querySelector('.hdr-brand-mark')?.innerHTML || '';
  const path = location.pathname;

  let userBlock = '';
  if (user) {
    const dname = userDisplayName(user);
    const initial = (dname[0] || '?').toUpperCase();
    const roleClass = isAdmin ? 'admin' : 'viewer';
    const roleLabel = isAdmin ? t('common.role.admin') : t('common.role.viewer');
    const avatar = user.gravatar_url
      ? `<img class="user-chip-avatar" src="${user.gravatar_url}" alt="${initial}" onerror="this.outerHTML='<div class=\\'user-chip-avatar\\'>${initial}</div>'">`
      : `<div class="user-chip-avatar">${initial}</div>`;
    userBlock = `
      <a class="m-user" href="/account" title="${tFb('nav.account', '個人設定')}">
        ${avatar}
        <span class="m-user-meta">
          <span class="m-user-name">${escapeHtml(dname)}</span>
          <span class="role-badge ${roleClass}">${roleLabel}</span>
        </span>
        <svg class="m-user-go" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
      </a>`;
  }

  const links = MNAV.filter(it => !it.admin || isAdmin).map(it => {
    const active = (it.href === '/' && path === '/') || (it.href !== '/' && path.startsWith(it.href));
    return `<a class="m-nav-link${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''} href="${it.href}">${escapeHtml(tFb(it.key, it.fb))}</a>`;
  }).join('');

  drawer.innerHTML = `
    <div class="m-drawer-top">
      <a class="m-brand" href="/">
        <span class="m-brand-mark">${markHtml}</span>
        <span class="m-brand-text">${escapeHtml(brandTitle)}</span>
      </a>
      <button class="m-close" type="button" aria-label="${tFb('common.close', '關閉')}" onclick="mnavClose()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    ${userBlock}
    <nav class="m-nav">${links}</nav>
    ${user ? `<div class="m-foot"><button class="btn btn--ghost" type="button" onclick="logout()">${escapeHtml(tFb('common.logout', '登出'))}</button></div>` : ''}
  `;
  // 點任一連結即收起抽屜(同頁 hash 切換時尤其需要)
  drawer.querySelectorAll('a').forEach(a => a.addEventListener('click', mnavClose));
}

document.addEventListener('DOMContentLoaded', () => {
  initHdrScroll();
  initNavActive();
  initMobileNav();
  // 樂觀渲染:用上一次的 config + 使用者立即補上頁首(品牌、admin 連結、使用者晶片),
  // 避免切頁時 0.5s 的「預設樣 → 正常」閃爍。稍後 configReady/checkAuth 取得新資料會再對帳。
  const cc = cacheGet('cfg');
  if (cc) { __cfg = cc; window.__cfg = cc; try { applyBranding(cc); } catch {} }
  const cu = cacheGet('user');
  if (cu) { try { renderHeader(cu); } catch {} }
});
