/* The database is authoritative; details are loaded from the saved job event log. */
const jobNames = { clip: "匯出片段", trim: "整趟裁剪", restore: "還原影片", import: "整理上傳" };
const jobIcons = {
  import:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  clip: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>',
  trim: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  restore: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
};
const jobStates = {
  queued: "等待執行",
  running: "處理中",
  cancelling: "正在取消",
  cancelled: "已取消",
  succeeded: "已完成",
  partial: "部分成功",
  failed: "失敗",
  interrupted: "重啟中斷",
};
const activeStates = new Set(["queued", "running", "cancelling"]);
const attentionStates = new Set(["failed", "interrupted", "partial", "cancelled"]);
let jobRows = [],
  jobLimit = 50,
  jobLoading = false,
  currentFilter = "",
  selectedId = decodeURIComponent(location.hash.slice(1)) || null,
  detailSeq = 0,
  detailSig = "";
const node = (tag, value, cls) => {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (cls) element.className = cls;
  return element;
};
const time = (value) =>
  new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
const shortTime = (value) =>
  new Intl.DateTimeFormat("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
const safeProgress = (value) => Math.max(0, Math.min(100, Number(value) || 0));
const tone = (status) =>
  status === "succeeded" ? "success" : attentionStates.has(status) ? "warning" : "active";
function matches(row) {
  return (
    !currentFilter ||
    (currentFilter === "active"
      ? activeStates.has(row.status)
      : currentFilter === "attention"
        ? attentionStates.has(row.status)
        : row.status === currentFilter)
  );
}
function relative(value) {
  const diff = Date.now() - value;
  if (diff < 60_000) return "剛剛";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return time(value);
}
function icon(type) {
  const span = node("span", undefined, "job-ico");
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${jobIcons[type] || jobIcons.import}</svg>`;
  return span;
}

function renderList() {
  const list = document.getElementById("job-list");
  list.replaceChildren();
  const count = (fn) => jobRows.filter(fn).length;
  document.getElementById("count-all").textContent = jobRows.length;
  document.getElementById("count-active").textContent = count((j) => activeStates.has(j.status));
  document.getElementById("count-complete").textContent = count((j) => j.status === "succeeded");
  document.getElementById("count-attention").textContent = count((j) =>
    attentionStates.has(j.status),
  );
  const rows = jobRows.filter(matches);
  for (const job of rows) {
    const item = node("button", undefined, "job-card");
    item.type = "button";
    item.dataset.id = job.id;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(job.id === selectedId));
    const main = node("span", undefined, "job-card-main");
    const top = node("span", undefined, "job-card-top");
    top.append(node("strong", jobNames[job.type] || job.type, "job-type"));
    const state = node("span", jobStates[job.status] || job.status, "job-state");
    state.dataset.tone = tone(job.status);
    top.append(state);
    main.append(top, node("span", job.message || "等待處理紀錄…", "job-message"));
    if (activeStates.has(job.status)) {
      const bar = node("span", undefined, "job-mini-bar");
      const fill = node("span");
      fill.style.width = safeProgress(job.progress) + "%";
      bar.append(fill);
      main.append(bar);
    }
    main.append(node("span", relative(job.created_at), "job-meta"));
    item.append(icon(job.type), main);
    item.onclick = () => select(job.id, true);
    list.append(item);
  }
  if (!rows.length) list.append(node("div", "目前沒有符合條件的工作。", "job-empty"));
}

function select(id, fromUser = false) {
  selectedId = id;
  detailSig = "";
  history.replaceState(null, "", "#" + encodeURIComponent(id));
  document
    .querySelectorAll(".job-card")
    .forEach((el) => el.setAttribute("aria-selected", String(el.dataset.id === id)));
  if (fromUser) document.getElementById("jobs-layout").classList.add("show-detail");
  void renderDetail();
}

async function renderDetail() {
  const pane = document.getElementById("job-detail");
  const job = jobRows.find((row) => row.id === selectedId);
  if (!job) {
    pane.replaceChildren(node("div", "選擇左側的作業以查看處理紀錄。", "job-empty"));
    return;
  }
  const seq = ++detailSeq;
  // 只在作業有變化時重建標頭,避免輪詢時閃爍
  const sig = JSON.stringify([job.id, job.status, job.message, job.progress, job.updated_at]);
  if (sig === detailSig && !activeStates.has(job.status)) return;
  detailSig = sig;
  let head = pane.querySelector(".job-detail-head");
  let log = pane.querySelector(".job-log");
  if (!head || pane.dataset.id !== job.id) {
    pane.dataset.id = job.id;
    head = node("div", undefined, "job-detail-head");
    log = node("div", undefined, "job-log");
    log.append(node("div", "載入處理紀錄…", "job-loading"));
    pane.replaceChildren(head, log);
  }
  head.replaceChildren();
  const back = node("button", "‹ 作業清單", "btn btn--ghost btn--sm job-back");
  back.type = "button";
  back.onclick = () => document.getElementById("jobs-layout").classList.remove("show-detail");
  const titleRow = node("div", undefined, "job-detail-title");
  titleRow.append(icon(job.type));
  const titles = node("div");
  titles.append(node("h2", jobNames[job.type] || job.type));
  const elapsed = (activeStates.has(job.status) ? Date.now() : job.updated_at) - job.created_at;
  titles.append(
    node(
      "p",
      `${time(job.created_at)} 建立 · ${activeStates.has(job.status) ? "已執行" : "耗時"} ${JobLog.span(elapsed)}`,
    ),
  );
  const state = node("span", jobStates[job.status] || job.status, "job-state");
  state.dataset.tone = tone(job.status);
  titleRow.append(titles);
  const actions = node("div", undefined, "job-actions");
  for (const [action, label, allowed] of [
    ["cancel", "取消工作", job.can_cancel],
    ["retry", "重新執行", job.can_retry],
  ])
    if (allowed) {
      const button = node("button", label, "btn btn--ghost btn--sm");
      button.type = "button";
      button.onclick = async () => {
        button.disabled = true;
        try {
          await apiFetch(`/api/jobs/${job.id}/${action}`, { method: "POST" });
          await loadJobs();
        } catch (error) {
          showToast(error.message, "error");
          button.disabled = false;
        }
      };
      actions.append(button);
    }
  if (job.result?.clip?.id || !activeStates.has(job.status)) {
    const link = node(
      "a",
      job.result?.clip?.id ? "查看片段" : job.type === "import" ? "瀏覽旅程" : "回到旅程",
      "btn btn--solid btn--sm",
    );
    link.href = job.result?.clip?.id
      ? `/clips#clip-${job.result.clip.id}`
      : job.type === "import"
        ? "/browse"
        : `/trip/${encodeURIComponent(job.target)}`;
    actions.append(link);
  }
  actions.prepend(state);
  titleRow.append(actions);
  head.append(back, titleRow);
  if (activeStates.has(job.status)) {
    const progress = node("progress", undefined, "job-progress");
    progress.max = 100;
    progress.value = safeProgress(job.progress);
    progress.setAttribute("aria-label", `處理進度 ${Math.round(progress.value)}%`);
    head.append(progress);
  }

  try {
    const events = await apiFetch(`/api/jobs/${encodeURIComponent(job.id)}/events`);
    if (seq !== detailSeq) return;
    const scroller = log;
    const top = scroller.scrollTop;
    JobLog.render(log, events, { status: job.status });
    scroller.scrollTop = top;
  } catch (error) {
    if (seq === detailSeq) log.replaceChildren(node("p", `無法載入處理紀錄：${error.message}`));
  }
}

async function loadJobs() {
  if (jobLoading) return;
  jobLoading = true;
  try {
    const rows = [];
    for (let offset = 0; offset < jobLimit; offset += 50) {
      const batch = await apiFetch(`/api/jobs?offset=${offset}`);
      rows.push(...batch);
      if (batch.length < 50) break;
    }
    const changed = JSON.stringify(rows) !== JSON.stringify(jobRows);
    jobRows = rows;
    if (!selectedId || !rows.some((row) => row.id === selectedId)) {
      selectedId = (rows.find((row) => activeStates.has(row.status)) || rows[0])?.id ?? null;
      detailSig = "";
    }
    if (changed) renderList();
    const current = rows.find((row) => row.id === selectedId);
    if (changed || (current && activeStates.has(current.status))) void renderDetail();
    document.getElementById("connection").textContent = `更新於 ${shortTime(Date.now())}`;
    document.getElementById("more").hidden = rows.length < jobLimit;
  } catch (error) {
    document.getElementById("connection").textContent = `暫時無法更新：${error.message}`;
  } finally {
    jobLoading = false;
  }
}
document.querySelectorAll(".jobs-filter").forEach((button) => {
  button.addEventListener("click", () => {
    currentFilter = button.dataset.filter;
    document.querySelectorAll(".jobs-filter").forEach((item) => {
      const selected = item === button;
      item.classList.toggle("is-active", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    renderList();
  });
});
document.getElementById("refresh").onclick = loadJobs;
window.addEventListener("hashchange", () => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id && id !== selectedId && jobRows.some((row) => row.id === id)) {
    select(id);
    renderList();
  }
});
document.getElementById("more").onclick = () => {
  jobLimit += 50;
  void loadJobs();
};
(async () => {
  await configReady;
  const user = await checkAuth();
  if (!user) return;
  renderHeader(user);
  await loadJobs();
  setInterval(() => {
    if (!document.hidden) void loadJobs();
  }, 4000);
})();
