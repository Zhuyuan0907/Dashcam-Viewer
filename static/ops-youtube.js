/* 維運 › YouTube：授權設定（擁有者）、頻道、上傳佇列、已上傳與清理本機空間。
 * 上傳流程本身在 /youtube 精靈。 */
window.OpsYoutube = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = escapeHtml;
  const names = {
    queued: "等待上傳", uploading: "上傳中", processing: "已傳輸，待確認",
    succeeded: "已確認完成", failed: "需處理", cancelled: "已取消",
  };
  const pairNames = { pending: "播放清單待建立", done: "已配對播放清單", failed: "配對失敗" };
  let user = null, account = null, section = "queue", queueView = "active", queuePage = 1, archivePage = 1, logPage = 1;
  let activeJob = null, timer = 0;
  const cleanup = new Set();
  const request = (url, body, method = "POST") =>
    apiFetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const notice = (msg, type = "") => {
    const el = $("ytm-notice");
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
    el.append(mk("‹ 上一頁", current - 1, current <= 1), s, mk("下一頁 ›", current + 1, current >= pages));
  }

  function show(name) {
    section = name;
    document.querySelectorAll("[data-ytm]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.ytm === name)));
    for (const n of ["setup", "account", "queue", "archive"]) $(`ytm-${n}`).hidden = n !== name;
    return refresh();
  }
  async function refresh() {
    await loadAccount();
    if (section === "queue") await loadUploads();
    if (section === "archive") await loadArchive(true);
    if (section !== "queue" && section !== "archive") $("ytm-missing").hidden = true;
  }

  /* ── YouTube 上已刪除的影片：重新上傳或忽略 ───────────────────────── */
  function renderMissing(count) {
    const box = $("ytm-missing");
    box.hidden = !count;
    if (!count) return;
    box.innerHTML = `<b>${count} 部影片在 YouTube 上找不到</b>
      <p>通常是在 YouTube 手動刪除的。可以重新上傳，或確認是自己刪除的，就不再提醒（之後仍可在上傳頁重新選取這些旅程）。</p>
      <div class="yt-actions">
        <button class="btn btn--solid btn--sm" type="button" data-missing="reupload">全部重新上傳</button>
        <button class="btn btn--ghost btn--sm" type="button" data-missing="dismiss">全部忽略，不再提醒</button>
      </div>`;
    box.querySelectorAll("[data-missing]").forEach((b) => (b.onclick = () => act(b, async () => {
      const reupload = b.dataset.missing === "reupload";
      if (!confirm(reupload
        ? `把 ${count} 部影片重新加入上傳佇列？會依每日上限與上傳節奏排程。`
        : `確認這 ${count} 部影片是你在 YouTube 刪除的？本站會停止提醒，本機影片不受影響。`)) return;
      const r = await request("/api/youtube/missing", { action: b.dataset.missing });
      const bad = r.results.filter((x) => !x.ok);
      notice(bad.length ? `有 ${bad.length} 部無法處理：${bad.map((x) => x.detail).join("；")}` : reupload ? "已重新加入上傳佇列。" : "已忽略，不再提醒。", bad.length ? "error" : "ok");
      await refresh();
    })));
  }
  async function missingAction(id, action) {
    if (action === "dismiss" && !confirm("確認這部影片是你在 YouTube 刪除的？本站會停止提醒，本機影片不受影響。")) return false;
    await request(`/api/youtube/uploads/${id}/missing`, { action });
    notice(action === "reupload" ? "已重新加入上傳佇列。" : "已忽略，不再提醒。", "ok");
    return true;
  }

  /* ── 授權設定 ─────────────────────────────────────────────── */
  async function loadConfig() {
    const config = await apiFetch("/api/youtube/config");
    const redirect = config.redirect_uri || `${location.origin}/api/youtube/callback`;
    $("ytm-client-id").value = config.client_id;
    $("ytm-redirect").value = redirect;
    $("ytm-redirect-copy").textContent = redirect;
    $("ytm-origin-copy").textContent = location.origin;
    $("ytm-project-limit").value = String(config.project_daily_limit);
    $("ytm-client-secret").placeholder = config.has_secret ? "已設定；留空表示不變" : "貼上 Client Secret";
    $("ytm-setup-state").innerHTML = config.configured
      ? '<div class="yt-callout ok"><b>Google 授權已設定</b><p>可以到 <a class="link" href="/youtube">上傳到 YouTube</a> 連結頻道。</p></div>'
      : '<div class="yt-callout warn"><b>尚未設定</b><p>照著下面 5 個步驟做一次即可（約 10 分鐘），只需要一個 Google 帳號，不用付費。</p></div>';
  }
  async function saveConfig(e) {
    await act(e.currentTarget, async () => {
      await request("/api/youtube/config", {
        client_id: $("ytm-client-id").value.trim(),
        client_secret: $("ytm-client-secret").value.trim(),
        redirect_uri: $("ytm-redirect").value.trim(),
        project_daily_limit: Number($("ytm-project-limit").value),
      }, "PUT");
      $("ytm-client-secret").value = "";
      await loadConfig();
      notice("已加密儲存。下一步：到「上傳到 YouTube」連結你的頻道。", "ok");
    });
  }

  /* ── 頻道 ─────────────────────────────────────────────── */
  async function loadAccount() {
    const r = await apiFetch("/api/youtube/account");
    account = r.account;
    const box = $("ytm-account-body");
    if (!r.configured) {
      box.innerHTML = `<div class="yt-callout warn"><b>尚未設定 Google 授權</b><p>${user.is_owner ? '請先完成 <a class="link" href="#" data-goto="setup">授權設定</a>。' : "請由站台擁有者完成授權設定。"}</p></div>`;
    } else if (!account) {
      box.innerHTML = '<div class="yt-callout"><b>尚未連結頻道</b><p>到 <a class="link" href="/youtube">上傳到 YouTube</a> 第 1 步連結。</p></div>';
    } else {
      box.innerHTML = `
        <div class="yt-callout ${account.paused ? "warn" : "ok"}"><b>${esc(account.channel_title)}</b>
          <p>${account.paused ? "上傳佇列已暫停（授權失效時也會自動暫停）。" : "上傳佇列運作中，關掉瀏覽器也會繼續。"}
          過去 24 小時已使用 ${account.used} / ${account.daily_limit} 次建立上傳的嘗試（失敗也計入）。${!account.paused && account.until > Date.now() ? ` 下一部最早 ${new Date(account.until).toLocaleString("zh-TW")} 開始。` : ""}</p></div>
        <div class="ytm-form">
          <label class="field">每天最多上傳幾部（每 24 小時）<input id="ytm-limit" type="number" min="1" max="1000" class="form-input" value="${account.daily_limit}"></label>
          <fieldset class="field ytm-pace"><legend>上傳節奏</legend>
            <label><input type="radio" name="ytm-spread" value="1" ${account.spread ? "checked" : ""}> 平均分散在一天中<small id="ytm-pace-hint"></small></label>
            <label><input type="radio" name="ytm-spread" value="0" ${account.spread ? "" : "checked"}> 額度內盡快上傳<small>額度恢復時會連續上傳，直到用完當天上限。</small></label>
          </fieldset>
        </div>
        <div class="yt-actions" style="margin-top:14px">
          <button class="btn btn--solid btn--sm" type="button" id="ytm-save-limit">儲存設定</button>
          <button class="btn btn--ghost btn--sm" type="button" id="ytm-pause">${account.paused ? "繼續上傳佇列" : "暫停上傳佇列"}</button>
          <a class="btn btn--ghost btn--sm" href="/youtube?reauthorize=1" id="ytm-reconnect">重新授權／換頻道</a>
          <button class="btn btn--danger btn--sm" type="button" id="ytm-disconnect">解除連結</button>
        </div>
        <p class="yt-hint">「重新授權」會開啟上傳頁的頻道授權畫面；若授權失效（例如 Google 專案仍在測試模式，7 天後失效）也請重新授權。</p>`;
      const paceHint = () => {
        const n = Math.max(1, Number($("ytm-limit").value) || 1), minutes = Math.round(1440 / n);
        $("ytm-pace-hint").textContent = `每 ${minutes >= 60 ? `${Math.floor(minutes / 60)} 小時${minutes % 60 ? ` ${minutes % 60} 分` : ""}` : `${minutes} 分鐘`} 上傳一部，例如每天 ${n} 部就平均分布在 24 小時內。`;
      };
      paceHint();
      $("ytm-limit").oninput = paceHint;
      $("ytm-save-limit").onclick = (e) => act(e.currentTarget, async () => {
        await request("/api/youtube/account", {
          daily_limit: Number($("ytm-limit").value),
          spread: document.querySelector('input[name="ytm-spread"]:checked')?.value === "1",
        }, "PATCH");
        notice("已儲存上傳上限與節奏。", "ok");
        await loadAccount();
      });
      $("ytm-pause").onclick = (e) => act(e.currentTarget, async () => {
        await request("/api/youtube/account", { paused: !account.paused }, "PATCH");
        await loadAccount();
      });
      $("ytm-disconnect").onclick = (e) => act(e.currentTarget, async () => {
        if (!confirm("解除連結會停止上傳，並刪除本站的授權、雲端連結與上傳紀錄。本機和 YouTube 上的影片都會保留。確定？")) return;
        const result = await apiFetch("/api/youtube/account", { method: "DELETE" });
        notice(result.revoked ? "已解除連結。" : "本站資料已刪除；Google 端撤銷失敗，請到 Google 帳號的第三方存取設定手動移除。", "ok");
        await loadAccount();
      });
    }
    box.querySelectorAll("[data-goto]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); void show(a.dataset.goto); }));
  }

  /* ── 佇列 ─────────────────────────────────────────────── */
  /** 排隊中影片的時間說明：暫停時不顯示估計時間（不準）。 */
  function queueTiming(u) {
    if (u.status !== "queued") return "";
    if (account?.paused) return "佇列暫停中";
    if (!u.eta || u.eta <= Date.now() + 60_000) return "下一部";
    return `預計 ${new Date(u.eta).toLocaleString("zh-TW", { hour12: false })} 開始`;
  }
  async function loadUploads() {
    const limit = 8, r = await apiFetch(`/api/youtube/uploads?filter=${queueView}&page=${queuePage}&limit=${limit}`);
    const c = Object.fromEntries(r.counts.map((x) => [x.status, x.n]));
    $("ytm-queue-stat").innerHTML = queueView === "cancelled"
      ? `<span>已取消 <b>${c.cancelled || 0}</b></span><button type="button" class="btn btn--ghost btn--sm ytm-view" data-view="active">返回上傳進度</button>`
      : ["queued", "uploading", "processing", "succeeded", "failed"]
          .map((s) => `<span>${names[s]} <b>${c[s] || 0}</b></span>`).join("") +
        (c.cancelled ? `<button type="button" class="btn btn--ghost btn--sm ytm-view" data-view="cancelled">已取消 ${c.cancelled} 部</button>` : "");
    if (r.transferred !== undefined && queueView !== "cancelled")
      $("ytm-queue-stat").insertAdjacentHTML("afterbegin", `<span>已傳輸 <b>${r.transferred}</b></span>`);
    $("ytm-queue-stat").querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => act(b, async () => {
      queueView = b.dataset.view; queuePage = 1; activeJob = null;
      await loadUploads();
    })));
    renderMissing(r.missing || 0);
    $("ytm-uploads").innerHTML = r.uploads.length
      ? r.uploads.map((u) => `
        <div class="ytm-row${u.id === activeJob ? " is-active" : ""}" role="button" tabindex="0" data-job="${u.id}">
          <span class="yt-badge s-${esc(u.missing && u.status !== "cancelled" ? "missing" : u.status)}">${u.missing && u.status !== "cancelled" ? "YouTube 已刪除" : u.transfer_complete && u.status === "failed" ? "已傳輸，需確認" : names[u.status] || esc(u.status)}</span>
          <span class="ytm-row-main"><b>${esc(u.title)}</b>
            <small>${[u.camera === "front" ? "前鏡頭" : "後鏡頭", `${u.progress}%`, u.message, queueTiming(u)].filter(Boolean).map(esc).join(" · ")}</small>
            <progress max="100" value="${u.progress}"></progress></span>
          <span class="ytm-row-actions"><span class="btn btn--ghost btn--sm">詳情</span></span>
        </div>`).join("")
      : queueView === "cancelled"
        ? '<p class="yt-empty">沒有已取消的工作。</p>'
        : '<p class="yt-empty">目前沒有上傳工作。到 <a class="link" href="/youtube">上傳到 YouTube</a> 選擇旅程。</p>';
    $("ytm-uploads").querySelectorAll("[data-job]").forEach((el) => {
      const open = () => { activeJob = Number(el.dataset.job); logPage = 1; void loadUploads(); };
      el.onclick = open;
      el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    });
    pager("ytm-upload-pager", queuePage, r.total, limit, async (p) => { queuePage = p; await loadUploads(); });
    await loadDetail();
  }
  async function loadDetail() {
    const el = $("ytm-detail");
    if (!activeJob) return void (el.innerHTML = '<p class="yt-empty">點選左邊任一部影片，查看每個步驟的紀錄與可用的修復動作。</p>');
    const d = await apiFetch(`/api/youtube/uploads/${activeJob}?page=${logPage}`), u = d.upload;
    el.innerHTML = `<h3>${esc(u.title)}</h3><p class="yt-hint">${esc(u.message)}</p>
      <progress max="100" value="${u.progress}"></progress>
      <p class="yt-hint">${u.progress}% · ${fmtBytes(u.uploaded_bytes)} / ${fmtBytes(u.source_size)}</p>
      ${u.missing && u.status !== "cancelled" ? `<div class="yt-callout bad"><b>YouTube 上找不到這部影片</b><p>可能是在 YouTube 刪除了。可以重新上傳，或忽略不再提醒。</p>
        <div class="yt-actions"><button class="btn btn--solid btn--sm" data-a="reupload">重新上傳</button><button class="btn btn--ghost btn--sm" data-a="dismiss">忽略，不再提醒</button></div></div>` : ""}
      <div class="yt-actions">
        ${u.missing ? "" : ["queued", "failed", "processing"].includes(u.status) ? `<button class="btn btn--ghost btn--sm" data-a="test">${u.video_url ? "只確認這一部" : "只試傳這一部"}</button>` : ""}
        ${!u.missing && ["failed", "cancelled"].includes(u.status) ? '<button class="btn btn--solid btn--sm" data-a="retry">重試／續傳</button>' : ""}
        ${!u.missing && u.can_restart && u.status === "failed" ? '<button class="btn btn--ghost btn--sm" data-a="restart">從頭重新上傳</button>' : ""}
        ${!u.missing && ["queued", "uploading", "failed"].includes(u.status) ? '<button class="btn btn--danger btn--sm" data-a="cancel">取消</button>' : ""}
        ${u.video_url && !u.missing ? `<a class="btn btn--ghost btn--sm" href="${esc(u.video_url)}" target="_blank" rel="noopener">在 YouTube 觀看</a>` : ""}
      </div>
      <p class="yt-hint">單部操作須先暫停整個佇列；其餘影片不會開始。</p>
      <ul class="ytm-events">${d.events.map((ev) => `<li><time>${new Date(ev.created_at).toLocaleString("zh-TW")}</time>${esc(ev.message)}</li>`).join("")}</ul>
      <div class="yt-pager" id="ytm-log-pager"></div>`;
    el.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => act(b, async () => {
      const a = b.dataset.a;
      if (a === "reupload" || a === "dismiss") {
        if (await missingAction(u.id, a)) await loadUploads();
        return;
      }
      if (a === "test") {
        await request(`/api/youtube/uploads/${u.id}/test`, {});
        notice("這一部已執行；其餘佇列維持暫停。", "ok");
        await loadUploads();
        return;
      }
      if (a === "restart" && !confirm("續傳工作階段可能已過期。請先到 YouTube Studio 確認沒有相同影片，以免重複。確定從頭上傳？")) return;
      if (a === "cancel") await request(`/api/youtube/uploads/${u.id}/cancel`, {});
      else await request(`/api/youtube/uploads/${u.id}/retry`, a === "restart" ? { restart_confirmed: true } : {});
      await loadUploads();
    })));
    pager("ytm-log-pager", logPage, d.total, d.limit, async (p) => { logPage = p; await loadDetail(); });
  }

  /* ── 已上傳 / 清理 ─────────────────────────────────────────────── */
  const privacyNames = { private: "私人", unlisted: "不公開", public: "公開" };
  const SYNC_STALE_MS = 5 * 60 * 1000;
  let lastSync = 0, syncing = false;
  async function syncNow(button) {
    if (syncing || !account) return;
    syncing = true;
    if (button) button.disabled = true;
    $("ytm-sync-time").textContent = "同步中…";
    try {
      const r = await request("/api/youtube/sync", {});
      lastSync = r.synced_at;
      notice(
        `已從 YouTube 同步 ${r.synced} 部${r.missing ? `；${r.missing} 部在 YouTube 上找不到（可能已刪除），請在上方選擇重新上傳或忽略` : ""}。`,
        r.missing ? "error" : "ok",
      );
    } catch (e) {
      notice(e.message || "同步失敗", "error");
    } finally {
      syncing = false;
      if (button) button.disabled = false;
    }
  }
  function ytLine(u) {
    const y = u.youtube;
    if (!y) return '<span class="ytm-yt muted">尚未與 YouTube 同步</span>';
    if (y.missing) return `<span class="ytm-yt bad">${u.status === "cancelled" ? "已在 YouTube 刪除（已忽略）" : "YouTube 上找不到這部影片（可能已刪除）"}</span>`;
    const parts = [
      `<span class="yt-badge">${privacyNames[y.privacy] || esc(y.privacy || "—")}</span>`,
      u.resolution ? `<span>${u.resolution.width}×${u.resolution.height}${u.definition === "sd" ? "（高畫質處理中）" : ""}</span>` : "",
      y.views !== null ? `<span>觀看 ${Number(y.views).toLocaleString("zh-TW")} 次</span>` : "",
      y.likes !== null ? `<span>喜歡 ${Number(y.likes).toLocaleString("zh-TW")}</span>` : "",
      y.comments !== null ? `<span>留言 ${Number(y.comments).toLocaleString("zh-TW")}</span>` : "",
      y.title && y.title !== u.title ? `<span>YouTube 標題：${esc(y.title)}</span>` : "",
    ];
    return `<span class="ytm-yt">${parts.filter(Boolean).join("")}</span>`;
  }
  async function loadArchive(autoSync = false) {
    if (autoSync && account && Date.now() - lastSync > SYNC_STALE_MS) await syncNow($("ytm-sync"));
    if (account) $("ytm-studio-all").href = `https://studio.youtube.com/channel/${encodeURIComponent(account.channel_id)}/videos/upload`;
    const limit = 8, r = await apiFetch(`/api/youtube/uploads?filter=archive&page=${archivePage}&limit=${limit}`);
    renderMissing(r.missing || 0);
    const syncedAt = Math.max(0, ...r.uploads.map((u) => u.youtube?.synced_at || 0));
    if (syncedAt) lastSync = Math.max(lastSync, syncedAt);
    $("ytm-sync-time").textContent = lastSync ? `上次同步 ${new Date(lastSync).toLocaleString("zh-TW")}` : "尚未同步";
    $("ytm-archives").innerHTML = r.uploads.length
      ? r.uploads.map((u) => `
        <div class="ytm-row${u.missing && u.status !== "cancelled" ? " is-missing" : ""}">
          ${u.deleted_at ? '<span class="yt-badge">本機已清理</span>'
            : `<input type="checkbox" data-cleanup="${esc(u.trip_id)}" ${cleanup.has(u.trip_id) ? "checked" : ""} ${u.status !== "succeeded" || u.youtube?.missing ? "disabled title=\"YouTube 處理完成後才能清理\"" : ""} aria-label="勾選此旅程以清理本機">`}
          <span class="ytm-row-main"><b>${esc(u.title)}</b>
            <small>${u.camera === "front" ? "前鏡頭" : "後鏡頭"} · ${names[u.status] || esc(u.status)}${u.pair_status ? ` · ${pairNames[u.pair_status]}` : ""}${u.pair_status === "failed" && u.pair_message ? `（${esc(u.pair_message)}）` : ""}</small>
            ${ytLine(u)}</span>
          <span class="ytm-row-actions">
            ${u.missing && u.status !== "cancelled" ? `<button class="btn btn--solid btn--sm" type="button" data-row-missing="reupload" data-id="${u.id}">重新上傳</button>
            <button class="btn btn--ghost btn--sm" type="button" data-row-missing="dismiss" data-id="${u.id}">忽略</button>` : ""}
            ${u.youtube?.missing || u.missing ? "" : `<a class="btn btn--ghost btn--sm" href="${esc(u.video_url)}" target="_blank" rel="noopener">觀看</a>
            <a class="btn btn--ghost btn--sm" href="${esc(u.studio_url)}" target="_blank" rel="noopener" title="在 YouTube Studio 修改標題、可見性或刪除">在 Studio 編輯</a>`}
            ${u.playlist_url ? `<a class="btn btn--ghost btn--sm" href="${esc(u.playlist_url)}" target="_blank" rel="noopener">前後鏡頭清單</a>` : ""}
            ${u.deleted_at ? "" : `<a class="btn btn--ghost btn--sm" href="/api/youtube/uploads/${u.id}/download">下載原檔</a>`}
          </span>
        </div>`).join("")
      : '<p class="yt-empty">還沒有上傳完成的影片。</p>';
    $("ytm-archives").querySelectorAll("[data-row-missing]").forEach((b) => (b.onclick = () => act(b, async () => {
      if (await missingAction(Number(b.dataset.id), b.dataset.rowMissing)) await refresh();
    })));
    $("ytm-archives").querySelectorAll("[data-cleanup]").forEach((input) => (input.onchange = () => {
      if (input.checked) cleanup.add(input.dataset.cleanup);
      else cleanup.delete(input.dataset.cleanup);
      $("ytm-archives").querySelectorAll("[data-cleanup]").forEach((x) => (x.checked = cleanup.has(x.dataset.cleanup)));
      $("ytm-cleanup").textContent = cleanup.size ? `刪除 ${cleanup.size} 趟的本機檔案` : "刪除勾選旅程的本機檔案";
    }));
    pager("ytm-archive-pager", archivePage, r.total, limit, async (p) => { archivePage = p; await loadArchive(); });
  }
  async function doCleanup(e) {
    await act(e.currentTarget, async () => {
      if (!cleanup.size) throw new Error("請先勾選要清理的旅程（前後鏡頭都要上傳完成）");
      if (!confirm(`即將永久刪除 ${cleanup.size} 趟旅程的本機影片，釋放硬碟空間。\n\n系統會再次向 YouTube 確認每個鏡頭都已上傳並處理完成。\nYouTube 不保證能下載回原始畫質；特別重要的影片請另外備份。\n\n確定刪除？`)) return;
      const r = await request("/api/youtube/cleanup", { trip_ids: [...cleanup], confirm_delete: true });
      const ok = r.results.filter((x) => x.deleted);
      ok.forEach((x) => cleanup.delete(x.trip_id));
      const bad = r.results.filter((x) => !x.deleted);
      notice(`已清理 ${ok.length} 趟。${bad.map((x) => `${x.trip_id}：${x.detail}`).join("；")}`, bad.length ? "error" : "ok");
      await loadArchive();
    });
  }

  function init(me) {
    user = me;
    $("ytm-setup-tab").hidden = !user.is_owner;
    document.querySelectorAll("[data-ytm]").forEach((b) => (b.onclick = () => void show(b.dataset.ytm).catch((e) => notice(e.message, "error"))));
    $("ytm-save-config").onclick = saveConfig;
    $("ytm-cleanup").onclick = doCleanup;
    $("ytm-sync").onclick = (e) => void syncNow(e.currentTarget).then(() => loadArchive());
    document.querySelectorAll(".ytm-copy").forEach((el) => (el.onclick = () => DashcamUI.copyText(el.textContent, el)));
    if (user.is_owner) void loadConfig().catch((e) => notice(e.message, "error"));
  }
  /** 切到此分頁時呼叫；未設定授權的擁有者直接看到設定步驟。 */
  async function activate() {
    const r = await apiFetch("/api/youtube/account");
    await show(!r.configured && user.is_owner ? "setup" : section);
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.hidden || !$("pane-youtube").classList.contains("is-active")) return;
      if (section === "queue") void loadUploads().catch(() => {});
    }, 5000);
  }
  return { init, activate };
})();
