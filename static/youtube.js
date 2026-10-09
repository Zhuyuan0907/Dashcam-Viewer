/* YouTube 上傳精靈：選擇影片 → 標題與隱私 → 確認送出。
 * 連結頻道不在步驟內：未連結時改顯示連結畫面；已連結只在頁首顯示頻道。
 * 佇列、已上傳、清理本機與 OAuth 設定等管理功能在 /ops#youtube（ops-youtube.js）。 */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = escapeHtml;
  const STEPS = 3;
  const parameterNames = {
    date: "日期",
    time: "開始時間",
    end_time: "結束時間",
    camera: "鏡頭",
    trip_no: "當日趟次",
    trip_id: "旅程編號",
    device: "裝置",
    duration: "片長",
    filename: "檔名",
  };
  const statusNames = {
    queued: "排隊中",
    uploading: "上傳中",
    processing: "YouTube 處理中",
    succeeded: "已上傳",
    failed: "上傳失敗",
    missing: "YouTube 已刪除",
    not_uploaded: "尚未上傳",
    changed: "影片已更新",
    unavailable: "本機影片無法使用",
    local_processing: "本機處理中",
    needs_verification: "已送達，待確認",
  };
  const cameraName = (camera) => (camera === "front" ? "前鏡頭" : "後鏡頭");
  const WEEK = "日一二三四五六";
  let filter = "ready",
    cameraMode = "both",
    dateFilter = "";
  let reauthorize = new URLSearchParams(location.search).get("reauthorize") === "1";
  const selected = new Map();
  let step = 0,
    info = null,
    user = null,
    trips = [],
    dates = [],
    tripPage = 1,
    loadingTrips = false,
    editing = null,
    previewTimer = 0;

  const request = (url, body, method = "POST") =>
    apiFetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const notice = (msg, type = "") => {
    const el = $("yt-notice");
    el.textContent = msg || "";
    el.dataset.type = type;
  };
  const isAdmin = () => user?.role === "admin" || !!user?.is_owner;
  const connected = () => !!info?.account && !reauthorize;
  async function guarded(button, run) {
    if (button.disabled) return;
    button.disabled = true;
    try {
      notice("");
      await run();
    } catch (e) {
      notice(e.message || "操作失敗，請重試", "error");
    } finally {
      button.disabled = false;
      render();
    }
  }
  function pageSize() {
    if (innerWidth <= 760) return 4;
    if (innerWidth >= 1500) return innerHeight < 820 ? 8 : 12;
    return innerHeight < 820 ? 6 : 9;
  }
  function videoCount() {
    return [...selected.values()].reduce((n, t) => n + t.chosen.length, 0);
  }
  function canAdvance() {
    if (step === 0) return !loadingTrips && videoCount() > 0;
    if (step === 1) return !!$("yt-title").value.trim();
    if (step === 2) return videoCount() > 0 && $("yt-confirm-upload").checked;
    return true;
  }
  const dateLabel = (date) => {
    const d = new Date(`${date}T00:00:00`);
    return Number.isNaN(d.getTime())
      ? date
      : `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）`;
  };
  const clock = (ms) =>
    new Date(ms).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
  const dayTime = (ms) => {
    const d = new Date(ms),
      today = new Date();
    const diff = Math.round(
      (new Date(d.getFullYear(), d.getMonth(), d.getDate()) -
        new Date(today.getFullYear(), today.getMonth(), today.getDate())) /
        86_400_000,
    );
    const day = diff === 0 ? "今天" : diff === 1 ? "明天" : `${d.getMonth() + 1}/${d.getDate()}`;
    return `${day} ${clock(ms)}`;
  };
  const span = (ms) => {
    const minutes = Math.round(ms / 60000);
    const h = Math.floor(minutes / 60),
      m = minutes % 60;
    return h ? (m ? `${h} 小時 ${m} 分` : `${h} 小時`) : `${m} 分鐘`;
  };

  /* ── 排程估算：每日上限 N 部，平均分散時每 24h/N 一部 ───────────────── */
  function plan(count, start = Date.now()) {
    const account = info?.account;
    const limit = account?.daily_limit || 10;
    const interval = account?.spread ? 86_400_000 / limit : 0;
    const first = Math.max(start, account?.until || 0);
    const times = [];
    for (let i = 0; i < count; i++)
      times.push(interval ? first + i * interval : first + Math.floor(i / limit) * 86_400_000);
    return { limit, interval, times, last: times[times.length - 1] ?? first };
  }
  function planText(count) {
    if (!count) return "";
    const p = plan(count);
    if (!p.interval)
      return count <= p.limit
        ? `每天上限 ${p.limit} 部，這批會盡快連續上傳。`
        : `每天上限 ${p.limit} 部，這批約需 ${Math.ceil(count / p.limit)} 天。`;
    return count === 1
      ? `預計 ${dayTime(p.times[0])} 開始上傳。`
      : `平均分散上傳：每天 ${p.limit} 部、約每 ${span(p.interval)} 一部，最後一部約 ${dayTime(p.last)} 開始。`;
  }

  /* ── 畫面 ─────────────────────────────────────────────── */
  function render() {
    const done = step === "done";
    $("yt-connect-panel").hidden = connected();
    $("yt-wizard").hidden = !connected();
    $("yt-channel").hidden = !info?.account;
    if (info?.account) $("yt-channel-name").textContent = info.account.channel_title;
    if (!connected()) return;
    document.querySelectorAll("#yt-steps li").forEach((li) => {
      const i = Number(li.dataset.step);
      li.classList.toggle("is-current", i === step);
      li.classList.toggle("is-done", done || i < step);
      if (i === step) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
    for (let i = 0; i < STEPS; i++) $(`yt-step-${i}`).hidden = i !== step;
    $("yt-step-done").hidden = !done;
    $("yt-foot").hidden = done;
    if (done) return;
    $("yt-prev").style.visibility = step === 0 ? "hidden" : "visible";
    $("yt-next").textContent = step === STEPS - 1 ? "加入上傳佇列" : "下一步";
    $("yt-next").disabled = !canAdvance();
    const status = $("yt-foot-status");
    status.disabled = true;
    if (step === 2) status.textContent = canAdvance() ? "" : "請勾選確認後送出";
    else
      status.textContent = selected.size
        ? `已選 ${selected.size} 趟 · ${videoCount()} 部影片`
        : "勾選旅程或鏡頭以加入清單";
  }
  function renderAccount() {
    const configured = !!info?.configured,
      account = info?.account;
    $("yt-need-setup").hidden = configured;
    $("yt-connect-box").hidden = !configured;
    $("yt-connect-title").textContent = account
      ? `重新授權頻道：${account.channel_title}`
      : "先連結你的 YouTube 頻道";
    $("yt-connect").textContent = account ? "重新授權 Google 帳號" : "使用 Google 帳號連結";
    $("yt-connect-back").hidden = !account;
    if (!configured) {
      $("yt-need-setup-text").textContent = user?.is_owner
        ? "這是第一次使用 YouTube 功能時需要的一次性設定（約 10 分鐘），跟著維運頁的步驟做完就能回來連結頻道。"
        : "需要站台擁有者先在維運頁完成 Google 授權設定，請聯絡管理員。完成後回到這頁即可連結。";
      $("yt-go-setup").hidden = !user?.is_owner;
    }
    $("yt-channel-manage").hidden = !isAdmin();
    $("yt-connect").disabled = !$("yt-policy").checked;
    $("yt-connect-hint").hidden = $("yt-policy").checked;
  }
  async function loadAccount() {
    info = await apiFetch("/api/youtube/account");
    renderAccount();
    render();
  }
  async function loadQueueChip() {
    const chip = $("yt-queue-chip");
    try {
      const r = await apiFetch("/api/youtube/uploads?limit=1");
      const c = Object.fromEntries(r.counts.map((x) => [x.status, x.n]));
      const active = (c.queued || 0) + (c.uploading || 0) + (c.processing || 0);
      const missing = r.missing || 0;
      if (!active && !c.failed && !missing) return void (chip.hidden = true);
      chip.hidden = false;
      chip.className = "yt-chip" + (c.failed || missing ? " is-bad" : "");
      chip.textContent = [
        active ? `${info?.account?.paused ? "佇列已暫停" : "佇列中"} ${active} 部` : "",
        missing ? `YouTube 已刪除 ${missing} 部` : c.failed ? `失敗 ${c.failed} 部` : "",
        "查看進度",
      ]
        .filter(Boolean)
        .join(" · ");
      if (!isAdmin()) chip.removeAttribute("href");
    } catch {
      chip.hidden = true;
    }
  }

  const tripLabel = (t) =>
    `${t.date} ${fmtTime(t.start_epoch)}–${fmtTime(t.end_epoch)} 第 ${t.day_order} 趟`;
  const eligible = (t) =>
    Object.keys(t.cameras).filter(
      (camera) => t.cameras[camera].selectable && (cameraMode === "both" || cameraMode === camera),
    );
  function choose(t, cameras) {
    if (cameras.length) selected.set(t.trip_id, { ...t, chosen: cameras });
    else selected.delete(t.trip_id);
    $("yt-confirm-upload").checked = false;
    renderTrips();
    renderBasket();
    render();
  }
  function selectionRows(removable = false) {
    return [...selected.values()]
      .map(
        (t) => `<div class="yt-selected-item">
      <div><b>${esc(dateLabel(t.date))} ${fmtTime(t.start_epoch)}–${fmtTime(t.end_epoch)}</b>
      <small>第 ${t.day_order} 趟 · ${t.chosen.map(cameraName).join("、")}</small></div>
      ${removable ? `<button type="button" class="btn btn--ghost btn--sm" data-remove="${esc(t.trip_id)}" aria-label="移除 ${esc(tripLabel(t))}">移除</button>` : ""}</div>`,
      )
      .join("");
  }
  function renderBasket() {
    const count = videoCount();
    $("yt-basket-count").textContent = count ? `${selected.size} 趟 · ${count} 部影片` : "尚未選擇";
    $("yt-selected-list").innerHTML =
      selectionRows(true) ||
      '<p class="yt-hint">在中間勾選旅程（或單一鏡頭），會列在這裡。可以跨日期、跨頁選。</p>';
    $("yt-basket-plan").textContent = planText(count);
    $("yt-basket-plan").hidden = !count;
    $("yt-clear-selection").hidden = !selected.size;
    $("yt-basket-toggle").disabled = !selected.size;
    $("yt-selected-list")
      .querySelectorAll("[data-remove]")
      .forEach((button) => {
        button.onclick = () => {
          selected.delete(button.dataset.remove);
          renderTrips();
          renderBasket();
          render();
        };
      });
  }
  function renderDates(totals) {
    document.querySelectorAll("[data-filter]").forEach((button) => {
      button.setAttribute("aria-pressed", button.dataset.filter === filter ? "true" : "false");
      button.querySelector("span").textContent = String(totals?.[button.dataset.filter] ?? "—");
    });
    const total = dates.reduce((n, d) => n + d.trips, 0);
    const item = (value, label, n, sub = "") =>
      `<button type="button" class="yt-date" data-date="${esc(value)}" aria-pressed="${dateFilter === value}">
        <span>${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ""}</span><b>${n}</b></button>`;
    $("yt-dates").innerHTML =
      item("", "全部日期", total) +
      dates.map((d) => item(d.date, dateLabel(d.date), d.trips, d.date.slice(0, 4))).join("");
    $("yt-dates")
      .querySelectorAll("[data-date]")
      .forEach((button) => {
        button.onclick = () =>
          guarded(button, async () => {
            dateFilter = button.dataset.date;
            tripPage = 1;
            await loadTrips();
          });
      });
  }
  function cameraChip(t, camera, state, selectable, chosen) {
    if (selectable)
      return `<label class="yt-cam"><input type="checkbox" data-camera="${camera}" data-camera-trip="${esc(t.trip_id)}" ${chosen ? "checked" : ""} aria-label="${esc(tripLabel(t))} ${cameraName(camera)}"><span>${cameraName(camera)}</span>${state.status !== "not_uploaded" ? `<small>${esc(statusNames[state.status] || state.status)}</small>` : ""}</label>`;
    const label = statusNames[state.status] || state.status;
    return `<span class="yt-cam is-static s-${esc(state.status)}"><span>${cameraName(camera)}</span><small>${
      state.video_url
        ? `<a class="link" href="${esc(state.video_url)}" target="_blank" rel="noopener" title="${esc(state.title || "在 YouTube 查看")}">${esc(label)}</a>`
        : esc(label)
    }</small></span>`;
  }
  function renderTrips() {
    const selectableFilter = filter === "ready" || filter === "all";
    $("yt-trips").innerHTML = trips.length
      ? trips
          .map((t) => {
            const available = selectableFilter ? eligible(t) : [];
            const chosen = selected.get(t.trip_id)?.chosen || [];
            const cameras = Object.entries(t.cameras)
              .filter(([camera]) => cameraMode === "both" || cameraMode === camera)
              .map(([camera, state]) =>
                cameraChip(t, camera, state, available.includes(camera), chosen.includes(camera)),
              )
              .join("");
            const on = chosen.length > 0;
            return `<article class="yt-trip${on ? " is-on" : ""}${!available.length ? " is-done" : ""}">
          <label class="yt-trip-select">
            <span class="yt-thumb"><img loading="lazy" alt="" src="/video/${encodeURIComponent(t.trip_id)}/thumbnail"><em>${fmtDuration(t.duration_sec)}</em></span>
            <input type="checkbox" data-trip="${esc(t.trip_id)}" ${on && chosen.length === available.length ? "checked" : ""} ${!available.length ? "disabled" : ""} aria-label="選取 ${esc(tripLabel(t))}">
            <span class="yt-trip-main"><b>${fmtTime(t.start_epoch)}–${fmtTime(t.end_epoch)}</b>
              <small>${esc(dateLabel(t.date))} · 第 ${t.day_order} 趟 · ${esc(t.device?.nickname || t.device?.model || "行車記錄器")}</small></span>
          </label>
          <div class="yt-trip-cameras">${cameras}</div>
          <a class="yt-trip-preview link" href="/trip/${encodeURIComponent(t.trip_id)}" target="_blank" rel="noopener" aria-label="預覽 ${esc(tripLabel(t))}">預覽旅程</a>
        </article>`;
          })
          .join("")
      : `<p class="yt-empty">${
          filter === "ready"
            ? "沒有待上傳的旅程。切換到「全部」可以查看已上傳或排隊中的旅程。"
            : '沒有符合條件的旅程。可先到 <a class="link" href="/upload">匯入影片</a>。'
        }</p>`;
    $("yt-select-page").disabled = !selectableFilter || !trips.some((t) => eligible(t).length);
    $("yt-trips")
      .querySelectorAll(".yt-thumb img")
      .forEach((img) => {
        img.onerror = () => {
          img.style.visibility = "hidden";
        };
      });
    $("yt-trips")
      .querySelectorAll("[data-trip]")
      .forEach((input) => {
        const t = trips.find((t) => t.trip_id === input.dataset.trip);
        const count = selected.get(t.trip_id)?.chosen.length || 0;
        input.indeterminate = count > 0 && count < eligible(t).length;
        input.onchange = () => choose(t, input.checked ? eligible(t) : []);
      });
    $("yt-trips")
      .querySelectorAll("[data-camera]")
      .forEach((input) => {
        input.onchange = () => {
          const t = trips.find((t) => t.trip_id === input.dataset.cameraTrip);
          const current = selected.get(t.trip_id)?.chosen || [];
          choose(
            t,
            input.checked
              ? [...current, input.dataset.camera]
              : current.filter((c) => c !== input.dataset.camera),
          );
        };
      });
  }
  let tripLoad = 0;
  async function loadTrips() {
    const seq = ++tripLoad;
    loadingTrips = true;
    $("yt-next").disabled = true;
    $("yt-trips").setAttribute("aria-busy", "true");
    const limit = pageSize();
    const query = new URLSearchParams({
      limit,
      offset: (tripPage - 1) * limit,
      filter,
      camera: cameraMode,
    });
    if (dateFilter) query.set("date", dateFilter);
    try {
      const result = await apiFetch(`/api/youtube/trips?${query}`);
      if (seq !== tripLoad) return;
      trips = result.trips;
      dates = result.dates || [];
      if (dateFilter && !dates.some((d) => d.date === dateFilter) && !trips.length) {
        dateFilter = "";
        tripPage = 1;
        return void (await loadTrips());
      }
      tripPage = Math.floor(result.offset / limit) + 1;
      for (const t of trips) {
        const current = selected.get(t.trip_id);
        if (current) {
          const chosen = current.chosen.filter(
            (c) => eligible(t).includes(c) && current.cameras[c].revision === t.cameras[c].revision,
          );
          if (chosen.length) selected.set(t.trip_id, { ...t, chosen });
          else selected.delete(t.trip_id);
        }
      }
      renderDates(result.totals);
      $("yt-filter-hint").textContent =
        filter === "ready"
          ? "只列出還有鏡頭需要上傳的旅程；已上傳或排隊中的鏡頭不會重複上傳。"
          : "列出所有旅程與每個鏡頭的狀態；只有尚未上傳或需要重傳的鏡頭可以勾選。";
      renderTrips();
      renderBasket();
      pager(result.total, limit);
    } finally {
      if (seq === tripLoad) {
        loadingTrips = false;
        $("yt-trips").removeAttribute("aria-busy");
        render();
      }
    }
  }
  async function refreshSelection() {
    const entries = [...selected.values()];
    let changed = false;
    for (let i = 0; i < entries.length; i += 50) {
      const chunk = entries.slice(i, i + 50);
      const result = await apiFetch(
        `/api/youtube/trips?filter=all&limit=50&ids=${encodeURIComponent(chunk.map((t) => t.trip_id).join("\n"))}`,
      );
      for (const old of chunk) {
        const t = result.trips.find((t) => t.trip_id === old.trip_id);
        const chosen = t
          ? old.chosen.filter(
              (c) => t.cameras[c]?.selectable && old.cameras[c].revision === t.cameras[c].revision,
            )
          : [];
        if (chosen.length !== old.chosen.length) changed = true;
        if (chosen.length) selected.set(t.trip_id, { ...t, chosen });
        else selected.delete(old.trip_id);
      }
    }
    if (changed) {
      step = 0;
      await loadTrips();
      throw new Error("部分影片已加入佇列、已上傳或內容已變更，已移出清單。請確認剩餘影片後繼續。");
    }
  }
  function pager(total, limit) {
    const pages = Math.max(1, Math.ceil(total / limit)),
      el = $("yt-trip-pager");
    el.replaceChildren();
    if (pages === 1) return;
    const mk = (label, target, disabled) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn--ghost btn--sm";
      b.textContent = label;
      b.disabled = disabled;
      b.onclick = () =>
        guarded(b, async () => {
          tripPage = target;
          await loadTrips();
        });
      return b;
    };
    const label = document.createElement("span");
    label.textContent = `第 ${tripPage} / ${pages} 頁`;
    el.append(
      mk("上一頁", tripPage - 1, tripPage <= 1),
      label,
      mk("下一頁", tripPage + 1, tripPage >= pages),
    );
  }

  /* ── 範本自動儲存：有更動才送出，停止輸入 0.8 秒後儲存 ───────────── */
  let savedTemplates = null,
    saveTimer = 0,
    saving = null;
  const currentTemplates = () => ({
    title_template: $("yt-title").value,
    description_template: $("yt-description").value,
  });
  const sameTemplates = (a, b) =>
    !!a &&
    !!b &&
    a.title_template === b.title_template &&
    a.description_template === b.description_template;
  function renderSaveState(text, type = "") {
    const el = $("yt-save-state");
    el.textContent = text;
    el.dataset.type = type;
    $("yt-reset-template").hidden = sameTemplates(currentTemplates(), info.defaults.builtin);
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    if (sameTemplates(currentTemplates(), savedTemplates)) return renderSaveState(savedLabel());
    renderSaveState("尚未儲存的變更…");
    saveTimer = setTimeout(() => void saveTemplates(), 800);
  }
  const savedLabel = () =>
    info.defaults.saved_at
      ? `已自動儲存 ${new Date(info.defaults.saved_at).toLocaleString("zh-TW", { hour12: false })}`
      : "使用預設範本";
  async function saveTemplates() {
    clearTimeout(saveTimer);
    const next = currentTemplates();
    if (sameTemplates(next, savedTemplates)) return;
    if (!next.title_template.trim()) return renderSaveState("標題不能空白，尚未儲存", "error");
    if (saving) await saving.catch(() => {});
    renderSaveState("儲存中…");
    saving = request("/api/youtube/templates", next, "PUT");
    try {
      const r = await saving;
      savedTemplates = next;
      info.defaults.saved_at = r.saved_at;
      if (sameTemplates(currentTemplates(), next)) renderSaveState(savedLabel(), "ok");
    } catch (e) {
      renderSaveState(`無法儲存：${e.message || "請稍後再試"}`, "error");
    } finally {
      saving = null;
    }
  }
  function setupParameters() {
    $("yt-title").value = info.defaults.title_template;
    $("yt-description").value = info.defaults.description_template;
    savedTemplates = currentTemplates();
    renderSaveState(savedLabel());
    editing = $("yt-title");
    $("yt-parameters").replaceChildren();
    for (const key of info.parameters) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "yt-param";
      b.innerHTML = `${esc(parameterNames[key] || key)}<code>{${esc(key)}}</code>`;
      b.onmousedown = (e) => e.preventDefault(); // 保留輸入框游標
      b.onclick = () => {
        editing.setRangeText(`{${key}}`, editing.selectionStart, editing.selectionEnd, "end");
        editing.focus();
        schedulePreview();
        scheduleSave();
      };
      $("yt-parameters").appendChild(b);
    }
  }
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(
      () => void preview().catch((e) => ($("yt-preview-result").textContent = e.message)),
      350,
    );
    render();
  }
  async function preview() {
    const first = selected.values().next().value;
    if (!first) return void ($("yt-preview-result").textContent = "先選擇旅程");
    const data = await request("/api/youtube/preview", {
      trip_id: first.trip_id,
      camera: first.chosen[0],
      title_template: $("yt-title").value,
      description_template: $("yt-description").value,
    });
    $("yt-preview-result").innerHTML =
      `<strong>${esc(data.title)}</strong><span>${esc(data.description)}</span>`;
    return data;
  }
  function startTime() {
    return $("yt-start").value ? new Date($("yt-start").value).getTime() : Date.now();
  }
  /** 24 小時刻度條：標出第一天內每部影片的開始時間（平均分散的視覺化）。 */
  function renderSchedule(count) {
    const p = plan(count, startTime());
    const origin = p.times[0] ?? Date.now();
    const firstDay = p.times.filter((t) => t < origin + 86_400_000);
    const ticks = firstDay
      .map((t) => `<i style="left:${(((t - origin) / 86_400_000) * 100).toFixed(2)}%"></i>`)
      .join("");
    const marks = [0, 6, 12, 18, 24]
      .map((h) => `<span style="left:${(h / 24) * 100}%">${h ? `+${h}h` : "開始"}</span>`)
      .join("");
    const rest = count - firstDay.length;
    $("yt-schedule").innerHTML = `<div class="yt-schedule-head"><b>上傳排程</b><span>${esc(
      p.interval
        ? `平均分散：每天 ${p.limit} 部，約每 ${span(p.interval)} 一部`
        : `額度內盡快上傳：每天最多 ${p.limit} 部`,
    )}</span></div>
      <div class="yt-ruler" aria-hidden="true">${ticks}</div><div class="yt-ruler-marks" aria-hidden="true">${marks}</div>
      <p class="yt-hint">第一部 ${esc(dayTime(origin))}${count > 1 ? `，最後一部約 ${esc(dayTime(p.last))}` : ""}${rest > 0 ? `（其餘 ${rest} 部排在之後幾天）` : ""}。實際時間會依其他排隊中的影片、重試與 YouTube 狀態調整。${isAdmin() ? "上傳節奏可在維運頁 YouTube 管理調整。" : ""}</p>`;
  }
  function renderSummary() {
    const privacy = document.querySelector('input[name="yt-privacy"]:checked')?.value;
    const count = videoCount();
    const rows = [
      ["影片", `${count} 部（${selected.size} 趟）`],
      [
        "誰可以看",
        { private: "私人", unlisted: "不公開（有連結者可看）", public: "公開" }[privacy],
      ],
      ["畫質", "原始檔上傳，不重新壓縮"],
      ["上傳到", info.account?.channel_title || "—"],
    ];
    $("yt-summary").innerHTML = rows
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
      .join("");
    renderSchedule(count);
    $("yt-confirm-list").innerHTML = `<h3>這次要上傳的影片</h3>${selectionRows()}`;
    $("yt-confirm-hint").textContent = info.account?.paused
      ? "目前佇列已暫停。送出只會加入佇列，需到維運頁恢復後才會開始上傳。"
      : "送出後會加入佇列，在背景依排程上傳；關掉瀏覽器也會繼續。";
  }

  async function go(next) {
    if (step === 1) await saveTemplates();
    if (next === 0) await loadTrips();
    if (next === 1) await preview().catch((e) => ($("yt-preview-result").textContent = e.message));
    if (next === 2) {
      await refreshSelection();
      await preview(); // 範本展開錯誤（過長等）在送出前就擋下
      await loadAccount(); // 取得最新額度，排程估算才準
      $("yt-confirm-upload").checked = false;
      renderSummary();
    }
    step = next;
    render();
  }
  async function submit() {
    const start = startTime();
    if (!Number.isFinite(start)) throw new Error("開始時間格式不正確");
    const count = videoCount();
    const result = await request("/api/youtube/uploads", {
      trip_ids: [...selected.keys()],
      videos: [...selected.values()].flatMap((t) =>
        t.chosen.map((camera) => ({
          trip_id: t.trip_id,
          camera,
          revision: t.cameras[camera].revision,
        })),
      ),
      camera: cameraMode,
      privacy: document.querySelector('input[name="yt-privacy"]:checked')?.value,
      made_for_kids: $("yt-kids").value === "true",
      not_before: start,
      title_template: $("yt-title").value,
      description_template: $("yt-description").value,
      pair: cameraMode === "both",
    });
    $("yt-done-text").textContent =
      `已加入 ${result.added} 部影片${result.skipped ? `；${result.skipped} 部之前已加入過，自動略過` : ""}。${info.account?.paused ? "佇列目前暫停，需到維運頁恢復。" : ""}`;
    $("yt-done-pace").textContent = planText(count) || "系統會在背景依序上傳。";
    $("yt-done-ops").hidden = !isAdmin();
    selected.clear();
    $("yt-confirm-upload").checked = false;
    step = "done";
    render();
    void loadQueueChip();
  }

  /* ── 事件 ─────────────────────────────────────────────── */
  $("yt-prev").onclick = () => {
    if (step > 0) void go(step - 1).catch((e) => notice(e.message, "error"));
  };
  $("yt-next").onclick = (e) =>
    guarded(e.currentTarget, () => (step === STEPS - 1 ? submit() : go(step + 1)));
  $("yt-again").onclick = () => void go(0).catch((e) => notice(e.message, "error"));
  $("yt-policy").onchange = renderAccount;
  $("yt-connect").onclick = (e) =>
    guarded(e.currentTarget, async () => {
      const data = await request("/api/youtube/connect", { accept_policy: true });
      location.href = data.url;
    });
  $("yt-confirm-upload").onchange = render;
  $("yt-reset-template").onclick = () => {
    $("yt-title").value = info.defaults.builtin.title_template;
    $("yt-description").value = info.defaults.builtin.description_template;
    schedulePreview();
    void saveTemplates();
  };
  // 離開頁面前把還沒送出的變更存起來。
  addEventListener("pagehide", () => {
    if (!info || sameTemplates(currentTemplates(), savedTemplates)) return;
    if (!currentTemplates().title_template.trim()) return;
    void fetch("/api/youtube/templates", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentTemplates()),
      keepalive: true,
    });
  });
  for (const id of ["yt-title", "yt-description"]) {
    $(id).onfocus = () => (editing = $(id));
    $(id).oninput = () => {
      schedulePreview();
      scheduleSave();
    };
  }
  document.querySelectorAll("[data-camera-mode]").forEach((button) => {
    button.onclick = () => {
      cameraMode = button.dataset.cameraMode;
      document
        .querySelectorAll("[data-camera-mode]")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      const before = videoCount();
      for (const t of [...selected.values()]) {
        const chosen = t.chosen.filter((c) => cameraMode === "both" || c === cameraMode);
        if (chosen.length) selected.set(t.trip_id, { ...t, chosen });
        else selected.delete(t.trip_id);
      }
      tripPage = 1;
      notice(
        before > videoCount() ? `已移除 ${before - videoCount()} 部不符合鏡頭選擇的影片。` : "",
      );
      void loadTrips().catch((e) => notice(e.message, "error"));
    };
  });
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.onclick = () =>
      guarded(button, async () => {
        filter = button.dataset.filter;
        tripPage = 1;
        await loadTrips();
      });
  });
  $("yt-select-page").onclick = () => {
    trips.forEach((t) => {
      const chosen = eligible(t);
      if (chosen.length) selected.set(t.trip_id, { ...t, chosen });
    });
    renderTrips();
    renderBasket();
    render();
  };
  $("yt-basket-toggle").onclick = () => {
    const open = !$("yt-basket").classList.contains("is-open");
    $("yt-basket").classList.toggle("is-open", open);
    $("yt-basket-toggle").setAttribute("aria-expanded", String(open));
    $("yt-basket-toggle").textContent = open ? "收合清單" : "查看清單";
  };
  $("yt-clear-selection").onclick = () => {
    selected.clear();
    renderTrips();
    renderBasket();
    render();
  };

  (async () => {
    user = await checkAuth();
    if (!user) return;
    renderHeader(user);
    await configReady;
    const oauth = new URLSearchParams(location.search).get("oauth");
    await loadAccount();
    setupParameters();
    void loadQueueChip();
    if (oauth) {
      reauthorize = !!info.account && oauth !== "connected";
      const el = $("yt-oauth-notice");
      const text =
        {
          connected: info.account?.paused
            ? "授權已更新，上傳佇列仍保持暫停；請到維運頁確認後繼續。"
            : "YouTube 頻道已連結，可以開始選擇要上傳的旅程。",
          cancelled: "你取消了 Google 授權，頻道尚未連結。",
        }[oauth] ||
        "Google 授權沒有完成。常見原因：Google Cloud 的「測試使用者」沒有加入你的 Gmail、回呼網址不一致，或此帳號還沒建立 YouTube 頻道。請到維運頁檢查設定。";
      if (connected()) notice(text, oauth === "connected" ? "ok" : "error");
      else {
        el.hidden = false;
        el.dataset.type = oauth === "connected" ? "ok" : "error";
        el.textContent = text;
      }
      history.replaceState(null, "", "/youtube");
    }
    renderAccount();
    if (connected()) await go(0);
    else render();
  })().catch((e) => notice(e.message || "載入失敗，請重新整理", "error"));
})();
