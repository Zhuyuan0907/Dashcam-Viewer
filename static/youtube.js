/* YouTube 上傳精靈：連結頻道 → 選旅程 → 標題說明 → 上傳方式 → 確認。
 * 佇列、已上傳、清理本機與 OAuth 設定等管理功能在 /ops#youtube（ops-youtube.js）。 */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = escapeHtml;
  const STEPS = 5;
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
    changed: "影片已更新，尚未上傳",
    unavailable: "本機影片無法使用",
    local_processing: "本機處理中",
    needs_verification: "已送達，待確認",
  };
  const cameraName = (camera) => (camera === "front" ? "前鏡頭" : "後鏡頭");
  let filter = "ready";
  let reauthorize = new URLSearchParams(location.search).get("reauthorize") === "1";
  const selected = new Map();
  let step = 0,
    info = null,
    user = null,
    trips = [],
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
  const radio = (name) =>
    name === "yt-camera"
      ? $("yt-camera-filter").value
      : document.querySelector(`input[name="${name}"]:checked`)?.value;
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
    if (innerWidth <= 760) return innerHeight < 700 ? 2 : 3;
    return innerHeight < 700 ? 4 : innerHeight < 900 ? 6 : 8;
  }
  function videoCount() {
    return [...selected.values()].reduce((n, t) => n + t.chosen.length, 0);
  }
  function canAdvance() {
    if (step === 0) return !!info?.account && !reauthorize;
    if (step === 1) return !loadingTrips && videoCount() > 0;
    if (step === 2) return !!$("yt-title").value.trim();
    if (step === 4) return videoCount() > 0 && $("yt-confirm-upload").checked;
    return true;
  }

  /* ── 畫面 ─────────────────────────────────────────────── */
  function render() {
    const done = step === "done";
    document.querySelectorAll("#yt-steps li").forEach((li) => {
      const i = Number(li.dataset.step);
      li.classList.toggle("is-current", i === step);
      li.classList.toggle("is-done", done || i < step || (i === 0 && !!info?.account));
      if (i === step) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
    for (let i = 0; i < STEPS; i++) $(`yt-step-${i}`).hidden = i !== step;
    $("yt-step-done").hidden = !done;
    $("yt-foot").hidden = done;
    if (done) return;
    $("yt-prev").style.visibility = step === 0 ? "hidden" : "visible";
    $("yt-next").textContent = step === STEPS - 1 ? "加入上傳佇列" : "下一步 →";
    $("yt-next").disabled = !canAdvance();
    const status = $("yt-foot-status");
    status.disabled = step !== 1 || !selected.size;
    status.title = status.disabled ? "" : "查看已選影片清單";
    if (step === 0) status.textContent = info?.account ? "" : "連結頻道後才能繼續";
    else if (step === 4) status.textContent = canAdvance() ? "" : "請勾選確認後送出";
    else
      status.textContent = selected.size
        ? `已選 ${selected.size} 趟 · ${videoCount()} 部影片`
        : "尚未選擇旅程";
  }
  function renderAccount() {
    const configured = !!info?.configured,
      account = info?.account;
    $("yt-need-setup").hidden = configured || !!account;
    $("yt-connect-box").hidden = !configured || (!!account && !reauthorize);
    $("yt-connected").hidden = !account;
    if (account) $("yt-channel-name").textContent = account.channel_title;
    $("yt-connect").textContent = account ? "重新授權 Google 帳號" : "使用 Google 帳號連結";
    if (!configured) {
      $("yt-need-setup-text").textContent = user?.is_owner
        ? "這是第一次使用 YouTube 功能時需要的一次性設定（約 10 分鐘），跟著維運頁的步驟做完就能回來連結頻道。"
        : "需要站台擁有者先在維運頁完成 Google 授權設定，請聯絡管理員。完成後回到這頁即可連結。";
      $("yt-go-setup").hidden = !user?.is_owner;
    }
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
      if (!active && !c.failed) return void (chip.hidden = true);
      chip.hidden = false;
      chip.className = "yt-chip" + (c.failed ? " is-bad" : "");
      chip.textContent = `${info?.account?.paused ? "佇列已暫停" : "佇列中"} ${active} 部${c.failed ? ` · 失敗 ${c.failed} 部` : ""} · 查看進度`;
      if (!isAdmin()) chip.removeAttribute("href");
    } catch {
      chip.hidden = true;
    }
  }

  const tripLabel = (t) =>
    `${t.date}　${fmtTime(t.start_epoch)}–${fmtTime(t.end_epoch)}　第 ${t.day_order} 趟`;
  const eligible = (t) =>
    Object.keys(t.cameras).filter(
      (camera) =>
        t.cameras[camera].selectable &&
        (radio("yt-camera") === "both" || radio("yt-camera") === camera),
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
      <div><b>${esc(t.date)} · 第 ${t.day_order} 趟</b><small>${fmtTime(t.start_epoch)}–${fmtTime(t.end_epoch)}</small>
      <span>${t.chosen.map(cameraName).join("＋")} · ${t.chosen.length} 部影片</span></div>
      ${removable ? `<button type="button" class="btn btn--ghost btn--sm" data-remove="${esc(t.trip_id)}" aria-label="移除 ${esc(tripLabel(t))}">移除</button>` : ""}</div>`,
      )
      .join("");
  }
  function renderBasket() {
    $("yt-basket-count").textContent = `${selected.size} 趟 · ${videoCount()} 部影片`;
    $("yt-selected-list").innerHTML =
      selectionRows(true) ||
      '<p class="yt-hint">尚未選取。勾選旅程或個別鏡頭，就會出現在這裡。</p>';
    $("yt-clear-selection").disabled = !selected.size;
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
    $("yt-mode-selection").textContent =
      `這次選了 ${selected.size} 趟、${videoCount()} 部影片；鏡頭明細可在確認頁檢查。要調整請回到第 2 步。`;
  }
  function renderTrips() {
    $("yt-trips").innerHTML = trips.length
      ? trips
          .map((t) => {
            const available = ["ready", "all"].includes(filter) ? eligible(t) : [];
            const chosen = selected.get(t.trip_id)?.chosen || [];
            const cameras = Object.entries(t.cameras)
              .map(([camera, state]) => {
                const selectable = available.includes(camera);
                return `<div class="yt-camera-row">
          <label>${selectable ? `<input type="checkbox" data-camera="${camera}" data-camera-trip="${esc(t.trip_id)}" ${chosen.includes(camera) ? "checked" : ""} aria-label="${esc(tripLabel(t))} ${cameraName(camera)}">` : '<span class="yt-camera-mark" aria-hidden="true">' + (state.status === "succeeded" ? "✓" : "·") + "</span>"}
          <span>${cameraName(camera)}</span><span class="yt-badge s-${esc(state.status)}">${statusNames[state.status] || esc(state.status)}</span></label>
          ${state.video_url ? `<a class="link" href="${esc(state.video_url)}" target="_blank" rel="noopener" title="${esc(state.title || cameraName(camera))}">在 YouTube 查看 ↗</a>` : ""}</div>`;
              })
              .join("");
            const instruction = available.length
              ? available.length === 1 && Object.keys(t.cameras).length > 1
                ? `這次可上傳：${cameraName(available[0])}，另一鏡頭不會重複上傳。`
                : `可選 ${available.length} 部影片`
              : filter === "uploaded"
                ? "已上傳的鏡頭可直接查看；要補傳另一鏡頭請切換「待上傳」。"
                : t.group === "uploaded"
                  ? "這趟已完成上傳，可直接開啟 YouTube 影片。"
                  : t.group === "queued"
                    ? "已加入佇列，不需要再選；可在上傳進度查看。"
                    : "目前沒有可選的鏡頭。";
            return `<article class="yt-trip${chosen.length ? " is-on" : ""}${!available.length ? " is-done" : ""}">
        <div class="yt-trip-header">
          <label class="yt-trip-select"><input type="checkbox" data-trip="${esc(t.trip_id)}" ${chosen.length && chosen.length === available.length ? "checked" : ""} ${!available.length ? "disabled" : ""} aria-label="選取 ${esc(tripLabel(t))}"><span class="yt-trip-main"><b>${esc(t.date)} · 第 ${t.day_order} 趟</b><span>${fmtTime(t.start_epoch)}–${fmtTime(t.end_epoch)}</span><small>${fmtDuration(t.duration_sec)} · ${esc(t.device?.nickname || t.device?.model || "行車記錄器")}</small></span></label>
          <a class="yt-trip-preview" href="/trip/${encodeURIComponent(t.trip_id)}" target="_blank" rel="noopener" aria-label="預覽 ${esc(tripLabel(t))}"><img loading="lazy" alt="" src="/video/${encodeURIComponent(t.trip_id)}/thumbnail"><span>預覽旅程 ↗</span></a>
        </div><div class="yt-trip-cameras">${cameras}</div><small class="yt-trip-note">${instruction}</small></article>`;
          })
          .join("")
      : `<p class="yt-empty">${
          {
            ready: "沒有待上傳的影片。可以切換「佇列中」或「已上傳」查看紀錄。",
            queued: "目前沒有符合條件的佇列旅程。",
            uploaded: "目前沒有符合條件的已上傳旅程。",
            all: dateEmpty(),
          }[filter]
        }${$("yt-date").value ? " 也可以按「顯示全部日期」。" : ""}</p>`;
    $("yt-select-page").disabled =
      !["ready", "all"].includes(filter) || !trips.some((t) => eligible(t).length);
    $("yt-trips")
      .querySelectorAll(".yt-trip-preview img")
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
  function dateEmpty() {
    return '沒有符合條件的旅程。可先到 <a class="link" href="/upload">匯入影片</a>。';
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
      camera: radio("yt-camera"),
    });
    if ($("yt-date").value) query.set("date", $("yt-date").value);
    try {
      const result = await apiFetch(`/api/youtube/trips?${query}`);
      if (seq !== tripLoad) return;
      trips = result.trips;
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
      document.querySelectorAll("[data-filter]").forEach((button) => {
        button.setAttribute("aria-pressed", button.dataset.filter === filter ? "true" : "false");
        button.querySelector("span").textContent = `${result.counts[button.dataset.filter]} 趟`;
      });
      $("yt-filter-hint").textContent = {
        ready: "依本站紀錄；已上傳／排隊的鏡頭不可選。",
        queued: info?.account?.paused
          ? "佇列目前已暫停。這些鏡頭已加入過，恢復上傳請至上傳進度。"
          : "這些鏡頭已加入上傳佇列，不需要重複選取。",
        uploaded:
          "包含已完成上傳的鏡頭，也會顯示同趟另一鏡頭的狀態。可直接開啟 YouTube 查看；補傳請切換待上傳。",
        all: "前後鏡頭各自顯示狀態；只可勾選尚未上傳或需要重試的鏡頭。",
      }[filter];
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
      step = 1;
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
    const span = document.createElement("span");
    span.textContent = `第 ${tripPage} / ${pages} 頁`;
    el.append(
      mk("‹ 上一頁", tripPage - 1, tripPage <= 1),
      span,
      mk("下一頁 ›", tripPage + 1, tripPage >= pages),
    );
  }

  function setupParameters() {
    $("yt-title").value = info.defaults.title_template;
    $("yt-description").value = info.defaults.description_template;
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
    if (!first) return void ($("yt-preview-result").textContent = "先在第 2 步選擇旅程");
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
  function renderSummary() {
    const privacy = radio("yt-privacy");
    const count = videoCount(),
      limit = info.account?.daily_limit || 10;
    const start = $("yt-start").value
      ? new Date($("yt-start").value).toLocaleString("zh-TW")
      : "立即開始";
    const rows = [
      ["旅程", `${selected.size} 趟`],
      ["影片數", `${count} 部（只包含下方清單的鏡頭）`],
      [
        "誰可以看",
        { private: "私人", unlisted: "不公開（有連結者可看）", public: "公開" }[privacy],
      ],
      ["開始時間", start],
      [
        "嘗試上限",
        `每 24 小時最多建立 ${limit} 次上傳，失敗也計入；實際完成時間依授權與 YouTube 處理狀況而定`,
      ],
      ["上傳到", info.account?.channel_title || "—"],
    ];
    $("yt-summary").innerHTML = rows
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
      .join("");
    $("yt-confirm-list").innerHTML = `<h3>這次要上傳的影片</h3>${selectionRows()}`;
    $("yt-confirm-hint").textContent = info.account?.paused
      ? "目前佇列已暫停。送出只會加入佇列，需到上傳進度恢復後才會開始上傳。"
      : "送出後會加入佇列，依序在背景上傳。";
  }

  async function go(next) {
    if (next === 1) await loadTrips();
    if (next === 2) await preview().catch((e) => ($("yt-preview-result").textContent = e.message));
    if (next === 4) {
      await refreshSelection();
      await preview(); // 範本展開錯誤（過長等）在送出前就擋下
      $("yt-confirm-upload").checked = false;
      renderSummary();
    }
    step = next;
    render();
    $("yt-step-" + step)
      ?.querySelector("h2")
      ?.focus?.();
  }
  async function submit() {
    const start = $("yt-start").value ? new Date($("yt-start").value).getTime() : Date.now();
    if (!Number.isFinite(start)) throw new Error("開始時間格式不正確");
    const camera = radio("yt-camera");
    const result = await request("/api/youtube/uploads", {
      trip_ids: [...selected.keys()],
      videos: [...selected.values()].flatMap((t) =>
        t.chosen.map((camera) => ({
          trip_id: t.trip_id,
          camera,
          revision: t.cameras[camera].revision,
        })),
      ),
      camera,
      privacy: radio("yt-privacy"),
      made_for_kids: $("yt-kids").value === "true",
      not_before: start,
      title_template: $("yt-title").value,
      description_template: $("yt-description").value,
      pair: camera === "both",
    });
    $("yt-done-text").textContent =
      `已加入 ${result.added} 部影片${result.skipped ? `；${result.skipped} 部之前已加入過，自動略過` : ""}。${info.account?.paused ? "佇列仍保持暫停。" : ""}`;
    $("yt-done-limit").textContent = String(info.account?.daily_limit || 10);
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
  $("yt-again").onclick = () => void go(1).catch((e) => notice(e.message, "error"));
  $("yt-policy").onchange = renderAccount;
  $("yt-connect").onclick = (e) =>
    guarded(e.currentTarget, async () => {
      const data = await request("/api/youtube/connect", { accept_policy: true });
      location.href = data.url;
    });
  $("yt-confirm-upload").onchange = render;
  $("yt-foot-status").onclick = () => {
    $("yt-basket").open = true;
    $("yt-basket").scrollIntoView({ block: "nearest" });
    $("yt-basket").querySelector("summary").focus();
  };
  for (const id of ["yt-title", "yt-description"]) {
    $(id).onfocus = () => (editing = $(id));
    $(id).oninput = schedulePreview;
  }
  $("yt-camera-filter").onchange = () => {
    const before = videoCount();
    for (const t of [...selected.values()]) {
      const chosen = t.chosen.filter(
        (c) => radio("yt-camera") === "both" || c === radio("yt-camera"),
      );
      if (chosen.length) selected.set(t.trip_id, { ...t, chosen });
      else selected.delete(t.trip_id);
    }
    tripPage = 1;
    notice(
      before > videoCount()
        ? `已切換鏡頭篩選；已移除 ${before - videoCount()} 部不符合鏡頭選擇的影片，請確認已選清單。`
        : "",
    );
    void loadTrips().catch((e) => notice(e.message, "error"));
  };
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.onclick = () =>
      guarded(button, async () => {
        filter = button.dataset.filter;
        tripPage = 1;
        await loadTrips();
      });
  });
  $("yt-date").onchange = () => {
    tripPage = 1;
    void loadTrips().catch((e) => notice(e.message, "error"));
  };
  $("yt-clear-date").onclick = () => {
    $("yt-date").value = "";
    tripPage = 1;
    void loadTrips().catch((e) => notice(e.message, "error"));
  };
  $("yt-select-page").onclick = () => {
    trips.forEach((t) => {
      const chosen = eligible(t);
      if (chosen.length) selected.set(t.trip_id, { ...t, chosen });
    });
    renderTrips();
    renderBasket();
    render();
  };
  $("yt-clear-selection").onclick = () => {
    selected.clear();
    renderTrips();
    renderBasket();
    render();
  };
  const basketLayout = matchMedia("(min-width: 1000px)");
  const updateBasket = () => {
    $("yt-basket").open = basketLayout.matches;
  };
  basketLayout.addEventListener("change", updateBasket);
  updateBasket();

  (async () => {
    user = await checkAuth();
    if (!user) return;
    renderHeader(user);
    await configReady;
    await loadAccount();
    setupParameters();
    void loadQueueChip();
    const oauth = new URLSearchParams(location.search).get("oauth");
    if (oauth) {
      reauthorize = !!info.account && oauth !== "connected";
      renderAccount();
    }
    if (oauth) {
      const el = $("yt-oauth-notice");
      el.hidden = false;
      el.dataset.type = oauth === "connected" ? "ok" : "error";
      el.textContent =
        {
          connected: info.account?.paused
            ? "✓ 授權已更新，上傳佇列仍保持暫停；請到維運頁確認後繼續。"
            : "✓ YouTube 頻道已連結，可以按「下一步」選擇旅程。",
          cancelled: "你取消了 Google 授權，頻道尚未連結。",
        }[oauth] ||
        "Google 授權沒有完成。常見原因：Google Cloud 的「測試使用者」沒有加入你的 Gmail、回呼網址不一致，或此帳號還沒建立 YouTube 頻道。請到維運頁檢查設定。";
      history.replaceState(null, "", "/youtube");
    }
    // 已連結就直接從「選擇旅程」開始，省一步。
    if (info.account && !reauthorize && !oauth) await go(1);
    else render();
  })().catch((e) => notice(e.message || "載入失敗，請重新整理", "error"));
})();
