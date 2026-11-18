/* 維運 › 雲端備份：設定 API 金鑰、挑選要備份的旅程、追蹤上傳進度與已備份的雲端檔案。
 * 上傳在伺服器背景進行，關掉瀏覽器也會繼續。 */
window.OpsCloud = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = escapeHtml;
  const names = { queued: "等待中", uploading: "上傳中", done: "已備份", failed: "需處理", cancelled: "已取消" };
  const camNames = { front: "前鏡頭", rear: "後鏡頭" };
  const stateNames = {
    none: "未備份", stale: "影片已變更", queued: "等待中", uploading: "上傳中",
    done: "已備份", failed: "失敗", missing: "找不到檔案",
  };
  const phaseNames = { hashing: "計算校驗碼", uploading: "上傳中", finishing: "雲端確認中" };
  const PENDING = new Set(["none", "stale", "failed"]);
  let user = null, status = null, section = "progress", filter = "pending";
  let tripPage = 1, jobPage = 1, donePage = 1, activeJob = null, timer = 0, lastJobsLoad = 0;
  /** trip_id → 該趟各鏡頭狀態（跨頁保留，算選取的總大小）。 */
  const selected = new Map();
  const request = (url, body, method = "POST") =>
    apiFetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const notice = (msg, type = "") => {
    const el = $("cbk-notice");
    el.textContent = msg || "";
    el.dataset.type = type;
  };
  async function act(button, run) {
    if (button.disabled) return;
    button.disabled = true;
    try {
      notice("");
      await run();
    } catch (e) {
      notice(e.message || "操作失敗，請重試", "error");
    } finally {
      button.disabled = false;
    }
  }
  function pager(id, current, total, limit, go) {
    const pages = Math.max(1, Math.ceil(total / limit)), el = $(id);
    el.replaceChildren();
    if (pages === 1) return;
    const mk = (label, target, disabled) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn btn--ghost btn--sm"; b.textContent = label; b.disabled = disabled;
      b.onclick = () => act(b, () => go(target));
      return b;
    };
    const s = document.createElement("span");
    s.textContent = `${current} / ${pages}`;
    el.append(mk("上一頁", current - 1, current <= 1), s, mk("下一頁", current + 1, current >= pages));
  }

  /* ── 文字格式 ─────────────────────────────────────────────── */
  /** 車機時間以 UTC 存，照原樣顯示。 */
  const wall = (epoch) => new Date(epoch * 1000).toISOString().slice(11, 16);
  const when = (ms) => (ms ? new Date(ms).toLocaleString("zh-TW", { hour12: false }) : "");
  const clock = (ms) => new Date(ms).toLocaleTimeString("zh-TW", { hour12: false, hour: "2-digit", minute: "2-digit" });
  const minutes = (sec) => {
    const m = Math.round(sec / 60);
    return m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分` : `${m} 分`;
  };
  const speed = (bps) => (bps > 0 ? `${((bps * 8) / 1e6).toFixed(1)} Mbps` : "");
  function eta(bytes, bps) {
    if (!(bps > 0) || !(bytes > 0)) return "";
    const s = bytes / bps;
    if (s < 90) return "不到 2 分鐘";
    if (s < 5400) return `約 ${Math.round(s / 60)} 分鐘`;
    if (s < 172800) return `約 ${Math.round(s / 3600)} 小時`;
    return `約 ${Math.round(s / 86400)} 天`;
  }
  function label(j) {
    if (j.kind === "database") return "資料庫快照";
    const part = j.volumes > 1 ? `（第 ${j.volume}/${j.volumes} 份）` : "";
    return `${j.date} ${wall(j.start_epoch)}–${wall(j.end_epoch)} ${camNames[j.camera] || ""}${part}`;
  }

  /* ── 狀態與提示 ─────────────────────────────────────────────── */
  async function loadStatus() {
    status = await apiFetch("/api/cloud-backup/status");
    renderBanner();
    const st = status.stats, tab = $("tab-cloud-state");
    tab.textContent = !status.configured ? "" : status.paused ? "暫停" : st.uploading || st.queued ? String(st.uploading + st.queued) : st.failed ? "!" : "";
    return status;
  }
  function renderBanner() {
    const box = $("cbk-banner"), s = status;
    let html = "";
    if (!s.configured)
      html = `<div class="yt-callout warn"><b>尚未設定 API 金鑰</b><p>${user.is_owner
        ? '到 <a class="link" href="#" data-goto="settings">設定</a> 貼上儲存服務的 API 金鑰，就可以開始備份。'
        : "請由站台擁有者到「設定」貼上儲存服務的 API 金鑰。"}</p></div>`;
    else if (s.paused && s.pause_reason === "credits")
      html = `<div class="yt-callout bad"><b>上傳點數不足，備份已暫停</b>
        <p>儲存服務每上傳一個檔案會用掉 1 次上傳點數，目前已經用完。請儲值（或請提供儲存空間的人加點數）後按「繼續備份」；等待中的項目都會保留，已上傳的分段也不會重傳。</p>
        <div class="yt-actions">
          ${s.topup_url ? `<a class="btn btn--solid btn--sm" href="${esc(s.topup_url)}" target="_blank" rel="noopener">開啟儲值頁面</a>` : ""}
          <button class="btn btn--ghost btn--sm" type="button" data-banner="check">檢查點數</button>
          <button class="btn btn--ghost btn--sm" type="button" data-banner="resume">繼續備份</button>
        </div></div>`;
    else if (s.paused && s.pause_reason === "auth")
      html = `<div class="yt-callout bad"><b>API 金鑰無效或已撤銷，備份已暫停</b>
        <p>${user.is_owner ? '請到 <a class="link" href="#" data-goto="settings">設定</a> 貼上新的金鑰，儲存後會自動繼續。' : "請站台擁有者更新 API 金鑰。"}</p></div>`;
    else if (s.paused)
      html = `<div class="yt-callout warn"><b>備份已暫停</b><p>等待中的項目會保留；按「繼續備份」從上次完成的分段接著傳。</p>
        <div class="yt-actions"><button class="btn btn--solid btn--sm" type="button" data-banner="resume">繼續備份</button></div></div>`;
    else if (s.waiting)
      html = `<div class="yt-callout warn"><b>上傳暫時失敗，${esc(clock(s.waiting.until))} 自動重試</b>
        <p>${esc(s.waiting.message.replace(/[，；]稍後自動重試$/, ""))}${s.waiting.failures > 1 ? `（從 ${esc(clock(s.waiting.since))} 起已連續 ${s.waiting.failures} 次）` : ""}。等待期間整個佇列都會保留，已上傳的分段不會重傳；問題排除後可以按「立即重試」。</p>
        <div class="yt-actions">
          <button class="btn btn--solid btn--sm" type="button" data-banner="retry">立即重試</button>
          <button class="btn btn--ghost btn--sm" type="button" data-banner="check">檢查連線與點數</button>
        </div></div>`;
    box.innerHTML = html;
    box.querySelectorAll("[data-goto]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); void show(a.dataset.goto); }));
    box.querySelectorAll("[data-banner]").forEach((b) => (b.onclick = () => act(b, async () => {
      if (b.dataset.banner === "check") await runCheck();
      else if (b.dataset.banner === "retry") {
        await request("/api/cloud-backup/retry-now", {});
        notice("已安排立即重試，幾秒內開始。", "ok");
      } else {
        await request("/api/cloud-backup/pause", { paused: false });
        notice("已繼續備份。", "ok");
      }
      await refresh();
    })));
  }
  async function runCheck() {
    const r = await request("/api/cloud-backup/check", {});
    notice(r.message, r.ok ? "ok" : "error");
  }

  function show(name) {
    section = name;
    document.querySelectorAll("[data-cbk]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.cbk === name)));
    for (const n of ["progress", "pick", "done", "settings"]) $(`cbk-${n}`).hidden = n !== name;
    return refresh();
  }
  async function refresh() {
    await loadStatus();
    if (section === "progress") await loadProgress();
    if (section === "pick") await loadTrips();
    if (section === "done") await loadDone();
    if (section === "settings") renderSettings();
  }

  /* ── 備份進度 ─────────────────────────────────────────────── */
  async function loadProgress() {
    const s = status, st = s.stats, cur = s.current;
    const remaining = eta(st.remaining_bytes, cur?.phase === "uploading" ? cur.rate : 0);
    $("cbk-stat").innerHTML = [
      `已備份 <b>${st.done_files}</b> 支影片（${fmtBytes(st.done_file_bytes)}）`,
      `等待中 <b>${st.queued}</b> 份`,
      st.failed ? `需處理 <b>${st.failed}</b> 份` : "",
      st.remaining_bytes ? `尚餘 <b>${fmtBytes(st.remaining_bytes)}</b>${remaining ? `，${remaining}` : ""}` : "",
      s.last_db_at ? `資料庫快照 ${when(s.last_db_at)}` : "",
    ].filter(Boolean).map((x) => `<span>${x}</span>`).join("");
    if (cur) {
      const pct = cur.total ? Math.min(100, Math.floor((cur.done / cur.total) * 100)) : 0;
      $("cbk-current").innerHTML = `<div class="cbk-now">
        <div class="cbk-now-head"><b>${esc(label(cur))}</b><span class="yt-badge s-uploading">${phaseNames[cur.phase] || "上傳中"}</span></div>
        <progress max="100" value="${pct}"></progress>
        <div class="cbk-now-meta"><span>${fmtBytes(cur.done)} / ${fmtBytes(cur.total)}（${pct}%）</span>
          ${cur.phase === "uploading" && cur.rate ? `<span>${speed(cur.rate)}</span><span>這一份${eta(cur.total - cur.done, cur.rate)}</span>` : ""}
          ${cur.part_count ? `<span>分段 ${cur.parts_done} / ${cur.part_count}</span>` : ""}</div></div>`;
    } else
      $("cbk-current").innerHTML = st.queued && !s.paused && !s.waiting && s.configured
        ? '<p class="yt-hint cbk-idle">下一份即將開始（重試等待中的項目會在排定時間後繼續）。</p>'
        : "";
    $("cbk-pause").textContent = s.paused ? "繼續備份" : "暫停備份";
    $("cbk-pause").hidden = !s.configured;
    $("cbk-db-now").hidden = !s.configured;
    $("cbk-cancel-queued").hidden = !st.queued;
    await loadJobs();
  }
  async function loadJobs() {
    const limit = 10, r = await apiFetch(`/api/cloud-backup/jobs?view=active&page=${jobPage}&limit=${limit}`);
    lastJobsLoad = Date.now();
    if (activeJob && !r.jobs.some((j) => j.id === activeJob) && jobPage === 1 && !r.total) activeJob = null;
    $("cbk-jobs").innerHTML = r.jobs.length
      ? r.jobs.map((j) => {
          const live = status.current?.id === j.id && status.current.phase === "uploading" ? status.current.done : j.uploaded_bytes;
          const pct = j.size ? Math.floor((live / j.size) * 100) : 0;
          const wait = j.status === "queued" && j.not_before > Date.now() + 60_000 ? `${when(j.not_before)} 再試` : "";
          return `<div class="ytm-row${j.id === activeJob ? " is-active" : ""}" role="button" tabindex="0" data-job="${j.id}">
            <span class="yt-badge s-${esc(j.status)}">${names[j.status] || esc(j.status)}</span>
            <span class="ytm-row-main"><b>${esc(label(j))}</b>
              <small>${[j.size ? fmtBytes(j.size) : "", pct ? `${pct}%` : "", j.message, wait].filter(Boolean).map(esc).join(" · ")}</small>
              ${pct ? `<progress max="100" value="${pct}"></progress>` : ""}</span>
            <span class="ytm-row-actions"><span class="btn btn--ghost btn--sm">詳情</span></span>
          </div>`;
        }).join("")
      : `<p class="yt-empty">${status.configured ? '目前沒有等待中的備份。到 <a class="link" href="#" data-goto="pick">選擇旅程</a> 挑選要備份的旅程。' : "設定 API 金鑰後就可以開始備份。"}</p>`;
    $("cbk-jobs").querySelectorAll("[data-goto]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); void show(a.dataset.goto); }));
    $("cbk-jobs").querySelectorAll("[data-job]").forEach((el) => {
      const open = () => { activeJob = Number(el.dataset.job); void loadJobs(); };
      el.onclick = open;
      el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    });
    pager("cbk-jobs-pager", jobPage, r.total, limit, async (p) => { jobPage = p; await loadJobs(); });
    await loadDetail();
  }
  async function loadDetail() {
    const el = $("cbk-detail");
    if (!activeJob) return void (el.innerHTML = '<p class="yt-empty">點選左邊任一項，查看每個步驟的紀錄與可用的動作。</p>');
    let d;
    try {
      d = await apiFetch(`/api/cloud-backup/jobs/${activeJob}`);
    } catch {
      activeJob = null;
      return void (el.innerHTML = "");
    }
    const j = d.job, pct = j.size ? Math.floor((j.uploaded_bytes / j.size) * 100) : 0;
    el.innerHTML = `<h3>${esc(label(j))}</h3><p class="yt-hint">${esc(j.message)}</p>
      ${j.size ? `<progress max="100" value="${j.status === "done" ? 100 : pct}"></progress>` : ""}
      <dl class="cbk-meta">
        ${j.size ? `<dt>大小</dt><dd>${fmtBytes(j.size)}${j.volumes > 1 ? `（整個影片 ${fmtBytes(j.file_size)}，分 ${j.volumes} 份）` : ""}</dd>` : ""}
        <dt>雲端檔名</dt><dd><code>${esc(j.remote_name)}</code></dd>
        ${j.remote_id ? `<dt>雲端檔案編號</dt><dd><code>${esc(j.remote_id)}</code></dd>` : ""}
        ${j.sha256 ? `<dt>SHA-256</dt><dd><code>${esc(j.sha256)}</code>${j.verified ? "（雲端核對相符）" : ""}</dd>` : ""}
        <dt>上傳嘗試</dt><dd>${j.attempts} 次</dd>
      </dl>
      <div class="yt-actions">
        ${j.status === "failed" ? '<button class="btn btn--solid btn--sm" type="button" data-a="retry">重試</button>' : ""}
        ${["queued", "uploading", "failed"].includes(j.status) ? '<button class="btn btn--danger btn--sm" type="button" data-a="cancel">取消備份</button>' : ""}
      </div>
      ${j.volumes > 1 ? '<p class="yt-hint">重試與取消會套用到同一支影片的所有分卷；已完成的分卷保留。</p>' : ""}
      <ul class="ytm-events">${d.events.map((ev) => `<li><time>${when(ev.created_at)}</time>${esc(ev.message)}</li>`).join("")}</ul>`;
    el.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => act(b, async () => {
      if (b.dataset.a === "cancel") {
        if (!confirm("取消這支影片的備份？已開始的分段上傳會通知儲存服務取消並退還點數。本機影片不受影響。")) return;
        await request(`/api/cloud-backup/jobs/${j.id}/cancel`, {});
        notice("已取消。", "ok");
      } else {
        await request(`/api/cloud-backup/jobs/${j.id}/retry`, {});
        notice("已重新排入備份。", "ok");
      }
      await refresh();
    })));
  }

  /* ── 選擇旅程 ─────────────────────────────────────────────── */
  const camerasChoice = () => $("cbk-cameras").value;
  const wanted = (c) => camerasChoice() === "both" || c.camera === camerasChoice();
  function pendingOf(cams) {
    return cams.filter((c) => wanted(c) && PENDING.has(c.state));
  }
  function renderSelection() {
    let files = 0, bytes = 0;
    for (const cams of selected.values())
      for (const c of pendingOf(cams)) { files++; bytes += c.size; }
    $("cbk-sel-text").textContent = selected.size
      ? `已選 ${selected.size} 趟，${files} 個檔案待備份（${fmtBytes(bytes)}）`
      : "尚未選取旅程";
    $("cbk-enqueue").disabled = !files;
    $("cbk-clear-sel").hidden = !selected.size;
  }
  async function loadTrips() {
    const limit = 30, r = await apiFetch(`/api/cloud-backup/trips?filter=${filter}&page=${tripPage}&limit=${limit}`);
    document.querySelectorAll("[data-cbk-filter]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.cbkFilter === filter)));
    const sm = r.summary;
    $("cbk-pick-summary").innerHTML = `<div><b>尚未備份 ${sm.trips} 趟、${sm.files} 個檔案，共 ${fmtBytes(sm.bytes)}</b>
        <p class="yt-hint">全部完成約需 ${sm.uploads} 次上傳點數（超過 10 GB 的影片會分成多份，每份 1 次）。已備份 ${sm.done_files} / ${sm.total_files} 個檔案（${fmtBytes(sm.done_bytes)}）。</p></div>
      <button class="btn btn--ghost btn--sm" type="button" id="cbk-all" ${sm.files && status.configured ? "" : "disabled"}>全部未備份加入佇列</button>`;
    $("cbk-all").onclick = (e) => act(e.currentTarget, async () => {
      const cams = camerasChoice() === "both" ? "前後鏡頭" : camNames[camerasChoice()];
      if (!confirm(`把所有尚未備份的旅程（${cams}）加入備份佇列？\n\n共 ${sm.files} 個檔案、${fmtBytes(sm.bytes)}，約需 ${sm.uploads} 次上傳點數。\n上傳會在背景依序進行，可以隨時暫停或取消。`)) return;
      const res = await request("/api/cloud-backup/enqueue", { all_pending: true, cameras: camerasChoice() });
      selected.clear();
      notice(`已加入 ${res.added} 個檔案（${fmtBytes(res.bytes)}）。`, "ok");
      await refresh();
    });
    let day = "";
    const html = [];
    for (const t of r.trips) {
      if (t.date !== day) {
        if (day) html.push("</div>");
        day = t.date;
        html.push(`<div class="cbk-day"><h4>${esc(day)}</h4>`);
      }
      const todo = pendingOf(t.cameras);
      html.push(`<label class="cbk-trip${todo.length ? "" : " is-done"}">
        <input type="checkbox" data-trip="${esc(t.trip_id)}" ${selected.has(t.trip_id) ? "checked" : ""} ${todo.length && status.configured ? "" : "disabled"} aria-label="選取 ${esc(t.date)} 第 ${t.trip_no} 趟">
        <span class="cbk-trip-main"><b>第 ${t.trip_no} 趟 ${wall(t.start_epoch)}–${wall(t.end_epoch)}</b>
          <small>${minutes(t.duration_sec)}${t.owner ? ` · ${esc(t.owner)}` : ""}</small></span>
        <span class="cbk-chips">${t.cameras.map((c) => `<span class="cbk-chip s-${esc(c.state)}" title="${c.done_at ? `備份於 ${when(c.done_at)}` : ""}">${camNames[c.camera]}${c.size ? ` ${fmtBytes(c.size)}` : ""} · ${stateNames[c.state] || esc(c.state)}</span>`).join("")}</span>
      </label>`);
    }
    if (day) html.push("</div>");
    $("cbk-trips").innerHTML = html.length
      ? html.join("")
      : `<p class="yt-empty">${filter === "pending" ? "所有旅程都已備份。" : filter === "done" ? "還沒有已備份的旅程。" : "沒有可備份的旅程。"}</p>`;
    const cache = new Map(r.trips.map((t) => [t.trip_id, t.cameras]));
    $("cbk-trips").querySelectorAll("[data-trip]").forEach((input) => (input.onchange = () => {
      if (input.checked) selected.set(input.dataset.trip, cache.get(input.dataset.trip));
      else selected.delete(input.dataset.trip);
      renderSelection();
    }));
    $("cbk-select-page").onclick = () => {
      $("cbk-trips").querySelectorAll("[data-trip]:not(:disabled)").forEach((input) => {
        input.checked = true;
        selected.set(input.dataset.trip, cache.get(input.dataset.trip));
      });
      renderSelection();
    };
    pager("cbk-trips-pager", tripPage, r.total, limit, async (p) => { tripPage = p; await loadTrips(); });
    renderSelection();
  }
  async function enqueueSelected(e) {
    await act(e.currentTarget, async () => {
      const res = await request("/api/cloud-backup/enqueue", { trip_ids: [...selected.keys()], cameras: camerasChoice() });
      selected.clear();
      notice(`已加入 ${res.added} 個檔案（${fmtBytes(res.bytes)}）${res.skipped ? `，略過 ${res.skipped} 個已在佇列或已備份的檔案` : ""}。到「備份進度」查看。`, "ok");
      await refresh();
    });
  }

  /* ── 已備份 ─────────────────────────────────────────────── */
  async function loadDone() {
    const limit = 20, r = await apiFetch(`/api/cloud-backup/jobs?view=done&page=${donePage}&limit=${limit}`);
    $("cbk-done-count").textContent = r.total ? `共 ${r.total} 個檔案` : "";
    $("cbk-site").href = status.storage_site;
    $("cbk-done-list").innerHTML = r.jobs.length
      ? r.jobs.map((j) => `<div class="ytm-row">
          <span class="yt-badge s-done">${j.verified ? "已核對" : "已備份"}</span>
          <span class="ytm-row-main"><b>${esc(label(j))}</b>
            <small>${[fmtBytes(j.size), when(j.completed_at), j.remote_state && j.remote_state !== "success" ? `雲端狀態：${j.remote_state}` : ""].filter(Boolean).map(esc).join(" · ")}</small>
            <small class="cbk-mono">${esc(j.remote_name)}${j.remote_id ? ` · 編號 ${esc(j.remote_id)}` : ""}</small></span>
          <span class="ytm-row-actions"><button class="btn btn--ghost btn--sm" type="button" data-copy="${esc(j.remote_name)}">複製檔名</button></span>
        </div>`).join("")
      : '<p class="yt-empty">還沒有備份完成的檔案。</p>';
    $("cbk-done-list").querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => DashcamUI.copyText(b.dataset.copy, b)));
    pager("cbk-done-pager", donePage, r.total, limit, async (p) => { donePage = p; await loadDone(); });
  }

  /* ── 設定 ─────────────────────────────────────────────── */
  function renderSettings() {
    const s = status, owner = !!user.is_owner;
    $("cbk-key-state").textContent = s.configured
      ? `已設定（結尾 ${s.key_hint}）。要更換時貼上新的金鑰並儲存。`
      : owner ? "尚未設定。貼上儲存服務提供的 API 金鑰（cpk_ 開頭）。" : "尚未設定。只有站台擁有者可以設定金鑰。";
    for (const id of ["cbk-key", "cbk-key-save", "cbk-key-remove"]) $(id).disabled = !owner;
    $("cbk-key-remove").hidden = !s.configured;
    $("cbk-check").disabled = !s.configured;
    $("cbk-auto").checked = s.auto_new;
    $("cbk-db").checked = s.db_snapshot;
    $("cbk-rate").value = String(s.rate_mbps);
    $("cbk-endpoint").value = s.endpoint;
    $("cbk-endpoint").placeholder = s.default_endpoint;
    $("cbk-advanced").hidden = !owner;
  }

  function init(me) {
    user = me;
    void loadStatus().catch(() => {});
    document.querySelectorAll("[data-cbk]").forEach((b) => (b.onclick = () => void show(b.dataset.cbk).catch((e) => notice(e.message, "error"))));
    document.querySelectorAll("[data-cbk-filter]").forEach((b) => (b.onclick = () => act(b, async () => {
      filter = b.dataset.cbkFilter; tripPage = 1;
      await loadTrips();
    })));
    // 鏡頭選項會改變哪些旅程還有東西可備份，重新整理清單（已選的保留）。
    $("cbk-cameras").onchange = () => void loadTrips().catch((e) => notice(e.message, "error"));
    $("cbk-enqueue").onclick = enqueueSelected;
    $("cbk-clear-sel").onclick = () => {
      selected.clear();
      $("cbk-trips").querySelectorAll("[data-trip]").forEach((x) => (x.checked = false));
      renderSelection();
    };
    $("cbk-pause").onclick = (e) => act(e.currentTarget, async () => {
      await request("/api/cloud-backup/pause", { paused: !status.paused });
      notice(status.paused ? "已繼續備份。" : "已暫停；進行中的那一份會保留已完成的分段。", "ok");
      await refresh();
    });
    $("cbk-db-now").onclick = (e) => act(e.currentTarget, async () => {
      const r = await request("/api/cloud-backup/database", {});
      notice(r.queued ? "已排入資料庫快照，會優先上傳。" : "已經有一份資料庫快照在等待上傳。", "ok");
      await refresh();
    });
    $("cbk-cancel-queued").onclick = (e) => act(e.currentTarget, async () => {
      if (!confirm(`取消所有等待中的 ${status.stats.queued} 份備份？正在上傳的那一份不受影響，之後仍可重新選取。`)) return;
      const r = await request("/api/cloud-backup/cancel-queued", {});
      notice(`已取消 ${r.cancelled} 份。`, "ok");
      await refresh();
    });
    $("cbk-key-save").onclick = (e) => act(e.currentTarget, async () => {
      const key = $("cbk-key").value.trim();
      if (!key) throw new Error("請先貼上 API 金鑰");
      await request("/api/cloud-backup/key", { api_key: key }, "PUT");
      $("cbk-key").value = "";
      notice("金鑰已加密儲存。可以按「檢查金鑰與點數」確認。", "ok");
      await refresh();
    });
    $("cbk-key-remove").onclick = (e) => act(e.currentTarget, async () => {
      if (!confirm("移除 API 金鑰？備份會停止，等待中的項目與已備份紀錄都會保留。")) return;
      await apiFetch("/api/cloud-backup/key", { method: "DELETE" });
      notice("已移除金鑰。", "ok");
      await refresh();
    });
    $("cbk-check").onclick = (e) => act(e.currentTarget, async () => {
      await runCheck();
      await loadStatus();
    });
    $("cbk-save").onclick = (e) => act(e.currentTarget, async () => {
      const rate = Number($("cbk-rate").value || 0);
      if (!Number.isInteger(rate) || rate < 0) throw new Error("速度上限請填 0 或正整數");
      await request("/api/cloud-backup/settings", { auto_new: $("cbk-auto").checked, db_snapshot: $("cbk-db").checked, rate_mbps: rate }, "PUT");
      notice("已儲存設定。", "ok");
      await refresh();
    });
    $("cbk-endpoint-save").onclick = (e) => act(e.currentTarget, async () => {
      await request("/api/cloud-backup/endpoint", { endpoint: $("cbk-endpoint").value.trim() }, "PUT");
      notice("已儲存服務網址。", "ok");
      await refresh();
    });
  }
  /** 切到此分頁時呼叫；還沒設定金鑰的擁有者直接看到設定。 */
  async function activate() {
    await loadStatus();
    await show(!status.configured && user.is_owner ? "settings" : section);
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.hidden || !$("pane-cloud").classList.contains("is-active") || section !== "progress") return;
      const busy = status?.current || status?.stats.queued;
      if (!busy && Date.now() - lastJobsLoad < 15_000) return;
      void loadStatus().then(() => loadProgress()).catch(() => {});
    }, 3000);
  }
  return { init, activate };
})();
