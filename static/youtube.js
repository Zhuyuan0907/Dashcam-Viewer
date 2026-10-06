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
  };
  // 這些狀態代表該鏡頭已在 YouTube 或正在上傳，不需要再傳一次。
  const DONE = new Set(["queued", "uploading", "processing", "succeeded"]);
  let blocked = new Set();
  const selected = new Map();
  let step = 0,
    info = null,
    user = null,
    trips = [],
    tripPage = 1,
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
  const radio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
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
    const cam = radio("yt-camera");
    let n = 0;
    for (const t of selected.values())
      n += (cam !== "rear" && t.has_front ? 1 : 0) + (cam !== "front" && t.has_rear ? 1 : 0);
    return n;
  }
  function canAdvance() {
    if (step === 0) return !!info?.account;
    if (step === 1) return selected.size > 0;
    if (step === 2) return !!$("yt-title").value.trim();
    if (step === 4) return $("yt-confirm-upload").checked;
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
    $("yt-next").textContent = step === STEPS - 1 ? "開始上傳" : "下一步 →";
    $("yt-next").disabled = !canAdvance();
    const status = $("yt-foot-status");
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
    $("yt-connect-box").hidden = !configured || !!account;
    $("yt-connected").hidden = !account;
    if (account) $("yt-channel-name").textContent = account.channel_title;
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
      chip.textContent = `上傳中 ${active} 部${c.failed ? ` · 失敗 ${c.failed} 部` : ""} · 查看進度`;
      if (!isAdmin()) chip.removeAttribute("href");
    } catch {
      chip.hidden = true;
    }
  }

  async function loadTrips() {
    const limit = pageSize();
    const date = $("yt-date").value;
    const result = await apiFetch(
      `/api/trips?limit=${limit}&offset=${(tripPage - 1) * limit}${date ? `&date=${date}` : ""}`,
    );
    trips = result.trips;
    blocked = new Set();
    const status = trips.length
      ? (
          await apiFetch(
            `/api/youtube/trip-status?ids=${encodeURIComponent(trips.map((t) => t.trip_id).join("\n"))}`,
          )
        ).trips
      : {};
    $("yt-trips").innerHTML = trips.length
      ? trips
          .map((t) => {
            const st = status[t.trip_id] || {};
            const badges = Object.entries(st)
              .map(
                ([cam, s]) =>
                  `<span class="yt-badge s-${esc(s)}">${cam === "front" ? "前" : "後"}・${statusNames[s] || esc(s)}</span>`,
              )
              .join("");
            const needed = [t.has_front && "front", t.has_rear && "rear"].filter(Boolean);
            const done = needed.length > 0 && needed.every((cam) => DONE.has(st[cam]));
            if (done) {
              blocked.add(t.trip_id);
              selected.delete(t.trip_id);
            }
            const cams = [t.has_front && "前鏡頭", t.has_rear && "後鏡頭"]
              .filter(Boolean)
              .join("＋");
            return `<label class="yt-trip${selected.has(t.trip_id) ? " is-on" : ""}${done ? " is-done" : ""}" ${done ? 'title="這趟的鏡頭都已上傳或正在上傳，不需要重複上傳"' : ""}>
            <input type="checkbox" data-trip="${esc(t.trip_id)}" ${selected.has(t.trip_id) ? "checked" : ""} ${done ? "disabled" : ""} aria-label="${done ? "已上傳，無法選取" : "選取這趟"}">
            <span class="yt-trip-main"><b>${esc(t.date)}　${fmtTime(t.start_epoch)}–${fmtTime(t.end_epoch)}　第 ${t.day_order} 趟</b>
            <small>${cams} · ${fmtDuration(t.duration_sec)} · ${esc(t.device?.nickname || t.device?.model || "行車記錄器")}</small></span>
            <span class="yt-trip-side">${badges}</span></label>`;
          })
          .join("")
      : `<p class="yt-empty">${date ? "這一天沒有你的旅程，換個日期或按「顯示全部日期」。" : '還沒有旅程。先到 <a class="link" href="/upload">上傳</a> 匯入行車記錄器影片。'}</p>`;
    $("yt-trips")
      .querySelectorAll("[data-trip]")
      .forEach((input) => {
        input.onchange = () => {
          const t = trips.find((x) => x.trip_id === input.dataset.trip);
          if (input.checked) selected.set(t.trip_id, t);
          else selected.delete(t.trip_id);
          input.closest(".yt-trip").classList.toggle("is-on", input.checked);
          render();
        };
      });
    pager(result.total, limit);
    render();
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
      camera: radio("yt-camera") === "rear" || !first.has_front ? "rear" : "front",
      title_template: $("yt-title").value,
      description_template: $("yt-description").value,
    });
    $("yt-preview-result").innerHTML =
      `<strong>${esc(data.title)}</strong><span>${esc(data.description)}</span>`;
    return data;
  }
  function renderSummary() {
    const cam = radio("yt-camera"),
      privacy = radio("yt-privacy");
    const count = videoCount(),
      limit = info.account?.daily_limit || 10;
    const start = $("yt-start").value
      ? new Date($("yt-start").value).toLocaleString("zh-TW")
      : "立即開始";
    const rows = [
      ["旅程", `${selected.size} 趟`],
      ["影片數", `${count} 部${cam === "both" ? "（前後鏡頭各一部，每趟一個播放清單）" : ""}`],
      ["鏡頭", { both: "前後鏡頭都上傳", front: "只上傳前鏡頭", rear: "只上傳後鏡頭" }[cam]],
      [
        "誰可以看",
        { private: "私人", unlisted: "不公開（有連結者可看）", public: "公開" }[privacy],
      ],
      ["開始時間", start],
      ["預估", `每 24 小時最多 ${limit} 部，約需 ${Math.max(1, Math.ceil(count / limit))} 天傳完`],
      ["上傳到", info.account?.channel_title || "—"],
    ];
    $("yt-summary").innerHTML = rows
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
      .join("");
  }

  async function go(next) {
    if (next === 1) await loadTrips();
    if (next === 2) await preview().catch((e) => ($("yt-preview-result").textContent = e.message));
    if (next === 4) {
      await preview(); // 範本展開錯誤（過長等）在送出前就擋下
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
      camera,
      privacy: radio("yt-privacy"),
      made_for_kids: $("yt-kids").value === "true",
      not_before: start,
      title_template: $("yt-title").value,
      description_template: $("yt-description").value,
      pair: camera === "both",
    });
    $("yt-done-text").textContent =
      `已加入 ${result.added} 部影片${result.skipped ? `；${result.skipped} 部之前已加入過，自動略過` : ""}。`;
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
  for (const id of ["yt-title", "yt-description"]) {
    $(id).onfocus = () => (editing = $(id));
    $(id).oninput = schedulePreview;
  }
  document.querySelectorAll('input[name="yt-camera"]').forEach((r) => (r.onchange = render));
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
      if (!blocked.has(t.trip_id)) selected.set(t.trip_id, t);
    });
    void loadTrips();
  };
  $("yt-clear-selection").onclick = () => {
    selected.clear();
    void loadTrips();
  };

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
      const el = $("yt-oauth-notice");
      el.hidden = false;
      el.dataset.type = oauth === "connected" ? "ok" : "error";
      el.textContent =
        {
          connected: "✓ YouTube 頻道已連結，可以按「下一步」選擇旅程。",
          cancelled: "你取消了 Google 授權，頻道尚未連結。",
        }[oauth] ||
        "Google 授權沒有完成。常見原因：Google Cloud 的「測試使用者」沒有加入你的 Gmail、回呼網址不一致，或此帳號還沒建立 YouTube 頻道。請到維運頁檢查設定。";
      history.replaceState(null, "", "/youtube");
    }
    // 已連結就直接從「選擇旅程」開始，省一步。
    if (info.account && oauth !== "connected") await go(1);
    else render();
  })().catch((e) => notice(e.message || "載入失敗，請重新整理", "error"));
})();
