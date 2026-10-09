/* 背景作業紀錄整理器:把逐筆進度事件({stage,message,created_at,…})整理成
 * 「階段 → 重點數據 → 每趟旅程合併明細 → 原始紀錄」,重複的計數訊息(如「時長讀取中… 4/147」)
 * 合併成一列帶進度條的項目,不再逐行重播。作業中心與上傳頁共用。 */
(() => {
  const PHASES = [
    ["queued", "排隊"],
    ["scan", "掃描檔案"],
    ["duration", "讀取時長"],
    ["detect", "辨識旅程"],
    ["merge", "合併影片"],
    ["encode", "轉檔輸出"],
    ["finalizing", "收尾"],
  ];
  const PHASE_INDEX = new Map(PHASES.map(([key], index) => [key, index]));
  const END_STAGES = new Set(["done", "succeeded", "partial", "failed", "error", "cancelled", "interrupted"]);
  const BAD_STAGES = new Set(["failed", "error", "interrupted", "cancelled"]);
  const ACTIVE = new Set(["queued", "running", "cancelling"]);

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };
  const clock = (ms) =>
    new Date(ms).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  function span(ms) {
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return `${sec} 秒`;
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return s ? `${m} 分 ${s} 秒` : `${m} 分`;
    const h = Math.floor(m / 60);
    return `${h} 小時 ${m % 60} 分`;
  }
  const mb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(2)} GB` : `${n.toFixed(n >= 100 ? 0 : 1)} MB`);
  const pattern = (message) => String(message || "").trim().replace(/\d+(\.\d+)?/g, "#");

  /** 解析事件 → 結構化模型。 */
  function parse(events, status = "") {
    const list = (events || []).map((e, i) => ({
      ...e,
      message: String(e.message || ""),
      at: Number(e.created_at) || Date.now(),
      i,
    }));
    const model = {
      start: list[0]?.at ?? null,
      end: list.at(-1)?.at ?? null,
      phases: [],
      facts: {},
      steps: [],
      trips: [],
      final: null,
      raw: list,
    };
    const live = ACTIVE.has(status) || (!status && !list.some((e) => END_STAGES.has(e.stage)));
    const seen = new Map();
    let trip = null;

    const pushStep = (e, data) => {
      const last = model.steps.at(-1);
      const key = e.stage + "|" + pattern(e.message);
      if (last && last.key === key && data.collapsible) {
        Object.assign(last, data, { last: e.at, count: last.count + 1 });
        return last;
      }
      const step = { key, first: e.at, last: e.at, count: 1, stage: e.stage, ...data };
      model.steps.push(step);
      return step;
    };

    for (const e of list) {
      if (PHASE_INDEX.has(e.stage) && !seen.has(e.stage)) seen.set(e.stage, e.at);
      const msg = e.message.trim();
      let m;

      if (e.stage === "merge" && (m = /^\[(\d+)\/(\d+)\]\s*處理旅程[:：]\s*(.+)$/.exec(msg))) {
        trip = { n: +m[1], of: +m[2], label: m[3], start: e.at, end: null, cams: {}, state: "run", notes: [] };
        model.trips.push(trip);
        model.facts.toProcess = +m[2];
        continue;
      }
      if (e.stage === "merge" && trip) {
        if ((m = /^(\S+?)\s*合併中…\s*\((\d+)\s*段\)/.exec(msg))) {
          trip.cams[m[1]] = { segs: +m[2], state: "run", start: e.at };
          continue;
        }
        if ((m = /^(\S+?)\s*完成\s*\(([\d.]+)\s*MB\)/.exec(msg))) {
          const cam = (trip.cams[m[1]] ||= { segs: null, start: e.at });
          Object.assign(cam, { state: "ok", mb: +m[2], end: e.at });
          continue;
        }
        if ((m = /^(\S+?)\s*(?:失敗|無法安全合併)[:：]?\s*(.*)$/.exec(msg))) {
          const cam = (trip.cams[m[1]] ||= { segs: null, start: e.at });
          Object.assign(cam, { state: "bad", end: e.at, error: m[2] });
          trip.notes.push(msg);
          continue;
        }
        if (/^旅程完成[:：]/.test(msg)) {
          trip.end = e.at;
          trip.state = Object.values(trip.cams).some((c) => c.state === "bad") ? "warn" : "ok";
          continue;
        }
        if (/合併失敗|略過|丟棄/.test(msg)) {
          trip.notes.push(msg.replace(/^⚠\s*/, ""));
          if (/合併失敗/.test(msg)) { trip.state = "bad"; trip.end = e.at; }
          continue;
        }
      }

      if (END_STAGES.has(e.stage)) {
        // 「全部完成!」等 done 事件與最終狀態事件分開:最後一筆作為結果
        model.final = { stage: e.stage, message: msg, at: e.at };
        continue;
      }

      if ((m = /找到\s*(\d+)\s*組/.exec(msg))) model.facts.segments = +m[1];
      if ((m = /偵測到\s*(\d+)\s*趟旅程(?:\(間隔閾值\s*(\d+)\s*分鐘\))?/.exec(msg))) {
        model.facts.trips = +m[1];
        if (m[2]) model.facts.gap = +m[2];
      }
      if ((m = /其中\s*(\d+)\s*趟需要處理/.exec(msg))) model.facts.toProcess = +m[1];
      if ((m = /共處理\s*(\d+)\s*趟/.exec(msg))) model.facts.processed = +m[1];

      // 計數型訊息:N/M 或 N%
      let done = null, total = null;
      if ((m = /(\d+)\s*\/\s*(\d+)/.exec(msg))) { done = +m[1]; total = +m[2]; }
      else if ((m = /(\d+)\s*%/.exec(msg))) { done = +m[1]; total = 100; }
      else if (Number(e.total) > 0 && e.done !== null && e.done !== undefined) { done = Number(e.done) || 0; total = Number(e.total); }

      if (e.stage === "duration" && /讀取影片時長\(共\s*(\d+)/.test(msg)) {
        const n = +/共\s*(\d+)/.exec(msg)[1];
        pushStep(e, { title: `讀取 ${n} 個片段的時長`, done: 0, total: n, collapsible: false, phase: "duration" });
        continue;
      }
      if (e.stage === "duration" && done !== null) {
        const step = model.steps.findLast?.((s) => s.phase === "duration") || model.steps.at(-1);
        if (step && step.phase === "duration") {
          Object.assign(step, { done, total, last: e.at, count: step.count + 1 });
          continue;
        }
      }
      if ((m = /^其中\s*(\d+)\s*趟需要處理/.exec(msg))) {
        const prev = model.steps.at(-1);
        if (prev && prev.stage === "detect") { prev.title += `，${m[1]} 趟需要處理`; prev.last = e.at; continue; }
      }
      if (/^全部完成/.test(msg) && model.trips.length) continue;
      if (e.stage === "detect" && (m = /^偵測到\s*(\d+)\s*趟旅程\(間隔閾值\s*(\d+)\s*分鐘\)/.exec(msg))) {
        pushStep(e, { title: `偵測到 ${m[1]} 趟旅程（間隔 ${m[2]} 分鐘切趟）`, collapsible: false });
        continue;
      }
      if (/^掃描影片檔案中|^已加入背景作業|^開始整理/.test(msg)) {
        pushStep(e, { title: msg.replace(/…$/, ""), collapsible: false, quiet: true });
        continue;
      }
      pushStep(e, {
        title: done !== null && total === 100 ? msg.replace(/\s*\d+\s*%.*$/, "").replace(/…$/, "") : msg,
        done, total, collapsible: done !== null,
      });
    }

    // 合併總量
    let totalMb = 0;
    for (const t of model.trips) for (const c of Object.values(t.cams)) if (c.mb) totalMb += c.mb;
    if (totalMb) model.facts.outputMb = totalMb;
    if (live && trip && !trip.end) trip.state = "run";
    if (!live) for (const t of model.trips) if (t.state === "run") t.state = "stopped";

    // 階段
    const order = [...seen.keys()].sort((a, b) => PHASE_INDEX.get(a) - PHASE_INDEX.get(b));
    const finalBad = model.final && (BAD_STAGES.has(model.final.stage) || BAD_STAGES.has(status));
    order.forEach((key, index) => {
      const from = seen.get(key);
      const next = order[index + 1];
      const to = next ? seen.get(next) : (model.final?.at ?? (live ? Date.now() : model.end));
      const isLast = index === order.length - 1;
      model.phases.push({
        key,
        label: PHASES[PHASE_INDEX.get(key)][1],
        ms: to - from,
        state: isLast ? (live ? "now" : finalBad ? "bad" : "done") : "done",
      });
    });
    model.live = live;
    return model;
  }

  function factCards(model) {
    const f = model.facts;
    const cards = [];
    if (f.segments) cards.push([f.segments, "拍攝片段"]);
    if (f.trips) cards.push([f.trips, f.gap ? `趟旅程 · 間隔 ${f.gap} 分` : "趟旅程"]);
    if (model.trips.length) {
      const ok = model.trips.filter((t) => t.state === "ok").length;
      cards.push([`${ok} / ${f.toProcess || model.trips.length}`, "已合併"]);
    }
    if (f.outputMb) cards.push([mb(f.outputMb), "輸出影片"]);
    if (model.start) {
      const end = model.live ? Date.now() : (model.final?.at ?? model.end);
      cards.push([span(end - model.start), model.live ? "已執行" : "總耗時"]);
    }
    return cards;
  }

  function stepRow(step, live, isLastStep) {
    const pct = step.total ? Math.min(100, Math.round((step.done / step.total) * 100)) : null;
    const finished = pct === null ? !(live && isLastStep) : pct >= 100 || !(live && isLastStep);
    const state = /失敗|錯誤|無法/.test(step.title) ? "bad" : finished ? "ok" : "run";
    const row = el("div", "jl-row " + state);
    row.append(el("span", "jl-ico", state === "bad" ? "!" : ""));
    const main = el("div", "jl-main");
    main.append(el("strong", null, step.title));
    const detail = [];
    if (step.total && step.total !== 100) detail.push(`${step.done} / ${step.total}`);
    else if (pct !== null) detail.push(`${pct}%`);
    if (step.last - step.first >= 1000) detail.push(`耗時 ${span(step.last - step.first)}`);
    if (detail.length) main.append(el("span", null, detail.join(" · ")));
    if (pct !== null && (state === "run" || pct < 100)) {
      const bar = el("div", "jl-bar");
      const fill = el("div");
      fill.style.width = pct + "%";
      bar.append(fill);
      main.append(bar);
    }
    row.append(main, el("span", "jl-side", clock(step.first)));
    return row;
  }

  const STATE_TEXT = { ok: "完成", run: "合併中", bad: "失敗", warn: "部分完成", stopped: "中斷", wait: "等待" };
  function tripTable(model) {
    const cams = [];
    for (const t of model.trips) for (const name of Object.keys(t.cams)) if (!cams.includes(name)) cams.push(name);
    const table = el("table", "jl-trips");
    const head = el("tr");
    ["#", "旅程時段", ...cams, "耗時", "狀態"].forEach((label) => head.append(el("th", null, label)));
    const thead = el("thead");
    thead.append(head);
    const body = el("tbody");
    const rows = [...model.trips];
    // 進行中時列出尚未開始的趟次
    const of = model.trips[0]?.of || 0;
    if (model.live) for (let n = model.trips.length + 1; n <= of; n++) rows.push({ n, of, label: "—", cams: {}, state: "wait", notes: [] });
    for (const t of rows) {
      const tr = el("tr");
      tr.append(el("td", null, String(t.n).padStart(2, "0")));
      const label = el("td", "jl-trip-label", t.label);
      if (t.notes?.length) {
        label.append(el("div", null, ""));
        label.lastChild.style.cssText = "font-weight:400;font-size:11.5px;color:var(--warn);white-space:normal";
        label.lastChild.textContent = t.notes.join("；");
      }
      tr.append(label);
      for (const name of cams) {
        const c = t.cams[name];
        const parts = [];
        if (c?.segs) parts.push(`${c.segs} 段`);
        if (c?.mb) parts.push(mb(c.mb));
        if (c?.state === "run") parts.push("合併中…");
        if (c?.state === "bad") parts.push("失敗");
        tr.append(el("td", null, parts.join(" · ") || "—"));
      }
      tr.append(el("td", null, t.start ? span((t.end ?? (t.state === "run" ? Date.now() : t.start)) - t.start) : "—"));
      const st = el("td");
      st.append(el("span", "st " + (t.state === "stopped" ? "bad" : t.state), STATE_TEXT[t.state] || t.state));
      tr.append(st);
      body.append(tr);
    }
    table.append(thead, body);
    return table;
  }

  /** 把事件渲染進 container。opts.status = 作業狀態(running/succeeded/...)。 */
  function render(container, events, opts = {}) {
    const model = parse(events, opts.status);
    const root = el("div", "jl");

    if (!model.raw.length) {
      root.append(el("p", null, opts.emptyText || "這是舊工作：當時只保存最後結果，沒有逐步處理紀錄。"));
      container.replaceChildren(root);
      return model;
    }

    if (model.phases.length > 1 || model.live) {
      const steps = el("div", "jl-steps");
      for (const phase of model.phases) {
        const chip = el("span", "jl-step " + phase.state);
        chip.append(el("i", null, phase.state === "bad" ? "!" : ""));
        chip.append(document.createTextNode(phase.label));
        if (phase.ms >= 1000) chip.append(el("small", null, span(phase.ms)));
        steps.append(chip);
      }
      root.append(steps);
    }

    const facts = factCards(model);
    if (facts.length) {
      const grid = el("div", "jl-facts");
      for (const [value, label] of facts) {
        const card = el("div", "jl-fact");
        card.append(el("b", null, String(value)), el("span", null, label));
        grid.append(card);
      }
      root.append(grid);
    }

    const visible = model.steps.filter((s) => !s.quiet || model.steps.length < 3);
    if (visible.length) {
      const block = el("div", "jl-block");
      const head = el("div", "jl-block-head", model.trips.length ? "準備" : "處理步驟");
      head.append(el("span", "jl-when", model.start ? `${clock(model.start)} 開始` : ""));
      block.append(head);
      const bodyLive = model.live && !model.trips.length;
      visible.forEach((step, index) => block.append(stepRow(step, bodyLive, index === visible.length - 1)));
      root.append(block);
    }

    if (model.trips.length) {
      const block = el("div", "jl-block");
      const ok = model.trips.filter((t) => t.state === "ok").length;
      const head = el("div", "jl-block-head", "合併旅程");
      head.append(el("span", "jl-when", `${ok} / ${model.trips[0].of} 趟完成`));
      const scroll = el("div", "jl-trips-scroll");
      scroll.append(tripTable(model));
      block.append(head, scroll);
      root.append(block);
    }

    if (model.final) {
      const bad = BAD_STAGES.has(model.final.stage) || BAD_STAGES.has(opts.status);
      const block = el("div", "jl-block");
      const row = el("div", "jl-row " + (bad ? "bad" : model.final.stage === "partial" ? "warn" : "ok"));
      row.append(el("span", "jl-ico", bad ? "!" : ""));
      const main = el("div", "jl-main");
      main.append(el("strong", null, model.final.message || (bad ? "處理失敗" : "處理完成")));
      if (model.start) main.append(el("span", null, `總耗時 ${span(model.final.at - model.start)}`));
      row.append(main, el("span", "jl-side", clock(model.final.at)));
      block.append(row);
      root.append(block);
    }

    if (opts.raw !== false) {
      const details = el("details", "jl-raw");
      details.append(el("summary", null, `原始紀錄（${model.raw.length} 行）`));
      const ol = el("ol");
      details.addEventListener("toggle", () => {
        if (!details.open || ol.childElementCount) return;
        for (const e of model.raw) {
          const li = el("li");
          li.append(el("time", null, clock(e.at)), el("span", null, e.message));
          ol.append(li);
        }
      }, { once: false });
      details.append(ol);
      if (container.querySelector(".jl-raw[open]")) details.open = true;
      root.append(details);
    }

    container.replaceChildren(root);
    if (root.querySelector(".jl-raw[open]")) root.querySelector(".jl-raw").dispatchEvent(new Event("toggle"));
    return model;
  }

  /** 一行摘要(作業清單用)。 */
  function summary(events, status) {
    const model = parse(events, status);
    const parts = [];
    if (model.facts.trips) parts.push(`${model.facts.trips} 趟旅程`);
    if (model.facts.segments) parts.push(`${model.facts.segments} 組片段`);
    if (model.facts.outputMb) parts.push(mb(model.facts.outputMb));
    return parts.join(" · ");
  }

  window.JobLog = Object.freeze({ parse, render, summary, span });
})();
