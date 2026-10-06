(() => {
  const $ = (id) => document.getElementById(id);
  const escape = escapeHtml;
  const names = {
    queued: "等待上傳",
    uploading: "上傳中",
    processing: "YouTube 處理中",
    succeeded: "已完成",
    failed: "需處理",
    cancelled: "已取消",
  };
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
  const selected = new Map(),
    cleanupSelection = new Set();
  let trips = [],
    account = null,
    tab = "select",
    settingPage = 0,
    tripPage = 1,
    queuePage = 1,
    archivePage = 1,
    logPage = 1,
    activeJob = null,
    editing = $("yt-title"),
    initialized = false,
    busy = false;
  let timer,
    pollRunning = false;
  const previousStates = new Map();
  const request = (url, body, method = "POST") =>
    apiFetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  function notice(message) {
    $("yt-notice").textContent = message;
  }
  async function action(button, run) {
    if (button.disabled) return;
    button.disabled = true;
    try {
      await run();
    } catch (error) {
      notice(error.message || "操作失敗，請重試");
    } finally {
      button.disabled = false;
    }
  }
  function pager(id, current, total, limit, go) {
    const pages = Math.max(1, Math.ceil(total / limit)),
      el = $(id);
    el.replaceChildren();
    if (pages === 1) return;
    for (const [label, target, disabled] of [
      ["上一頁", current - 1, current <= 1],
      ["下一頁", current + 1, current >= pages],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn--ghost btn--sm";
      button.textContent = label;
      button.disabled = disabled;
      button.onclick = () => {
        void action(button, () => go(target));
      };
      el.appendChild(button);
      if (label === "上一頁") {
        const span = document.createElement("span");
        span.textContent = `${current} / ${pages}`;
        el.appendChild(span);
      }
    }
  }
  function pageSize() {
    if (innerWidth <= 760) return innerHeight < 700 ? 2 : 4;
    if (innerHeight < 500) return 1;
    return innerHeight < 700 ? 4 : 6;
  }
  function updateSelection() {
    $("yt-selection-count").textContent = String(selected.size);
    $("yt-next").disabled = !selected.size;
    const count = [...selected.values()].reduce(
      (sum, t) =>
        sum +
        ($("yt-camera").value !== "rear" && t.has_front ? 1 : 0) +
        ($("yt-camera").value !== "front" && t.has_rear ? 1 : 0),
      0,
    );
    $("yt-review-summary").textContent =
      `已選 ${selected.size} 趟旅程，共 ${count} 部鏡頭影片。頻道上限 ${$("yt-limit").value} 部／24 小時，約需 ${Math.ceil(count / (Number($("yt-limit").value) || 10))} 個上傳日；實際時間依 YouTube 額度、處理速度與排程而定。`;
    $("yt-trip-count").textContent = `已選 ${selected.size} 趟（可跨頁勾選）`;
  }
  async function loadAccount() {
    const result = await apiFetch("/api/youtube/account");
    account = result.account;
    $("yt-account-summary").textContent = account
      ? `${account.channel_title} · ${account.paused ? "已暫停" : "佇列啟用"} · 24 小時內 ${account.used}/${account.daily_limit} 次上傳嘗試`
      : "尚未連結頻道";
    $("yt-channel-name").textContent = account?.channel_title || "尚未連結 YouTube";
    $("yt-connect").textContent = account ? "重新授權我的 YouTube 頻道" : "連結我的 YouTube 頻道";
    $("yt-connect").disabled = !result.configured;
    $("yt-disconnect").hidden = !account;
    $("yt-connection-help").textContent = result.configured
      ? "使用 Google 授權，把你選擇的影片上傳到自己的頻道。"
      : "站台尚未設定 Google OAuth，請由站台擁有者先完成設定，再連結頻道。";
    $("yt-pause").textContent = account?.paused ? "繼續佇列" : "暫停佇列";
    $("yt-pause").disabled = !account;
    if (!initialized) {
      $("yt-title").value = result.defaults.title_template;
      $("yt-description").value = result.defaults.description_template;
      $("yt-limit").value = String(account?.daily_limit ?? 10);
      $("yt-parameters").replaceChildren();
      for (const key of result.parameters) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `{${key}}`;
        button.title = parameterNames[key];
        button.onclick = () => {
          const token = `{${key}}`;
          const start = editing.selectionStart;
          const end = editing.selectionEnd;
          editing.setRangeText(token, start, end, "end");
          editing.focus();
        };
        $("yt-parameters").appendChild(button);
      }
      initialized = true;
    }
    updateSelection();
  }
  async function loadTrips() {
    const limit = pageSize();
    const result = await apiFetch(
      `/api/trips?limit=${limit}&offset=${(tripPage - 1) * limit}${$("yt-date").value ? `&date=${$("yt-date").value}` : ""}`,
    );
    trips = result.trips;
    $("yt-trips").innerHTML = trips.length
      ? trips
          .map(
            (t) =>
              `<label class="yt-row"><input type="checkbox" data-trip="${escape(t.trip_id)}" ${selected.has(t.trip_id) ? "checked" : ""} aria-label="選擇 ${escape(t.date)} 第 ${t.day_order} 趟"><span class="yt-row-main"><strong>${escape(t.date)} · ${fmtTime(t.start_epoch)} ～ ${fmtTime(t.end_epoch)} · 第 ${t.day_order} 趟</strong><small>${t.has_front ? "前鏡頭" : ""}${t.has_front && t.has_rear ? " ＋ " : ""}${t.has_rear ? "後鏡頭" : ""} · ${fmtDuration(t.duration_sec)} · ${escape(t.device?.nickname || t.device?.model || "行車記錄器")}</small></span><span class="yt-status">${t.has_front && t.has_rear ? "雙鏡頭 · 2 部" : "單鏡頭 · 1 部"}</span></label>`,
          )
          .join("")
      : '<p class="yt-empty">這個日期沒有自己的旅程。可切換日期，或先到上傳頁匯入影片。</p>';
    $("yt-trips")
      .querySelectorAll("[data-trip]")
      .forEach((input) => {
        input.onchange = () => {
          const t = trips.find((t) => t.trip_id === input.dataset.trip);
          if (input.checked) selected.set(t.trip_id, t);
          else selected.delete(t.trip_id);
          updateSelection();
        };
      });
    pager("yt-trip-pager", tripPage, result.total, limit, async (p) => {
      tripPage = p;
      await loadTrips();
    });
    updateSelection();
  }
  function setting(index) {
    settingPage = Math.max(0, Math.min(2, index));
    for (const [i, name] of ["metadata", "schedule", "review"].entries()) {
      $(`yt-settings-${name}`).hidden = i !== settingPage;
      document
        .querySelector(`[data-settings="${name}"]`)
        .setAttribute("aria-selected", String(i === settingPage));
    }
    $("yt-settings-prev").disabled = settingPage === 0;
    $("yt-settings-next").hidden = settingPage === 2;
    $("yt-submit").hidden = settingPage !== 2;
    $("yt-setting-page").textContent = `設定 ${settingPage + 1} / 3`;
    updateSelection();
  }
  async function switchTab(name) {
    tab = name;
    for (const button of document.querySelectorAll("[data-tab]"))
      button.setAttribute("aria-selected", String(button.dataset.tab === tab));
    for (const name of ["select", "settings", "queue", "archive", "account"])
      $(`yt-${name}`).hidden = name !== tab;
    if (tab === "select") await loadTrips();
    if (tab === "queue") await loadUploads();
    if (tab === "archive") await loadArchives();
  }
  async function loadUploads() {
    const limit = pageSize(),
      result = await apiFetch(`/api/youtube/uploads?page=${queuePage}&limit=${limit}`);
    const counts = Object.fromEntries(result.counts.map((x) => [x.status, x.n]));
    $("yt-active-count").textContent = String(
      (counts.queued || 0) + (counts.uploading || 0) + (counts.processing || 0),
    );
    $("yt-queue-summary").textContent =
      `等待 ${counts.queued || 0} · 上傳 ${counts.uploading || 0} · 處理 ${counts.processing || 0} · 完成 ${counts.succeeded || 0} · 需處理 ${counts.failed || 0}`;
    $("yt-uploads").innerHTML = result.uploads.length
      ? result.uploads
          .map(
            (u) =>
              `<div class="yt-row yt-job" role="button" tabindex="0" data-job="${u.id}" aria-current="${u.id === activeJob}"><span class="yt-row-main"><strong>${escape(u.title)}</strong><small>${names[u.status] || escape(u.status)} · ${u.progress}% · ${escape(u.message)}</small><progress class="yt-progress" max="100" value="${u.progress}" aria-label="上傳進度"></progress>${u.status === "queued" && u.not_before > Date.now() ? `<small>預計 ${new Date(u.not_before).toLocaleString("zh-TW")} 後再嘗試</small>` : ""}</span><span class="yt-status">${u.camera === "front" ? "前鏡頭" : "後鏡頭"}</span></div>`,
          )
          .join("")
      : '<p class="yt-empty">尚未有上傳工作。先選擇旅程，再加入佇列。</p>';
    for (const el of $("yt-uploads").querySelectorAll("[data-job]")) {
      const open = async () => {
        activeJob = Number(el.dataset.job);
        logPage = 1;
        await loadDetail();
        $("yt-uploads")
          .querySelectorAll("[data-job]")
          .forEach((row) =>
            row.setAttribute("aria-current", String(Number(row.dataset.job) === activeJob)),
          );
      };
      el.onclick = () => {
        void action(el, open);
      };
      el.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void open();
        }
      };
    }
    for (const u of result.uploads) {
      if (
        previousStates.has(u.id) &&
        previousStates.get(u.id) !== "succeeded" &&
        u.status === "succeeded"
      )
        notice(`已完成 YouTube 上傳：${u.title}。可到「已上傳」查看。`);
      previousStates.set(u.id, u.status);
    }
    pager("yt-upload-pager", queuePage, result.total, limit, async (p) => {
      queuePage = p;
      await loadUploads();
    });
    if (activeJob) await loadDetail();
  }
  async function loadDetail() {
    if (!activeJob) return;
    const data = await apiFetch(`/api/youtube/uploads/${activeJob}?page=${logPage}`),
      u = data.upload;
    const detail = $("yt-job-detail");
    detail.classList.add("has-job");
    detail.innerHTML = `<button id="yt-detail-back" class="btn btn--ghost btn--sm">返回工作清單</button><h2>${escape(u.title)}</h2><p>${escape(u.message)}</p><progress class="yt-progress" max="100" value="${u.progress}" aria-label="此影片上傳進度"></progress><p>${u.progress}% · ${fmtBytes(u.uploaded_bytes)} / ${fmtBytes(u.source_size)}</p><div class="yt-toolbar">${["queued", "uploading", "failed"].includes(u.status) ? '<button id="yt-job-cancel" class="btn btn--ghost btn--sm">取消工作</button>' : ""}${["failed", "cancelled"].includes(u.status) ? '<button id="yt-job-retry" class="btn btn--ghost btn--sm">重試／續傳</button>' : ""}${u.can_restart && u.status === "failed" ? '<button id="yt-job-restart" class="btn btn--ghost btn--sm">確認後重新上傳</button>' : ""}${u.video_url ? `<a href="${escape(u.video_url)}" class="btn btn--ghost btn--sm" target="_blank" rel="noopener">查看 YouTube</a>` : ""}</div><ul class="yt-events">${data.events.map((event) => `<li><time>${new Date(event.created_at).toLocaleString("zh-TW")}</time>${escape(event.message)}</li>`).join("")}</ul><div id="yt-log-pager" class="yt-pager"></div>`;
    $("yt-detail-back").onclick = () => {
      activeJob = null;
      detail.classList.remove("has-job");
      detail.innerHTML = '<p class="yt-empty">選擇一部影片查看操作紀錄。</p>';
    };
    if ($("yt-job-cancel"))
      $("yt-job-cancel").onclick = (e) =>
        action(e.currentTarget, async () => {
          await request(`/api/youtube/uploads/${u.id}/cancel`, {});
          await loadUploads();
        });
    if ($("yt-job-retry"))
      $("yt-job-retry").onclick = (e) =>
        action(e.currentTarget, async () => {
          await request(`/api/youtube/uploads/${u.id}/retry`, {});
          await loadUploads();
        });
    if ($("yt-job-restart"))
      $("yt-job-restart").onclick = (e) =>
        action(e.currentTarget, async () => {
          if (
            !confirm(
              "續傳工作階段可能已過期。請先到 YouTube Studio 確認沒有已完成的相同影片，以免重複上傳。確定從頭重新上傳？",
            )
          )
            return;
          await request(`/api/youtube/uploads/${u.id}/retry`, { restart_confirmed: true });
          await loadUploads();
        });
    pager("yt-log-pager", logPage, data.total, data.limit, async (p) => {
      logPage = p;
      await loadDetail();
    });
  }
  async function loadArchives() {
    const limit = pageSize(),
      result = await apiFetch(
        `/api/youtube/uploads?filter=archive&page=${archivePage}&limit=${limit}`,
      );
    $("yt-archives").innerHTML = result.uploads.length
      ? result.uploads
          .map(
            (u) =>
              `<div class="yt-row">${!u.deleted_at ? `<input type="checkbox" data-cleanup="${escape(u.trip_id)}" ${cleanupSelection.has(u.trip_id) ? "checked" : ""} aria-label="勾選 ${escape(u.date)} 第 ${u.trip_no} 趟以清理本機" ${u.status !== "succeeded" ? "disabled" : ""}>` : '<span class="yt-status">本機已清理</span>'}<span class="yt-row-main"><strong>${escape(u.title)}</strong><small>${u.camera === "front" ? "前鏡頭" : "後鏡頭"} · ${names[u.status]} · 旅程 ${escape(u.trip_id)}</small></span><div class="yt-row-actions"><a class="btn btn--ghost btn--sm" href="${escape(u.video_url)}" target="_blank" rel="noopener">YouTube</a>${!u.deleted_at ? `<a class="btn btn--ghost btn--sm" href="/api/youtube/uploads/${u.id}/download">下載本機原檔</a>` : ""}<a class="btn btn--ghost btn--sm" href="${escape(u.studio_url)}" target="_blank" rel="noopener">雲端下載（Studio）</a><button class="btn btn--ghost btn--sm" data-verify="${u.id}">確認狀態</button></div></div>`,
          )
          .join("")
      : '<p class="yt-empty">尚未有已傳送到 YouTube 的影片。完成後會在此顯示前後鏡頭與下載入口。</p>';
    $("yt-archives")
      .querySelectorAll("[data-cleanup]")
      .forEach((input) => {
        input.onchange = () => {
          if (input.checked) cleanupSelection.add(input.dataset.cleanup);
          else cleanupSelection.delete(input.dataset.cleanup);
          $("yt-archives")
            .querySelectorAll("[data-cleanup]")
            .forEach((x) => {
              x.checked = cleanupSelection.has(x.dataset.cleanup);
            });
        };
      });
    $("yt-archives")
      .querySelectorAll("[data-verify]")
      .forEach((button) => {
        button.onclick = () =>
          action(button, async () => {
            const result = await request(
              `/api/youtube/uploads/${button.dataset.verify}/verify`,
              {},
            );
            notice(
              result.ready ? "YouTube 已完成處理。" : "YouTube 尚未完成處理，請保留本機影片。",
            );
            await loadArchives();
          });
      });
    pager("yt-archive-pager", archivePage, result.total, limit, async (p) => {
      archivePage = p;
      await loadArchives();
    });
  }
  async function preview() {
    const first = selected.values().next().value;
    if (!first) throw new Error("請先選擇旅程");
    const camera = $("yt-camera").value === "rear" || !first.has_front ? "rear" : "front";
    const data = await request("/api/youtube/preview", {
      trip_id: first.trip_id,
      camera,
      title_template: $("yt-title").value,
      description_template: $("yt-description").value,
    });
    $("yt-preview-result").textContent = `${data.title}\n\n${data.description}`;
  }
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.onclick = () => action(button, () => switchTab(button.dataset.tab));
  });
  document.querySelectorAll("[data-settings]").forEach((button, index) => {
    button.onclick = () => setting(index);
  });
  document.querySelectorAll("[data-account]").forEach((button) => {
    button.onclick = () => {
      document
        .querySelectorAll("[data-account]")
        .forEach((b) => b.setAttribute("aria-selected", String(b === button)));
      $("yt-account-connection").hidden = button.dataset.account !== "connection";
      $("yt-account-setup").hidden = button.dataset.account !== "setup";
    };
  });
  for (const id of ["yt-title", "yt-description"])
    $(id).onfocus = () => {
      editing = $(id);
    };
  $("yt-date").onchange = () => {
    tripPage = 1;
    void loadTrips().catch((e) => notice(e.message));
  };
  $("yt-clear-date").onclick = () => {
    $("yt-date").value = "";
    tripPage = 1;
    void loadTrips().catch((e) => notice(e.message));
  };
  $("yt-select-page").onclick = () => {
    trips.forEach((t) => selected.set(t.trip_id, t));
    void loadTrips().catch((e) => notice(e.message));
  };
  $("yt-clear-selection").onclick = () => {
    selected.clear();
    void loadTrips().catch((e) => notice(e.message));
  };
  $("yt-next").onclick = () => {
    setting(0);
    void switchTab("settings");
  };
  $("yt-settings-prev").onclick = () => setting(settingPage - 1);
  $("yt-settings-next").onclick = () => setting(settingPage + 1);
  $("yt-camera").onchange = updateSelection;
  $("yt-limit").oninput = updateSelection;
  $("yt-preview").onclick = (e) => action(e.currentTarget, preview);
  $("yt-submit").onclick = (e) =>
    action(e.currentTarget, async () => {
      if (!account) {
        await switchTab("account");
        throw new Error("請先連結 YouTube 頻道");
      }
      if (!$("yt-confirm-upload").checked) throw new Error("請先勾選上傳確認");
      if (!selected.size) throw new Error("請先選擇旅程");
      const daily_limit = Number($("yt-limit").value),
        start = $("yt-start").value ? new Date($("yt-start").value).getTime() : Date.now();
      if (!Number.isFinite(start)) throw new Error("排程時間不正確");
      busy = true;
      try {
        await preview();
        await request("/api/youtube/account", { daily_limit }, "PATCH");
        const result = await request("/api/youtube/uploads", {
          trip_ids: [...selected.keys()],
          camera: $("yt-camera").value,
          privacy: $("yt-privacy").value,
          made_for_kids: $("yt-kids").value === "true",
          not_before: start,
          title_template: $("yt-title").value,
          description_template: $("yt-description").value,
        });
        notice(`已加入 ${result.added} 部，略過 ${result.skipped} 部相同版本的既有工作。`);
        selected.clear();
        $("yt-confirm-upload").checked = false;
        queuePage = 1;
        await loadAccount();
        await switchTab("queue");
      } finally {
        busy = false;
      }
    });
  $("yt-pause").onclick = (e) =>
    action(e.currentTarget, async () => {
      await request("/api/youtube/account", { paused: !account.paused }, "PATCH");
      await loadAccount();
      await loadUploads();
    });
  $("yt-refresh").onclick = (e) =>
    action(e.currentTarget, async () => {
      await loadAccount();
      await loadUploads();
    });
  $("yt-connect").onclick = (e) =>
    action(e.currentTarget, async () => {
      if (!$("yt-policy").checked) throw new Error("請先閱讀並同意條款與隱私說明");
      const data = await request("/api/youtube/connect", { accept_policy: true });
      location.href = data.url;
    });
  $("yt-disconnect").onclick = (e) =>
    action(e.currentTarget, async () => {
      if (
        !confirm(
          "解除連結會停止上傳並刪除本站授權、雲端連結與紀錄。本機及 YouTube 影片會保留。確定解除？",
        )
      )
        return;
      const result = await apiFetch("/api/youtube/account", { method: "DELETE" });
      activeJob = null;
      previousStates.clear();
      await loadAccount();
      notice(
        result.revoked
          ? "已解除連結並刪除本站授權資料。"
          : "本站資料已刪除；Google 撤銷暫時失敗，請到 Google 帳號第三方存取設定撤銷授權。",
      );
    });
  $("yt-cleanup").onclick = (e) =>
    action(e.currentTarget, async () => {
      if (!cleanupSelection.size) throw new Error("請先勾選要清理的旅程");
      if (
        !confirm(
          `即將永久清理 ${cleanupSelection.size} 趟旅程的本機影片。系統會再次確認每個現有鏡頭已上傳、處理完成且版本相同。YouTube 無法保證永久保存或原畫質下載，請先自行保存重要原檔。確定清理？`,
        )
      )
        return;
      busy = true;
      try {
        const result = await request("/api/youtube/cleanup", {
          trip_ids: [...cleanupSelection],
          confirm_delete: true,
        });
        const done = result.results.filter((r) => r.deleted);
        done.forEach((r) => cleanupSelection.delete(r.trip_id));
        notice(
          `已清理 ${done.length} 趟。${result.results
            .filter((r) => !r.deleted)
            .map((r) => `${r.trip_id}：${r.detail}`)
            .join("；")}`,
        );
        await loadArchives();
      } finally {
        busy = false;
      }
    });
  $("yt-save-config").onclick = (e) =>
    action(e.currentTarget, async () => {
      await request(
        "/api/youtube/config",
        {
          client_id: $("yt-client-id").value,
          client_secret: $("yt-client-secret").value,
          redirect_uri: $("yt-redirect").value,
          project_daily_limit: Number($("yt-project-limit").value),
        },
        "PUT",
      );
      $("yt-client-secret").value = "";
      await loadAccount();
      notice("OAuth 設定已加密儲存，可切換到「我的頻道」連結帳號。");
    });
  async function poll() {
    if (pollRunning || busy || document.hidden) return;
    pollRunning = true;
    try {
      await loadAccount();
      if (tab === "queue") await loadUploads();
      if (tab === "archive") await loadArchives();
      $("yt-poll-status").textContent = `更新 ${new Date().toLocaleTimeString("zh-TW")}`;
    } catch {
      $("yt-poll-status").textContent = "連線中斷，稍後重試";
    } finally {
      pollRunning = false;
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void poll();
  });
  window.addEventListener("pagehide", () => clearInterval(timer));
  (async () => {
    const user = await checkAuth();
    if (!user) return;
    renderHeader(user);
    await configReady;
    await loadAccount();
    await loadTrips();
    if (user.is_owner) {
      $("yt-setup-tab").hidden = false;
      const config = await apiFetch("/api/youtube/config");
      $("yt-client-id").value = config.client_id;
      $("yt-redirect").value = config.redirect_uri || `${location.origin}/api/youtube/callback`;
      $("yt-project-limit").value = String(config.project_daily_limit);
    }
    const oauth = new URLSearchParams(location.search).get("oauth");
    if (oauth) {
      await switchTab("account");
      notice(
        oauth === "connected"
          ? "YouTube 頻道已連結。"
          : oauth === "cancelled"
            ? "已取消 Google 授權。"
            : "Google 授權未完成。請檢查 OAuth 設定、測試使用者與 YouTube 頻道後重新連結。",
      );
      history.replaceState(null, "", "/youtube");
    }
    timer = setInterval(() => void poll(), 5000);
  })().catch((error) => notice(error.message || "載入失敗，請重新整理"));
})();
