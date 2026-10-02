/* ── 時光機:仿 macOS Time Machine 的時間穿越瀏覽 ───────────────────────────────
 * 每個騎乘日是一扇視窗,越早的日期越往深處退去;捲動 / 拖曳 / 方向鍵以臨界阻尼彈簧推動。
 * 效能:只建立目前位置附近的視窗(虛擬化,約 8 扇),跨越日期時才建立/回收;每格只寫 transform
 * 與 opacity,變暗用獨立合成層;縮圖只載入最前面幾扇。
 * 視窗內容不需要二次捲動:上方是當日 24 小時時間帶,下方格狀排版會依可用空間自動計算欄列,
 * 讓當天所有旅程一次放得下;超過上限時最後一格顯示「+N 趟」。
 * 依賴 browse.html 的 allDates、currentOwner、selectDate。 */
(() => {
  const dialog = document.getElementById("time-machine");
  const stage = document.getElementById("tm-stage");
  const timeline = document.getElementById("tm-timeline");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const cache = new Map();
  const MAX_TILES = 24;
  const BEHIND = 6;      // 往後(更早)渲染幾扇
  const AHEAD = 1;       // 已穿過(較新)保留幾扇做飛出動畫

  let pos = 0;          // 目前(連續)位置:0 = 最新一天
  let target = 0;       // 彈簧目標
  let vel = 0;
  let index = 0;        // 已吸附的日期索引
  let raf = 0;
  let lastTs = 0;
  let wheelTimer = 0;
  let settleTimer = 0;
  let drag = null;
  let suppressClick = false;
  let previousFocus = null;
  const windows = new Map();   // 日期索引 → 視窗元素(只含渲染範圍內)
  let ticks = [];
  let lastFocus = -1;

  const count = () => allDates.length;
  const clamp = (v) => Math.max(0, Math.min(count() - 1, v));
  const longDate = (date) => new Date(date).toLocaleDateString(cfgLocale(),
    { year: "numeric", month: "long", day: "numeric", weekday: "long", timeZone: "UTC" });
  const shortDate = (date) => new Date(date).toLocaleDateString(cfgLocale(),
    { month: "long", day: "numeric", weekday: "short", timeZone: "UTC" });
  const tripsLabel = (entry) => `${entry.trip_count} 趟 · ${fmtDuration(entry.total_sec || 0)}`;

  window.setTimeMachineReady = (ready) => {
    document.querySelectorAll(".tm-launch").forEach((button) => { button.disabled = !ready; });
  };
  window.resetTimeMachineCache = () => cache.clear();

  /* ── 視窗建立 / 回收 ─────────────────────────────────────────────── */
  function makeWindow(i) {
    const entry = allDates[i];
    const el = document.createElement("article");
    el.className = "tm-card";
    el.dataset.index = String(i);
    el.tabIndex = -1;
    el.setAttribute("aria-label", `${longDate(entry.date)}，${entry.trip_count} 趟`);
    el.innerHTML = `
      <header class="tm-win-bar">
        <span class="tm-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="tm-win-heading"><b>${escapeHtml(shortDate(entry.date))}</b><small>${escapeHtml(new Date(entry.date).getUTCFullYear() + " 年")}</small></span>
        <span class="tm-win-pill">${escapeHtml(tripsLabel(entry))}</span>
      </header>
      <div class="tm-win-body">
        <div class="tm-day" aria-hidden="true"><div class="tm-day-track"></div>
          <div class="tm-day-hours"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div></div>
        <div class="tm-grid"></div>
      </div>
      <div class="tm-shade" aria-hidden="true"></div>`;
    el.style.display = "none";
    stage.append(el);
    return el;
  }
  function syncWindows() {
    const focus = Math.round(pos);
    const lo = Math.max(0, Math.floor(pos) - AHEAD);
    const hi = Math.min(count() - 1, focus + BEHIND);
    for (const [i, el] of windows) {
      if (i < lo || i > hi) { el.remove(); windows.delete(i); }
    }
    for (let i = lo; i <= hi; i++) if (!windows.has(i)) windows.set(i, makeWindow(i));
  }

  /* ── 版面:依深度計算每扇視窗的 3D 位置(每格只寫有變化的值) ─────── */
  // 尺寸只在開啟/縮放視窗時量一次:動畫中每格讀 clientHeight 會強制同步排版(layout thrash)
  let cachedMetrics = null;
  function metrics() {
    if (!cachedMetrics) {
      const h = stage.clientHeight || innerHeight;
      const phone = innerWidth <= 760;
      cachedMetrics = { lift: h * (phone ? 0.03 : 0.034), depth: phone ? 150 : 230 };
    }
    return cachedMetrics;
  }
  function layout() {
    syncWindows();
    const { lift, depth } = metrics();
    const focus = Math.round(pos);
    for (const [i, card] of windows) {
      const d = i - pos;                       // >0:更早(往後退);<0:已穿過(朝觀看者飛出)
      const visible = d > -1.05 && d < BEHIND;
      const state = card._tm || (card._tm = {});
      if (!visible) {
        if (state.shown !== false) { card.style.display = "none"; state.shown = false; }
        if (state.front) {
          state.front = state.isFront = false;
          card.tabIndex = -1;
          card.setAttribute("aria-hidden", "true");
          card.removeAttribute("aria-current");
          card.classList.remove("is-front");
        }
        continue;
      }
      if (state.shown !== true) { card.style.display = "flex"; state.shown = true; }
      let y, z, opacity, shade;
      if (d >= 0) {
        y = -d * lift;
        z = -d * depth;
        opacity = d > BEHIND - 2 ? Math.max(0, BEHIND - d) / 2 : 1;
        shade = Math.min(0.62, d * 0.14);
      } else {
        const t = -d;
        y = t * lift * 3;
        z = t * depth * 1.5;
        opacity = Math.max(0, 1 - t * 2.4);
        shade = 0;
      }
      const transform = `translate3d(-50%, ${y.toFixed(1)}px, ${z.toFixed(0)}px)`;
      if (state.transform !== transform) card.style.transform = state.transform = transform;
      const op = opacity.toFixed(2);
      if (state.opacity !== op) card.style.opacity = state.opacity = op;
      const sh = shade.toFixed(2);
      if (state.shade !== sh) (card._shade ||= card.querySelector(".tm-shade")).style.opacity = state.shade = sh;
      const zi = String(1000 - Math.round(d * 10));
      if (state.z !== zi) card.style.zIndex = state.z = zi;
      const pe = d > -0.4 && d < BEHIND - 1.5 ? "auto" : "none";
      if (state.pe !== pe) card.style.pointerEvents = state.pe = pe;
      const front = i === focus;
      const isFront = front && Math.abs(d) < 0.5;
      if (state.front !== front) {
        state.front = front;
        card.tabIndex = front ? 0 : -1;
        card.setAttribute("aria-hidden", String(!front));
        if (front) card.setAttribute("aria-current", "date");
        else card.removeAttribute("aria-current");
      }
      if (state.isFront !== isFront) card.classList.toggle("is-front", state.isFront = isFront);
    }
    if (focus !== lastFocus) {
      if (ticks[lastFocus]) ticks[lastFocus].classList.remove("is-current");
      if (ticks[focus]) ticks[focus].classList.add("is-current");
      lastFocus = focus;
    }
  }

  /* ── 彈簧動畫 ──────────────────────────────────────────────────────── */
  function settleFill() {
    for (let k = index - 1; k <= index + 2; k++) if (k >= 0 && k < count()) void fill(k);
  }
  function step(ts) {
    const dt = Math.min(0.032, (ts - (lastTs || ts)) / 1000) || 0.016;
    lastTs = ts;
    if (reduceMotion.matches) {
      pos = target;
      vel = 0;
    } else {
      const k = 150;
      const c = 2 * Math.sqrt(k) * 1.02;     // 略高於臨界阻尼:絲滑、不回彈
      vel += (k * (target - pos) - c * vel) * dt;
      pos += vel * dt;
    }
    const settled = Math.abs(target - pos) < 0.0015 && Math.abs(vel) < 0.002;
    if (settled) { pos = target; vel = 0; }
    layout();
    if (settled) {
      raf = 0;
      lastTs = 0;
      stage.classList.remove("moving");
      settleFill();
      return;
    }
    raf = requestAnimationFrame(step);
  }
  function kick() {
    stage.classList.add("moving");
    if (!raf) raf = requestAnimationFrame(step);
  }
  function goTo(i, { snap = true } = {}) {
    if (!count()) return;
    target = snap ? clamp(Math.round(i)) : clamp(i);
    // 遠距跳轉:先瞬移到目標前幾扇,再以彈簧滑入
    const far = 4;
    if (Math.abs(target - pos) > far && !reduceMotion.matches) {
      pos = target - Math.sign(target - pos) * far;
      vel = Math.sign(target - pos) * 3;
    }
    if (snap) commit(target);
    kick();
    // 保底:掉幀或分頁在背景時,仍保證最後停在選定的日期
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (dialog.hidden || Math.abs(target - pos) < 0.01) return;
      cancelAnimationFrame(raf);
      raf = 0;
      lastTs = 0;
      pos = target;
      vel = 0;
      layout();
      stage.classList.remove("moving");
      settleFill();
    }, 1400);
  }
  function commit(i) {
    if (i === index && dialog.dataset.ready === "1") return;
    index = i;
    dialog.dataset.ready = "1";
    const entry = allDates[i];
    document.getElementById("tm-title").textContent = longDate(entry.date);
    document.getElementById("tm-sub").textContent = tripsLabel(entry);
  }

  /* ── 視窗內容:24 小時時間帶 + 一次放得下的格狀排版(不需二次捲動) ─── */
  function bestGrid(n, w, h) {
    let best = { cols: 1, rows: n, size: 0 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const size = Math.min(w / cols, (h / rows) * 1.6);   // 以 16:10 的磚為目標比例
      if (size > best.size) best = { cols, rows, size };
    }
    return best;
  }
  function gColor(g) {
    return g >= 2.5 ? "var(--crit)" : g >= 1.8 ? "var(--warn)" : "var(--accent)";
  }
  async function fill(i) {
    const card = windows.get(i);
    if (!card || card.dataset.filled) return;
    card.dataset.filled = "1";
    const grid = card.querySelector(".tm-grid");
    const track = card.querySelector(".tm-day-track");
    const date = allDates[i].date;
    const key = `${currentOwner}:${date}`;
    try {
      let data = cache.get(key);
      if (!data) {
        data = await apiFetch(`/api/trips?date=${encodeURIComponent(date)}&owner=${encodeURIComponent(currentOwner)}&limit=${MAX_TILES}&offset=0`);
        cache.set(key, data);
      }
      if (dialog.hidden || windows.get(i) !== card) return;
      const trips = [...data.trips].sort((a, b) => a.start_epoch - b.start_epoch);
      // 時間帶:每趟依開始/結束時刻畫在 0–24 時上,顏色代表晃動強度
      track.innerHTML = trips.map((tr) => {
        const s = ((tr.start_epoch % 86400) + 86400) % 86400;
        const left = s / 864;
        const width = Math.max(0.6, Math.min(100 - left, (tr.duration_sec || 0) / 864));
        return `<i style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;background:${gColor(tr.peak_gforce || 0)}" title="${fmtTime(tr.start_epoch)}–${fmtTime(tr.end_epoch)}"></i>`;
      }).join("");
      if (!trips.length) {
        grid.innerHTML = `<div class="tm-empty">${t("browse.noTripThisDay")}</div>`;
        return;
      }
      const gw = grid.clientWidth || 800, gh = grid.clientHeight || 360;
      const total = data.total || trips.length;
      // 放不下時(磚太小)減少顯示數量,最後一格改成「+N 趟」——永遠不需要捲動
      const minTile = innerWidth <= 760 ? 44 : 58;
      let shown = trips.length;
      let layoutGrid = bestGrid(shown + (total > shown ? 1 : 0), gw, gh);
      while (shown > 1 && gh / layoutGrid.rows < minTile) {
        shown--;
        layoutGrid = bestGrid(shown + 1, gw, gh);
      }
      trips.length = shown;
      const more = Math.max(0, total - shown);
      const n = shown + (more ? 1 : 0);
      const { cols, rows } = layoutGrid;
      grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
      grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
      grid.classList.toggle("dense", n > 6);
      grid.innerHTML = trips.map((tr) => `
        <a class="tm-trip" href="/trip/${encodeURIComponent(tr.trip_id)}">
          <img loading="lazy" decoding="async" alt="" src="/video/${encodeURIComponent(tr.trip_id)}/thumbnail" onerror="this.remove()">
          <span class="tm-trip-info"><b>${fmtTime(tr.start_epoch)}</b><small>${fmtDuration(tr.duration_sec)}${tr.peak_gforce > 0 ? ` · ${tr.peak_gforce.toFixed(1)}g` : ""}</small></span>
        </a>`).join("") + (more ? `<button type="button" class="tm-trip tm-more">+${more} 趟<small>查看這天</small></button>` : "");
    } catch (error) {
      delete card.dataset.filled;
      grid.innerHTML = `<div class="tm-empty">${t("common.loadFail")}：${escapeHtml(error.message)}</div>`;
    }
  }

  function buildTimeline() {
    // 最新在下、越早越往上(與 Time Machine 相同);月份交界顯示標籤
    let prevMonth = "";
    timeline.innerHTML = allDates.map((entry, i) => {
      const month = entry.date.slice(0, 7);
      const boundary = month !== prevMonth;
      prevMonth = month;
      const d = new Date(entry.date);
      const label = boundary
        ? d.toLocaleDateString(cfgLocale(), { year: i === 0 || d.getUTCMonth() === 0 ? "numeric" : undefined, month: "short", timeZone: "UTC" })
        : `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
      return `<li data-index="${i}" class="${boundary ? "is-month" : ""}"><button type="button" tabindex="-1" aria-label="${escapeHtml(longDate(entry.date))}">
        <span class="tm-tick-label">${escapeHtml(i === 0 ? "最近" : label)}</span><span class="tm-tick"></span></button></li>`;
    }).join("");
    ticks = [...timeline.querySelectorAll("li")];
    lastFocus = -1;
    const every = Math.max(1, Math.ceil(ticks.filter((li) => li.classList.contains("is-month")).length / 14));
    let n = 0;
    ticks.forEach((li) => { if (li.classList.contains("is-month") && n++ % every) li.classList.add("is-quiet"); });
  }

  /* ── 開啟 / 關閉 ───────────────────────────────────────────────────── */
  window.openTimeMachine = function openTimeMachine() {
    if (!count() || !dialog.hidden) return;
    previousFocus = document.activeElement;
    const selected = decodeURIComponent(location.hash.slice(1));
    const start = Math.max(0, allDates.findIndex((d) => d.date === selected));
    stage.replaceChildren();
    windows.clear();
    buildTimeline();
    dialog.dataset.ready = "";
    dialog.hidden = false;
    cachedMetrics = null;
    metrics();
    document.body.classList.add("tm-open");
    document.querySelector("header.hdr").inert = true;
    document.querySelector(".page-body").inert = true;
    requestAnimationFrame(() => dialog.classList.add("is-open"));
    pos = reduceMotion.matches ? start : start - 0.9;
    target = start;
    vel = 0;
    index = -1;
    layout();
    goTo(start);
    stage.focus({ preventScroll: true });
  };
  window.closeTimeMachine = function closeTimeMachine() {
    if (dialog.hidden) return;
    cancelAnimationFrame(raf);
    raf = 0;
    lastTs = 0;
    clearTimeout(wheelTimer);
    clearTimeout(settleTimer);
    dialog.classList.remove("is-open");
    dialog.hidden = true;
    stage.replaceChildren();
    windows.clear();
    document.body.classList.remove("tm-open");
    document.querySelector("header.hdr").inert = false;
    document.querySelector(".page-body").inert = false;
    previousFocus?.focus?.();
  };

  /* ── 輸入:滾輪 / 觸控板、拖曳、鍵盤、時間軸 ───────────────────────── */
  // 視窗內容一次放得下,滾輪一律用來穿越時間(不再與視窗內捲動搶手勢)
  dialog.addEventListener("wheel", (event) => {
    if (dialog.hidden || count() < 2) return;
    event.preventDefault();
    const vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
    const delta = vertical ? event.deltaY : event.deltaX;
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
    target = clamp(target + Math.max(-1.4, Math.min(1.4, (delta * unit) / 160)));
    kick();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => goTo(target), 140);
  }, { passive: false });

  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || count() < 2) return;
    clearTimeout(wheelTimer);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: target, moved: false, t: performance.now(), last: target, v: 0 };
  });
  stage.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    const dist = Math.abs(dy) >= Math.abs(dx) ? dy : -dx;
    if (!drag.moved && Math.abs(dist) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      stage.setPointerCapture(event.pointerId);
      stage.classList.add("dragging");
    }
    const now = performance.now();
    const next = clamp(drag.start + dist / (metrics().lift * 4));
    drag.v = (next - drag.last) / Math.max(1, now - drag.t) * 1000;
    drag.last = next;
    drag.t = now;
    target = next;
    kick();
  });
  function endDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    if (drag.moved) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 120);
      goTo(target + Math.max(-3, Math.min(3, (drag.v || 0) * 0.12)));   // 甩動慣性
    }
    drag = null;
    stage.classList.remove("dragging");
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  }
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("click", (event) => {
    if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; return; }
    const card = event.target.closest(".tm-card");
    if (!card) return;
    const i = Number(card.dataset.index);
    if (i !== index) { event.preventDefault(); goTo(i); return; }   // 點後方視窗 = 回到那天
    if (event.target.closest(".tm-more")) { event.preventDefault(); openDay(); }
  }, true);
  stage.addEventListener("dblclick", (event) => {
    const card = event.target.closest(".tm-card.is-front");
    if (card && !event.target.closest("a")) openDay();
  });

  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeTimeMachine(); return; }
    if (event.key === "Enter" && event.target === stage) { event.preventDefault(); openDay(); return; }
    const move = { ArrowUp: 1, ArrowRight: 1, PageUp: 1, ArrowDown: -1, ArrowLeft: -1, PageDown: -1 }[event.key];
    if (move !== undefined && !event.target.closest(".tm-bar")) {
      event.preventDefault();
      goTo(index + move);
      return;
    }
    if (event.key === "Home") { event.preventDefault(); goTo(0); return; }
    if (event.key === "End") { event.preventDefault(); goTo(count() - 1); return; }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll("button:not([disabled]):not([tabindex='-1']), a[href], [tabindex='0']")]
      .filter((element) => element.getClientRects().length && !element.closest("[aria-hidden='true']"));
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  document.getElementById("tm-older").addEventListener("click", () => goTo(index + 1));
  document.getElementById("tm-newer").addEventListener("click", () => goTo(index - 1));

  // 時間軸是一條拖曳條:點或沿著它拖曳,依垂直位置換算日期(由下=最新往上=較早均分)
  function nearestTick(clientY) {
    const r = timeline.getBoundingClientRect();
    if (!ticks.length || !r.height) return 0;
    const ratio = Math.max(0, Math.min(1, (r.bottom - clientY) / r.height));
    return clamp(Math.floor(ratio * ticks.length - 1e-9));
  }
  let scrubbing = null;
  let hovered = null;
  timeline.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !ticks.length) return;
    event.preventDefault();
    scrubbing = event.pointerId;
    timeline.setPointerCapture(event.pointerId);
    goTo(nearestTick(event.clientY));
  });
  timeline.addEventListener("pointermove", (event) => {
    const i = nearestTick(event.clientY);
    if (scrubbing === event.pointerId && i !== index) goTo(i);
    if (event.pointerType !== "mouse") return;
    // 只標記最接近的刻度,不逐一量測每個刻度(避免卡頓)
    if (hovered !== ticks[i]) {
      hovered?.classList.remove("is-hover");
      hovered = ticks[i];
      hovered?.classList.add("is-hover");
    }
  });
  const endScrub = (event) => {
    if (scrubbing !== event.pointerId) return;
    scrubbing = null;
    if (timeline.hasPointerCapture(event.pointerId)) timeline.releasePointerCapture(event.pointerId);
  };
  timeline.addEventListener("pointerup", endScrub);
  timeline.addEventListener("pointercancel", endScrub);
  timeline.addEventListener("pointerleave", () => { hovered?.classList.remove("is-hover"); hovered = null; });

  function openDay() {
    const date = allDates[index]?.date;
    closeTimeMachine();
    if (date) selectDate(date);
  }
  document.getElementById("tm-open-day").addEventListener("click", openDay);
  addEventListener("resize", () => {
    cachedMetrics = null;
    if (dialog.hidden) return;
    for (const el of windows.values()) delete el.dataset.filled;   // 依新尺寸重排格線
    layout();
    settleFill();
  });
})();
