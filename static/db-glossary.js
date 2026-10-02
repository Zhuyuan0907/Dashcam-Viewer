/* 資料庫白話辭典:讓不熟資料庫的人也看得懂每張表、每個欄位在記錄什麼。
 * tables[name] = { label, desc, title(row), summary: [欄位…] };columns[欄位] = [名稱, 說明]。
 * 未列出的表/欄位會以原名顯示,不影響功能。 */
(() => {
  const C = {
    id: ["編號", "這筆資料在表中的流水號"],
    user_id: ["使用者編號", "屬於哪一位使用者（對應「使用者帳號」表的編號）"],
    owner_id: ["擁有者編號", "這筆資料屬於哪一位使用者"],
    created_at: ["建立時間"],
    updated_at: ["最後更新"],
    expires_at: ["到期時間"],
    username: ["帳號"],
    display_name: ["顯示名稱"],
    password_hash: ["密碼（加密）", "只保存無法還原的雜湊值，不是密碼本身"],
    password: ["一次性密碼", "SFTP 上傳用的臨時密碼"],
    role: ["角色", "admin = 管理員、viewer = 一般使用者"],
    email: ["Email", "用來顯示 Gravatar 頭像"],
    is_owner: ["站台擁有者", "第一位建立的管理員"],
    must_change_password: ["需改密碼", "下次登入時必須先修改密碼"],
    trips_public: ["公開旅程", "其他使用者能否看到此人的旅程"],
    upload_idle_sec: ["上傳閒置逾時", "多久沒動作就自動結束上傳工作（秒）"],
    pref_camera: ["偏好鏡頭"],
    pref_speed: ["偏好播放速度"],
    pref_theme: ["介面主題"],
    device_note: ["舊版裝置備註", "改用多裝置前留下的文字"],
    token: ["登入憑證", "瀏覽器保存的登入通行證（已遮蔽）"],
    trip_id: ["旅程代號", "每一趟旅程獨一無二的識別碼"],
    date: ["日期"],
    day_order: ["當天第幾趟"],
    start_epoch: ["開始時間", "影片開始錄影的時間"],
    end_epoch: ["結束時間", "影片最後一格的時間"],
    duration_sec: ["長度"],
    segment_count: ["原始片段數", "合併前記錄器拍下的小檔案數量"],
    emer_count: ["緊急鎖檔數", "記錄器偵測到碰撞而鎖定的片段"],
    has_front: ["有前鏡頭"],
    has_rear: ["有後鏡頭"],
    front_path: ["前鏡頭檔案"],
    rear_path: ["後鏡頭檔案"],
    peak_gforce: ["最大 G 值", "最劇烈的晃動強度（1g ≈ 重力）"],
    gforce_events: ["高 G 事件數"],
    trip_dir: ["旅程資料夾"],
    public_override: ["個別公開設定", "空白 = 跟隨使用者的公開設定"],
    orig_start_epoch: ["裁剪前開始時間"],
    orig_end_epoch: ["裁剪前結束時間"],
    orig_duration_sec: ["裁剪前長度"],
    device_id: ["行車記錄器編號"],
    device_snapshot: ["記錄器資料快照", "當時的記錄器型號與名稱，之後改名也不影響舊資料"],
    timeline_json: ["時間軸", "合併後每個片段在影片中的位置"],
    orig_timeline_json: ["裁剪前時間軸"],
    trim_offset_sec: ["裁剪位移", "整趟裁剪時去掉的開頭秒數"],
    superseded_by: ["已併入", "這趟已合併到另一趟旅程（填的是新旅程代號）"],
    note: ["備註"],
    updated_by: ["修改者編號"],
    label: ["名稱"],
    start_sec: ["起點（秒）", "從旅程開頭算起"],
    end_sec: ["終點（秒）"],
    layout: ["畫面", "front = 前鏡頭、rear = 後鏡頭、pip = 子母畫面"],
    quality: ["模式", "precise = 精確重編碼、fast = 快速無損"],
    main_cam: ["子母畫面主鏡頭"],
    file_path: ["檔案位置"],
    size_bytes: ["檔案大小"],
    report_json: ["檢舉草稿", "車牌、地點、違規事實等"],
    reported_at: ["已檢舉時間"],
    source_start_epoch: ["片段開始（實際時間）"],
    source_end_epoch: ["片段結束（實際時間）"],
    source_version: ["來源版本"],
    token_hash: ["分享憑證（加密）"],
    created_by: ["建立者編號"],
    revoked_at: ["撤銷時間", "空白 = 仍有效"],
    last_access_at: ["最後觀看時間"],
    access_count: ["觀看次數"],
    share_id: ["分享編號"],
    ciphertext: ["加密內容"],
    profile_key: ["記錄器類型"],
    model: ["型號"],
    nickname: ["暱稱"],
    show_on_trips: ["顯示在旅程上"],
    is_default: ["預設裝置"],
    archived_at: ["封存時間"],
    session_id: ["上傳工作編號"],
    status: ["狀態"],
    file_count: ["檔案數"],
    total_bytes: ["總大小"],
    completed_at: ["完成時間"],
    last_activity: ["最後活動"],
    idle_sec: ["閒置逾時"],
    name: ["檔名"],
    size: ["大小"],
    fingerprint: ["檔案指紋", "用來確認續傳的是同一個檔案"],
    received: ["已收到"],
    complete: ["已完成"],
    auto_process: ["傳完自動整理"],
    gap_min: ["切趟間隔（分）", "停超過這麼久就算下一趟"],
    key: ["設定名稱"],
    value: ["設定值"],
    kind: ["事件類型"],
    severity: ["嚴重程度"],
    trip_label: ["相關旅程"],
    title: ["標題"],
    detail: ["詳細原因"],
    context_json: ["技術資訊"],
    quarantine_dir: ["隔離素材位置", "處理失敗時暫存原始檔的地方"],
    resolved_at: ["處理時間"],
    resolved_by: ["處理者編號"],
    resolution: ["處理方式"],
    type: ["作業類型", "import = 整理上傳、clip = 匯出片段、trim = 裁剪、restore = 還原"],
    target: ["作業對象"],
    payload: ["作業參數"],
    channel_key: ["進度頻道"],
    stage: ["階段"],
    progress: ["進度（%）"],
    message: ["訊息"],
    result: ["結果"],
    job_id: ["作業編號"],
    done: ["已完成數"],
    total: ["總數"],
    entries: ["寫入項目"],
  };

  const date = (row) => (row.date ? String(row.date) : "");
  const T = {
    users: { label: "使用者帳號", desc: "能登入本站的每一個人。密碼只保存加密後的雜湊，無法被還原。",
      title: (r) => r.display_name || r.username, summary: ["username", "role", "email", "created_at"] },
    sessions: { label: "登入狀態", desc: "每次登入都會產生一張「通行證」，到期或登出後失效。這裡可看到誰目前登入中。",
      title: (r) => `使用者 #${r.user_id} 的登入`, summary: ["created_at", "expires_at"] },
    trips: { label: "旅程", desc: "每一趟整理好的行車影片。一趟 ＝ 一次出門，前後鏡頭已合併成完整影片。",
      title: (r) => `${date(r)} 第 ${r.day_order} 趟`, summary: ["start_epoch", "duration_sec", "segment_count", "peak_gforce"] },
    trip_notes: { label: "旅程備註", desc: "使用者在旅程頁寫下的文字備註。", title: (r) => r.trip_id, summary: ["note", "updated_at"] },
    trip_clips: { label: "匯出片段", desc: "從旅程剪出、另存的短片（也包含檢舉草稿）。原旅程不受影響。",
      title: (r) => r.label || `片段 #${r.id}`, summary: ["layout", "duration_sec", "size_bytes", "created_at"] },
    trip_shares: { label: "分享連結", desc: "免登入觀看旅程的限時連結。持有連結的人在到期前都能觀看。",
      title: (r) => `分享 #${r.id}`, summary: ["trip_id", "expires_at", "access_count", "revoked_at"] },
    trip_share_secrets: { label: "分享連結密鑰", desc: "讓擁有者能再次複製分享網址所需的加密資料，內容已加密。",
      title: (r) => `分享 #${r.share_id}`, summary: [] },
    dashcam_devices: { label: "行車記錄器", desc: "使用者登記的記錄器（型號、暱稱）。上傳時會套用對應的檔名格式。",
      title: (r) => r.nickname || r.model, summary: ["model", "user_id", "is_default", "created_at"] },
    upload_sessions: { label: "上傳工作（HTTP）", desc: "每一次從瀏覽器上傳影片所建立的工作。",
      title: (r) => `上傳 ${String(r.session_id).slice(0, 8)}`, summary: ["status", "file_count", "created_at"] },
    sftp_sessions: { label: "上傳工作（含 SFTP 帳密）", desc: "上傳工作的帳號、一次性密碼與來源記錄器。密碼已遮蔽。",
      title: (r) => `上傳 ${String(r.id).slice(0, 8)}`, summary: ["username", "status", "file_count", "total_bytes"] },
    upload_files: { label: "上傳中的檔案", desc: "分塊續傳時暫存的每個檔案進度。上傳完成並整理後就會清掉。",
      title: (r) => r.name, summary: ["size", "received", "complete"] },
    upload_manifests: { label: "上傳設定", desc: "每次上傳選擇的整理方式（是否自動整理、切趟間隔）。",
      title: (r) => `上傳 ${String(r.session_id).slice(0, 8)}`, summary: ["auto_process", "gap_min"] },
    settings: { label: "網站設定", desc: "管理頁可調整的設定，例如網站標題、上傳逾時、檢舉系統網址。",
      title: (r) => r.key, summary: ["value", "updated_at"] },
    incidents: { label: "處理事件", desc: "影片整理失敗或需要人工處理的紀錄，可在「事件與善後」分頁處理。",
      title: (r) => r.title, summary: ["kind", "severity", "status", "created_at"] },
    background_jobs: { label: "背景作業", desc: "整理上傳、匯出片段、裁剪等在背景執行的工作與最後結果。",
      title: (r) => ({ import: "整理上傳", clip: "匯出片段", trim: "整趟裁剪", restore: "還原影片" })[r.type] || r.type,
      summary: ["status", "message", "created_at"] },
    background_job_events: { label: "作業處理紀錄", desc: "背景作業執行時每一步的進度訊息（背景作業頁會整理成時間軸）。",
      title: (r) => r.message, summary: ["stage", "job_id", "created_at"] },
    media_commits: { label: "影片寫入紀錄", desc: "替換影片檔時的安全紀錄；若中途斷電可據此復原。正常情況下是空的。",
      title: (r) => `寫入 #${r.id}`, summary: ["trip_id"] },
  };

  const BOOL = /^(has_|is_|show_|must_|trips_public$|auto_process$|complete$)/;
  const TIME = /(_at|_epoch|^last_activity)$/;
  const BYTES = /(_bytes|^size$|^received$)$/;
  const SECS = /(duration_sec|^trim_offset_sec$|^start_sec$|^end_sec$)$/;
  const JSONISH = /(_json|^payload$|^result$|_snapshot$|^entries$|^value$)$/;
  const PATHISH = /(_path|_dir)$/;
  const ENUMS = {
    role: { admin: "管理員", viewer: "一般使用者" },
    status: { active: "進行中", processing: "處理中", done: "已完成", open: "待處理", resolved: "已解決", dismissed: "已忽略",
      queued: "等待執行", running: "處理中", succeeded: "已完成", failed: "失敗", partial: "部分成功", cancelled: "已取消",
      interrupted: "重啟中斷", cancelling: "取消中", closed: "已結束", expired: "已逾時" },
    layout: { front: "前鏡頭", rear: "後鏡頭", pip: "子母畫面" },
    quality: { precise: "精確", fast: "快速無損" },
    severity: { error: "錯誤", warn: "警告", info: "資訊" },
    type: { import: "整理上傳", clip: "匯出片段", trim: "整趟裁剪", restore: "還原影片" },
    main_cam: { front: "前鏡頭", rear: "後鏡頭" },
  };

  // *_epoch 是車機牆鐘(以 UTC 存),與全站一致用 UTC 顯示;其他時間戳記用本機時區。
  function fmtTimeValue(v, wallClock = false) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n > 1e12 ? n : n * 1000;
    return new Date(ms).toLocaleString("zh-TW", { hour12: false, ...(wallClock ? { timeZone: "UTC" } : {}) });
  }
  function fmtBytesValue(b) {
    const n = Number(b) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + " KB";
    return n + " B";
  }
  function fmtSecsValue(v) {
    const s = Math.round(Number(v) || 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h} 小時 ${m} 分` : m ? `${m} 分 ${r} 秒` : `${r} 秒`;
  }

  /** 把一個欄位值轉成好讀的文字;回傳 { text, pre? }。 */
  function format(table, col, value) {
    if (value === null || value === undefined || value === "") return { text: "—", empty: true };
    const s = String(value);
    if (s === "••• redacted") return { text: "（已隱藏）" };
    if (ENUMS[col] && ENUMS[col][s]) return { text: `${ENUMS[col][s]}` };
    if (table === "trips" && col === "public_override") return { text: Number(value) ? "公開" : "不公開" };
    if (BOOL.test(col) && (s === "0" || s === "1")) return { text: s === "1" ? "是" : "否" };
    if (TIME.test(col)) { const t = fmtTimeValue(value, col.endsWith("_epoch")); if (t) return { text: t }; }
    if (col === "created_at" || col === "updated_at") { const t = fmtTimeValue(value); if (t) return { text: t }; }
    if (BYTES.test(col) && /^\d+$/.test(s)) return { text: fmtBytesValue(value) };
    if (SECS.test(col) && /^[\d.]+$/.test(s)) return { text: fmtSecsValue(value) };
    if (col === "peak_gforce") return { text: Number(value).toFixed(2) + " g" };
    if (col === "progress") return { text: Math.round(Number(value)) + "%" };
    if (col === "idle_sec" || col === "upload_idle_sec") return { text: fmtSecsValue(value) };
    if (col === "value") {
      try { const v = JSON.parse(s); if (typeof v !== "object" || v === null) return { text: String(v) === "" ? "（空白）" : String(v) }; } catch {}
    }
    if (JSONISH.test(col) && /^[[{]/.test(s.trim())) {
      try {
        const obj = JSON.parse(s);
        const keys = Array.isArray(obj) ? obj.length : Object.keys(obj).length;
        return { text: Array.isArray(obj) ? `${keys} 筆項目` : keys ? `${keys} 個欄位` : "（空）", pre: JSON.stringify(obj, null, 2) };
      } catch { /* 非 JSON,照原樣 */ }
    }
    if (PATHISH.test(col)) return { text: s.split("/").filter(Boolean).slice(-2).join("/"), full: s };
    return { text: s };
  }

  function column(col) {
    const c = C[col];
    return { label: c ? c[0] : col, why: c ? c[1] || "" : "" };
  }
  function table(name) {
    return T[name] || { label: name, desc: "", title: (r) => r.id ?? Object.values(r)[0], summary: [] };
  }
  window.DbGlossary = Object.freeze({ table, column, format });
})();
