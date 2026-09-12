# Dashcam 行車記錄器網頁系統

## 分階段更新：剪輯安全

### 背景作業

### 大檔分塊續傳

瀏覽器會先登記整批檔案，再以 4 MiB 分塊傳送；重開頁面後重新選取同一批檔案即可
從伺服器已確認的位置接續。預設勾選「整批傳完後自動整理」，最後一塊落地、整批收齊後
由伺服器接手；畫面顯示接手成功後就能關頁。未完成上傳仍需保持瀏覽器開啟。
續傳工作階段至少保留 24 小時（管理員原有不限時設定保留）。來源以檔案大小、修改時間與
首尾樣本識別，HTTPS／localhost 另提供逐塊 SHA-256 校驗；樣本識別不作為密碼學完整性保證。
分塊模式與 SFTP 請使用不同工作階段，避免同一檔案被兩種傳輸方式覆寫。
SFTP 仍需傳完、斷開連線後手動確認，不能以閒置時間推測整批完成。
磁碟不足會保留已確認的分塊；影片編輯會預留備份及輸出所需的工作空間。

「背景作業」頁會保存匯入、裁剪與匯出歷史，並提供狀態、取消、重試及結果入口。
檔案完整送達且按下「確認並處理」後，即可關頁；僅上傳完成而未確認不會自動整理。
`DASHCAM_JOB_CONCURRENCY=2` 控制全站同時工作數，`DASHCAM_JOBS_PER_USER=1` 控制每人同時工作數。
待執行工作會排隊；相同參數的進行中匯出會回傳既有工作，避免重複產生片段。
重啟後未完成工作標記「中斷」，可在來源仍存在時重新執行（不是從中斷影格續編碼）。
匯入失敗且素材已隔離時，請管理員由維運頁處理。工作結果以整批收尾完成為準，
不再將個別合併步驟的完成事件誤報為成功。

此版本整合多裝置、片段匯出、匿名限時分享與權限回歸測試。
裁剪／還原採可恢復的檔案提交紀錄：任一鏡頭或資料庫更新失敗會還原上一版，
程序中斷則於啟動時恢復。原始備份不會在還原失敗時被消耗。工作提交期間不可取消；
同趟匯出、裁剪與刪除互斥。裁剪位置保留小數秒，避免連續裁剪產生偏移。

新片段保存選取區間的拍攝時間快照與實際輸出長度；舊片段缺少可靠來源時間時顯示「待確認」。
快速匯出可能包含選取之外的畫面，實際時長以輸出檔為準；它不是原始檔的逐位元組副本。
新整理旅程保存每鏡頭片段時間對照，播放遇到缺片會隱藏缺失鏡頭；
跨錄影空檔的剪輯、未對齊的雙鏡頭合成會提示改為分段／單鏡頭匯出。

升級前請備份完整資料目錄（含 SQLite、影片、分享金鑰和 strings.yml）。首次啟動會自動新增欄位。
舊資料沒有來源片段時間表，不能自動推測其歷史錄影空檔。
實作進度見 [implementation ledger](docs/IMPLEMENTATION.md)。

把行車記錄器產生的細碎影片,依「日期 / 趟次」自動整理、用 ffmpeg 無損合併成完整旅程,並透過網頁瀏覽、縮放檢視前後雙鏡頭。後端 **Node.js + Fastify + TypeScript**,資料庫 **SQLite**,前端為零建置的原生 JS。

> v2 起後端由 Python(FastAPI)改寫為 TypeScript。舊版保留於 `legacy-python/` 供參考。

## 功能

- **上傳(SFTP)**:每個網頁工作階段取得一組一次性 SFTP 連線資訊(如 Pterodactyl 面板),用 FileZilla / WinSCP / `sftp` 把片段直接傳到專屬資料夾,完成後在網頁按「確認並處理」。原始片段(`FILE/EMER…F|R.mp4` + `.NMEA`)與已整理旅程資料夾系統自動判別。閒置過久的工作階段自動回收。
- **整理**:依停留間隔切趟,合併前後鏡頭,解析 NMEA 的 G-force。
- **瀏覽 / 觀看**:雙鏡頭子母畫面、**滾輪縮放 + 拖曳平移**、逐格前進/後退、播放速度、截圖存檔、全螢幕、鍵盤快捷。
- **帳號**:PBKDF2 雜湊、Session cookie、管理員 / 訪客分級。
- **CLI**:`dashcam-import` 從資料夾批次匯入(支援遞迴巢狀日期夾)。

## 需求

- Node.js ≥ 20(建議 LTS)
- `ffmpeg` 與 `ffprobe`(影片合併與時長偵測)
- `ssh-keygen`(首次啟動自動產生 SFTP host key)
- 對外開放 **SFTP 埠 2022**(防火牆 / port forward),使用者才能從外部連入上傳

## 安裝與啟動

```bash
npm install          # 安裝相依(含原生模組 better-sqlite3,需編譯工具)
npm run build        # 編譯 TypeScript → dist/
npm start            # 啟動(預設 http://0.0.0.0:8080)
```

開發模式:`npm run dev`(tsx 熱重載)。首次開啟瀏覽器到 `/setup` 建立管理員帳號。

預設資料存在專案內 `./data`。若要放到獨立資料碟,設定 `DASHCAM_DATA_DIR`(見 `.env.example`)。
常駐部署可參考 `dashcam.service.example`(systemd)。

## 環境變數

| 變數 | 預設 | 說明 |
|------|------|------|
| `DASHCAM_DATA_DIR` | `./data` | 影片與 DB 根目錄(預設專案內 `./data`;正式部署可指向掛載碟,如 `/mnt/data/dashcam`) |
| `DASHCAM_PORT` | `8080` | 監聽埠 |
| `DASHCAM_HOST` | `0.0.0.0` | 監聽位址 |
| `DASHCAM_SESSION_TTL` | `2592000` | Session 有效秒數(30 天) |
| `DASHCAM_COOKIE_SECURE` | `auto` | `auto`/`true`/`false`;反向代理走 HTTPS 時設 `true` |
| `DASHCAM_LOGIN_RATE_MAX` | `5` | 登入速率限制(每視窗次數) |
| `DASHCAM_SFTP_ENABLED` | `true` | 是否啟用內嵌 SFTP 上傳伺服器 |
| `DASHCAM_SFTP_PORT` | `2022` | SFTP 監聽埠(系統 sshd 通常在 22) |
| `DASHCAM_SFTP_HOST` | `0.0.0.0` | SFTP 監聽位址 |
| `DASHCAM_SFTP_PUBLIC_HOST` | `localhost` | 顯示給使用者的對外主機名(部署時設成你的網域或對外 IP) |
| `DASHCAM_UPLOAD_SESSION_IDLE_SEC` | `600` | 上傳工作階段閒置回收門檻(秒,預設 10 分) |

## CLI 批次匯入

```bash
npm run import -- <來源資料夾>            # 複製匯入
npm run import -- <來源資料夾> --move      # 搬移
npm run import -- <來源資料夾> --dry-run   # 只預覽
```

## 測試

```bash
npm test         # node:test:核心邏輯、相容性、安全性回歸
npm run typecheck
```

## SFTP 上傳

1. 網頁 `/upload`(管理員)按「建立上傳工作階段」,取得一次性連線資訊:
   `sftp://<帳號>.<sid>@<host>:2022`,密碼為當次隨機產生(可在頁面複製或下載 FileZilla 站台)。
2. 用 SFTP 客戶端把片段傳入,結構不拘(原始片段或 `YYYY-MM-DD/` 旅程夾皆可)。
3. 回網頁按「確認並處理」,進入既有整理/合併管線(SSE 進度)。
4. 工作階段閒置超過 `DASHCAM_UPLOAD_SESSION_IDLE_SEC`(預設 10 分)會自動刪資料夾並失效。

## 安全性

- SFTP 採內嵌伺服器:一次性密碼以 `timingSafeEqual` 比對,每條連線只開放 SFTP 子系統(拒 shell/exec),所有路徑操作沙箱在該工作階段資料夾內(不可逃逸、不建符號連結)。
- 所有 SQL 走參數化綁定;上傳路徑經 `safeJoin` 防止路徑穿越;登入有速率限制;helmet 安全標頭。
- 發版前請確保 `npm audit` 無 high/critical(專案附 Dependabot 設定每週檢查)。

## 授權

MIT
