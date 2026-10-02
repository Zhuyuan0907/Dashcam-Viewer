/* ── 時光機:仿 macOS Time Machine 的時間穿越瀏覽 ───────────────────────────────
 * 每個騎乘日是一扇視窗,越早的日期越往畫面深處(上方)退去;捲動 / 拖曳 / 方向鍵
 * 會以臨界阻尼彈簧推動整疊視窗,穿過的視窗朝觀看者飛出並淡去。右側時間軸可直接跳轉,
 * 滑過時像 Dock 一樣放大。依賴 browse.html 的 allDates、currentOwner、selectDate。 */
(() => {
  const dialog = document.getElementById("time-machine");
  const stage = document.getElementById("tm-stage");
  const timeline = document.getElementById("tm-timeline");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const cache = new Map();

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
  let cards = [];
  let ticks = [];

  const count = () => allDates.length;
  const clamp = (v) => Math.max(0, Math.min(count() - 1, v));
  const longDate = (date) => new Date(date).toLocaleDateString(cfgLocale(),
    { year: "numeric", month: "long", day: "numeric", weekday: "long", timeZone: "UTC" });
  const tripsLabel = (entry) => `${entry.trip_count} 趟 · ${fmtDuration(entry.total_sec || 0)}`;

  window.setTimeMachineReady = (ready) => {
    document.querySelectorAll(".tm-launch").forEach((button) => { button.disabled = !ready; });
  };
  window.resetTimeMachineCache = () => cache.clear();

  /* ── 版面:依深度計算每扇視窗的 3D 位置 ─────────────────────────────── */
  function metrics() {
    const h = stage.clientHeight || innerHeight;
    const phone = innerWidth <= 760;
    return { lift: h * (phone ? 0.03 : 0.032), depth: phone ? 150 : 230 };
  }
  function layout() {
    const { lift, depth } = metrics();
    const focus = Math.round(pos);
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const d = i - pos;                       // >0:更早(往後退);<0:已穿過(朝觀看者飛出)
      const visible = d > -1.05 && d < 6;
      if (!visible) {
        if (card.style.display !== "none") {
          card.style.display = "none";          // 不渲染、不佔合成圖層
          card.style.visibility = "hidden";
          card.setAttribute("aria-hidden", "true");
          card.removeAttribute("aria-current");
          card.classList.remove("is-front");
          card.tabIndex = -1;
          card._tm = null;
        }
        continue;
      }
      if (card.style.display !== "flex") card.style.display = "flex";
      card.style.visibility = "visible";
      let y, z, opacity, shade;
      if (d >= 0) {
        y = -d * lift;
        z = -d * depth;
        opacity = d > 4 ? Math.max(0, 6 - d) / 2 : 1;
        shade = Math.min(0.6, d * 0.13);
      } else {
        const t = -d;                          // 0..1
        y = t * lift * 3;
        z = t * depth * 1.5;
        opacity = Math.max(0, 1 - t * 2.4);
        shade = 0;
      }
      // 只在數值改變時寫入 DOM,避免每格都觸發樣式重算;變暗用獨立合成層的 opacity,不重繪視窗內容
      const state = card._tm || (card._tm = {});
      const transform = `translate3d(-50%, ${y.toFixed(2)}px, ${z.toFixed(1)}px)`;
      if (state.transform !== transform) card.style.transform = state.transform = transform;
      const op = opacity.toFixed(3);
      if (state.opacity !== op) card.style.opacity = state.opacity = op;
      const sh = shade.toFixed(3);
      if (state.shade !== sh) { (card._shade ||= card.querySelector(".tm-shade")).style.opacity = state.shade = sh; }
      const zi = String(1000 - Math.round(d * 10));
      if (state.z !== zi) card.style.zIndex = state.z = zi;
      const pe = d > -0.4 && d < 4.5 ? "auto" : "none";
      if (state.pe !== pe) card.style.pointerEvents = state.pe = pe;
      const hidden = Math.abs(d) < 0.5 ? "false" : "true";
      if (state.hidden !== hidden) card.setAttribute("aria-hidden", state.hidden = hidden);
      const front = i === focus;
      if (state.front !== front) {
        state.front = front;
        card.tabIndex = front ? 0 : -1;
        if (front) card.setAttribute("aria-current", "date");
        else card.removeAttribute("aria-current");
      }
      const isFront = front && Math.abs(d) < 0.5;
      if (state.isFront !== isFront) card.classList.toggle("is-front", state.isFront = isFront);
    }
    // 時間軸指示
    const at = clamp(Math.round(pos));
    for (let i = 0; i < ticks.length; i++) ticks[i].classList.toggle("is-current", i === at);
  }

  /* ── 彈簧動畫 ──────────────────────────────────────────────────────── */
  function step(ts) {
    const dt = Math.min(0.032, (ts - (lastTs || ts)) / 1000) || 0.016;
    lastTs = ts;
    if (reduceMotion.matches) {
      pos = target;
      vel = 0;
    } else {
      const k = 150;                          // 剛性
      const c = 2 * Math.sqrt(k) * 1.02;      // 略高於臨界阻尼:絲滑、不回彈
      const a = k * (target - pos) - c * vel;
      vel += a * dt;
      pos += vel * dt;
    }
    layout();
    const settled = Math.abs(target - pos) < 0.0015 && Math.abs(vel) < 0.002;
    if (settled) {
      pos = target;
      layout();
      raf = 0;
      lastTs = 0;
      return;
    }
    raf = requestAnimationFrame(step);
  }
  function kick() {
    if (!raf) raf = requestAnimationFrame(step);
  }
  /** 移動到第 i 天(吸附)。 */
  function goTo(i, { snap = true } = {}) {
    if (!count()) return;
    target = snap ? clamp(Math.round(i)) : clamp(i);
    // 遠距跳轉:先瞬移到目標前幾扇,再以彈簧滑入,避免一路渲染幾十扇視窗
    const far = 5;
    if (Math.abs(target - pos) > far && !reduceMotion.matches) {
      pos = target - Math.sign(target - pos) * far;
      vel = Math.sign(target - pos) * 4;
    }
    if (snap) commit(target);
    kick();
    // 保底:裝置太忙、掉幀或分頁在背景時,仍保證最後停在選定的日期
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (dialog.hidden || Math.abs(target - pos) < 0.01) return;
      cancelAnimationFrame(raf);
      raf = 0;
      lastTs = 0;
      pos = target;
      vel = 0;
      layout();
    }, 1400);
  }
  function commit(i) {
    if (i === index && dialog.dataset.ready === "1") return;
    index = i;
    dialog.dataset.ready = "1";
    const entry = allDates[i];
    document.getElementById("tm-title").textContent = longDate(entry.date);
    document.getElementById("tm-sub").textContent = tripsLabel(entry);
    for (let k = i - 1; k <= i + 3; k++) if (k >= 0 && k < count()) void fill(k);
  }

  /* ── 視窗內容(延遲載入當日旅程) ───────────────────────────────────── */
  async function fill(i) {
    const card = cards[i];
    if (!card || card.dataset.filled) return;
    card.dataset.filled = "1";
    const body = card.querySelector(".tm-win-body");
    const date = allDates[i].date;
    const key = `${currentOwner}:${date}`;
    try {
      let data = cache.get(key);
      if (!data) {
        data = await apiFetch(`/api/trips?date=${encodeURIComponent(date)}&owner=${encodeURIComponent(currentOwner)}&limit=24&offset=0`);
        cache.set(key, data);
      }
      if (dialog.hidden || cards[i] !== card) return;
      body.innerHTML = data.trips.length
        ? `<div class="trips-grid">${data.trips.map(renderTripCard).join("")}</div>`
        : `<div class="tm-empty">${t("browse.noTripThisDay")}</div>`;
    } catch (error) {
      delete card.dataset.filled;
      body.innerHTML = `<div class="tm-empty">${t("common.loadFail")}：${escapeHtml(error.message)}</div>`;
    }
  }

  function buildCards() {
    stage.innerHTML = allDates.map((entry, i) => `
      <article class="tm-card" data-index="${i}" aria-label="${escapeHtml(longDate(entry.date))}，${entry.trip_count} 趟">
        <header class="tm-win-bar">
          <span class="tm-dots" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="tm-win-title">${escapeHtml(longDate(entry.date))}</span>
          <span class="tm-win-meta">${escapeHtml(tripsLabel(entry))}</span>
        </header>
        <div class="tm-win-body"><div class="tm-skeleton" aria-hidden="true"><i></i><i></i><i></i></div></div>
        <div class="tm-shade" aria-hidden="true"></div>
      </article>`).join("");
    cards = [...stage.querySelectorAll(".tm-card")];
  }

  function buildTimeline() {
    // 最新在下、越早越往上(與 Time Machine 相同);月份交界與目前日期顯示標籤
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
    // 太多日期時,只顯示部分月份標籤以免擁擠
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
    buildCards();
    buildTimeline();
    dialog.dataset.ready = "";
    dialog.hidden = false;
    document.body.classList.add("tm-open");
    document.querySelector("header.hdr").inert = true;
    document.querySelector(".page-body").inert = true;
    requestAnimationFrame(() => dialog.classList.add("is-open"));
    // 進場:整疊視窗從觀看者這端滑入定位
    pos = reduceMotion.matches ? start : start - 0.9;
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
    stage.innerHTML = "";
    cards = [];
    document.body.classList.remove("tm-open");
    document.querySelector("header.hdr").inert = false;
    document.querySelector(".page-body").inert = false;
    previousFocus?.focus?.();
  };

  /* ── 輸入:滾輪 / 觸控板、拖曳、鍵盤、時間軸 ───────────────────────── */
  function scrollableInside(element, delta) {
    const body = element.closest?.(".tm-card.is-front .tm-win-body");
    if (!body || body.scrollHeight <= body.clientHeight + 2) return false;
    return delta > 0 ? body.scrollTop + body.clientHeight < body.scrollHeight - 1 : body.scrollTop > 0;
  }
  dialog.addEventListener("wheel", (event) => {
    if (dialog.hidden || count() < 2) return;
    const vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
    const delta = vertical ? event.deltaY : event.deltaX;
    if (vertical && scrollableInside(event.target, delta)) return;   // 讓前景視窗內容自己捲
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
    target = clamp(target + Math.max(-1.4, Math.min(1.4, (delta * unit) / 160)));
    kick();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => goTo(target), 140);
  }, { passive: false });

  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || count() < 2) return;
    if (event.target.closest(".tm-card.is-front .tm-win-body") && event.pointerType !== "mouse") return;
    clearTimeout(wheelTimer);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: target, moved: false, t: performance.now(), last: target };
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
    const next = clamp(drag.start + dist / (metrics().lift * 1.6));
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
    if (i !== index) { event.preventDefault(); goTo(i); }   // 點後方視窗 = 回到那天
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

  // 時間軸是一條拖曳條:點或沿著它拖曳,依垂直位置挑最近的日期(刻度很密時也點得準)
  function nearestTick(clientY) {
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < ticks.length; i++) {
      const r = ticks[i].getBoundingClientRect();
      const dist = Math.abs(r.top + r.height / 2 - clientY);
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return best;
  }
  let scrubbing = null;
  timeline.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !ticks.length) return;
    event.preventDefault();
    scrubbing = event.pointerId;
    timeline.setPointerCapture(event.pointerId);
    goTo(nearestTick(event.clientY));
  });
  timeline.addEventListener("pointermove", (event) => {
    if (scrubbing !== event.pointerId) return;
    const i = nearestTick(event.clientY);
    if (i !== index) goTo(i);
  });
  const endScrub = (event) => {
    if (scrubbing !== event.pointerId) return;
    scrubbing = null;
    if (timeline.hasPointerCapture(event.pointerId)) timeline.releasePointerCapture(event.pointerId);
  };
  timeline.addEventListener("pointerup", endScrub);
  timeline.addEventListener("pointercancel", endScrub);
  // Dock 式放大:滑鼠附近的刻度放大
  timeline.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse") return;
    const near = nearestTick(event.clientY);
    for (let i = 0; i < ticks.length; i++) {
      const li = ticks[i];
      const r = li.getBoundingClientRect();
      const mag = Math.max(0, 1 - Math.abs(r.top + r.height / 2 - event.clientY) / 70);
      li.style.setProperty("--mag", mag.toFixed(3));
      li.classList.toggle("is-hover", i === near);
    }
  });
  timeline.addEventListener("pointerleave", () => ticks.forEach((li) => { li.style.setProperty("--mag", "0"); li.classList.remove("is-hover"); }));

  function openDay() {
    const date = allDates[index]?.date;
    closeTimeMachine();
    if (date) selectDate(date);
  }
  document.getElementById("tm-open-day").addEventListener("click", openDay);
  addEventListener("resize", () => { if (!dialog.hidden) layout(); });
})();
