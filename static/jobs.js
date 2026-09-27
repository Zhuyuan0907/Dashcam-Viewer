/* The database is authoritative; details are loaded from the saved job event log. */
const jobNames = { clip: "匯出片段", trim: "整趟裁剪", restore: "還原影片", import: "整理上傳" };
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
const stageNames = {
  queued: "排入佇列",
  running: "開始處理",
  succeeded: "處理完成",
  partial: "部分完成",
  failed: "處理失敗",
  cancelled: "已取消",
  interrupted: "服務中斷",
  scan: "掃描檔案",
  duration: "讀取影片時長",
  detect: "辨識旅程",
  finalizing: "收尾與儲存",
  ingest: "接收檔案",
  merge: "合併影片",
  probe: "讀取媒體資訊",
  done: "完成",
  error: "錯誤",
};
const activeStates = new Set(["queued", "running", "cancelling"]);
const attentionStates = new Set(["failed", "interrupted", "partial", "cancelled"]);
let jobRows = [],
  jobLimit = 50,
  jobLoading = false,
  currentFilter = "";
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
async function loadEvents(details, job) {
  const list = details.querySelector(".job-timeline");
  try {
    const events = await apiFetch(`/api/jobs/${encodeURIComponent(job.id)}/events`);
    list.replaceChildren();
    if (!events.length) {
      list.append(node("li", "這是舊工作：當時只保存最後結果，沒有逐步處理紀錄。"));
      return;
    }
    for (const event of events) {
      const item = node("li");
      item.append(node("span", shortTime(event.created_at), "job-time"));
      const description = node("div", undefined, "job-step");
      description.append(node("strong", stageNames[event.stage] || event.stage));
      if (event.message) description.append(node("span", event.message));
      item.append(description);
      const count = event.total > 0 ? `${event.done ?? 0} / ${event.total}` : "";
      item.append(node("span", count, "job-percent"));
      list.append(item);
    }
  } catch (error) {
    list.replaceChildren(node("li", `無法載入處理紀錄：${error.message}`));
  }
}
function renderJobs() {
  const list = document.getElementById("job-list");
  const open = new Set([...list.querySelectorAll(".job-details[open]")].map((el) => el.dataset.id));
  list.replaceChildren();
  document.getElementById("count-active").textContent = jobRows.filter((j) =>
    activeStates.has(j.status),
  ).length;
  document.getElementById("count-complete").textContent = jobRows.filter(
    (j) => j.status === "succeeded",
  ).length;
  document.getElementById("count-attention").textContent = jobRows.filter((j) =>
    attentionStates.has(j.status),
  ).length;
  const rows = jobRows.filter(matches);
  for (const job of rows) {
    const card = node("article", undefined, "info-card job-card");
    const head = node("div", undefined, "job-top");
    const left = node("div");
    left.append(
      node("h2", jobNames[job.type] || job.type, "job-type"),
      node("div", `建立於 ${time(job.created_at)}`, "job-meta"),
    );
    const status = node("span", jobStates[job.status] || job.status, "job-state");
    status.dataset.tone =
      job.status === "succeeded"
        ? "success"
        : attentionStates.has(job.status)
          ? "warning"
          : "active";
    head.append(left, status);
    card.append(head, node("p", job.message || "等待處理紀錄…", "job-message"));
    if (activeStates.has(job.status)) {
      const progress = node("progress", undefined, "job-progress");
      progress.max = 100;
      progress.value = safeProgress(job.progress);
      progress.setAttribute("aria-label", `處理進度 ${Math.round(progress.value)}%`);
      card.append(progress);
    }
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
    const link = node(
      "a",
      job.result?.clip?.id ? "查看片段" : job.type === "import" ? "瀏覽旅程" : "回到旅程",
      "btn btn--ghost btn--sm",
    );
    link.href = job.result?.clip?.id
      ? `/clips#clip-${job.result.clip.id}`
      : job.type === "import"
        ? "/browse"
        : `/trip/${encodeURIComponent(job.target)}`;
    if (job.result?.clip?.id || !activeStates.has(job.status)) actions.append(link);
    if (actions.children.length) card.append(actions);
    const details = node("details", undefined, "job-details");
    details.dataset.id = job.id;
    details.append(node("summary", "查看處理紀錄"), node("ol", undefined, "job-timeline"));
    details.addEventListener("toggle", () => {
      if (details.open) void loadEvents(details, job);
    });
    card.append(details);
    list.append(card);
    if (open.has(job.id)) details.open = true;
  }
  if (!rows.length) list.append(node("div", "目前沒有符合條件的工作。", "job-empty"));
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
    if (JSON.stringify(rows) !== JSON.stringify(jobRows)) {
      jobRows = rows;
      renderJobs();
    }
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
    renderJobs();
  });
});
document.getElementById("refresh").onclick = loadJobs;
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
