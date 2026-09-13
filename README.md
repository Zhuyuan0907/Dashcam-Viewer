# Dashcam Viewer

開源自架的行車記錄器影片管理系統：把記憶卡素材上傳、整理成旅程、同步檢視雙鏡頭，
再匯出片段或建立限時分享。每個部署者管理自己的帳號、影片與儲存空間，無需外部雲端帳號。

Node.js 22+ · Fastify · TypeScript · SQLite · FFmpeg · 原生 HTML/CSS/JS · MIT

## 快速開始

### Docker Compose

```bash
git clone https://github.com/Zhuyuan0907/Dashcam-Viewer.git
cd Dashcam-Viewer
cp .env.example .env
docker compose up -d --build
```

開啟 http://localhost:8080/setup 建立擁有者，再由管理員建立使用者。
預設只開放 localhost、SFTP 關閉。遠端主機可先透過 SSH tunnel 初始化；
需要內網存取時才修改 `DASHCAM_BIND_IP`。不要將未初始化的站台暴露公網。

資料放在持久化 `dashcam-data` volume，容器內固定 `/data`；更新容器不等於刪除資料。
**不要執行 `docker compose down -v`，它會刪除資料 volume。**

### 原生部署

安裝 Node.js 22+、FFmpeg（含 FFprobe）；若啟用 SFTP 另需 OpenSSH 的 ssh-keygen。
better-sqlite3 若無對應預編譯套件，需 Python 3、make、C++ 編譯器。

```bash
npm ci
cp .env.example .env
npm run build
npm start
```

`npm start`、`npm run doctor`、`npm run backup` 會讀取 .env。
預設資料是專案內 `data/`；正式部署請指定可寫入的絕對路徑。
systemd 範例見 [dashcam.service.example](dashcam.service.example)。

**舊版升級：** 若以前使用 `/mnt/data/dashcam`，請在升級前把原路徑明確寫入
`DASHCAM_DATA_DIR`，並先停機備份。不要把新站初始化誤認為原資料遺失。

## 功能與使用流程

1. 在帳號頁新增行車記錄器，建立上傳工作階段並確認來源裝置。
2. 拖入檔案／資料夾。瀏覽器以 4 MiB 分塊續傳；預設整批收齊後自動整理。
3. 到「背景作業」看排隊、執行、完成／部分成功／失敗狀態、取消、重試及結果。
4. 瀏覽旅程，播放雙鏡頭、縮放平移、逐格、截圖、變速及限時分享。
5. 在剪輯工作區選取範圍，匯出獨立片段；需要縮短整趟時才使用裁剪。
6. 片段頁可搜尋名稱／日期、分頁、重新命名、播放、下載及準備檢舉資料草稿。

一般使用者管理自己的裝置與素材；管理員具站台維運權限。旅程預設非公開。
已登入者的公開瀏覽與免登入 bearer 分享是兩個不同功能。

### 大檔上傳後，可以關閉瀏覽器嗎？

**伺服器顯示整批已接受處理後，可以。仍在傳輸中，不可以。**

上傳前先登記整批檔案，最後一塊完整落地且整批收齊後，伺服器才自動接手。
取消勾選自動整理時，要手動按「確認並處理」。工作排隊或編碼不依賴原本網頁持續開啟。

中途關頁可重新開啟上傳頁、選回同一批檔案，從已確認的位置續傳。分塊工作階段至少保留
24 小時，逾期仍可能回收。來源用檔案大小、修改時間與首尾樣本識別；
HTTPS／localhost 另用逐塊 SHA-256 校驗，樣本不是全檔密碼學身分保證。
請勿在續傳期間修改來源檔。SFTP 與分塊上傳需使用不同工作階段。

SFTP 需先傳完並斷開 SFTP 連線，再回網頁確認；系統不以閒置時間猜測整批完成。
服務重啟與關閉瀏覽器不同：未完成背景工作會標示「中斷」，需人工重試，
不是從中斷影格續編碼。隔離素材的失敗匯入由管理員在維運頁處理。

### 支援素材

| 格式 | 命名範例 | 鏡頭 |
| --- | --- | --- |
| MiVue MP20 | `FILE260912-103045-001F.mp4`，也接受 EMER、F.NMEA | F 前／R 後 |
| Polaroid MS279WG | `2026_0912_103045_001A.TS` | A 前／B 後 |
| 通用交換格式 | `20260912_103045_F.mp4`、`20260912_103045_R_02.mov`（亦接受 TS） | F 前／R 後 |
| 已整理旅程 | `YYYY-MM-DD/旅程資料夾/前鏡頭.mp4`、`後鏡頭.mp4` | 依檔名 |

以上原始格式可只匯入後鏡頭。通用格式選「其他 / 自訂」裝置；
拍攝時間由檔名明確指定，不用檔案上傳時間猜測，也不宣稱支援所有廠牌的私有格式。
同一工作階段不要混合不同命名規則。

合併前檢查編碼、解析度、平均幀率與是否含音軌，不相容素材要求分批／預先轉檔。
HEVC 等來源能否在瀏覽器播放仍取決於瀏覽器及裝置，尚無自動代理轉碼。
檔名時間以牆鐘方式保存；舊素材未知的錄影空檔或錯誤時鐘無法自動還原。

### 剪輯安全與限制

- 匯出是非破壞性的獨立檔案；整趟裁剪可從保留的原始備份還原。
- 裁剪／還原使用檔案提交日誌，失敗回復上一版；啟動時處理中斷提交。
- 同趟的編輯、匯出與刪除有互斥保護，提交期間不接受取消。
- 數字入／出點支援小數秒、键盤把手、1–8 倍時間軸及帳號／鏡頭／版本隔離的本機草稿。
- 精確匯出仍受實際影格邊界限制；逐格用平均幀率，VFR 是近似，探測失敗退回 30 fps。
- 快速匯出可能包含選取外的關鍵影格區間。下載前預覽實際輸出，不能把它當精準證據裁切。
- 新片段保存選取區間的拍攝時間快照與實際輸出長度；舊片段時間無法證明時標示待確認。
- 新整理素材有每鏡頭時間對照，缺片時隱藏缺失鏡頭。跨錄影空檔或未對齊雙鏡頭合成會拒絕。
- 檢舉資料本機草稿須按儲存才同步伺服器；本系統不代替所在地機關的證據規範。

## 弱網播放

旅程頁、剪輯預覽與分享頁共用雙鏡頭緩衝控制。任何必要鏡頭資料不足時，兩個畫面
會一起等待並顯示提示，準備好後再一起播放；緩衝期間手動暫停不會被自動恢復。
素材本身缺少鏡頭的時段會隱藏該鏡頭，不列入等待。這避免一支播放、一支停住，
但不會降低原始影片所需頻寬：慢速網路仍可能停頓，本版尚無自動畫質降級。

## 共用主題系統

預設「港灣」：透明霧面頁首、墨綠重點色搭配暖霧內容，不再只以亮／暗二分。
帳號頁另可選「陶土」「暮山」。三者共用元件，以語意色彩變數切換，不複製多套頁面。
`static/themes.css` 定義色票，`static/themes.js` 定義名稱與舊偏好的相容轉換。
頁首在捲動後仍維持透明；輸入框、下拉選單及剪輯選項共用柔和色底，避免原生白色底塊。
新增文字／數值欄位請使用 `.form-input`，下拉選單再加 `.form-select`；
欄位色彩由 `--field-bg`、`--field-ink`、`--field-border` 控制，保留鍵盤焦點與停用狀態。
頁面使用帶版本的主題樣式網址；修改 `themes.css` 時請同步更新所有 HTML 引用的 `?v=`，
避免瀏覽器／反向代理的舊快取讓部署後的外觀沒有更新。
使用本機系統字型，無第三方字型請求。手機可直接開啟剪輯工作區。

## 設定

原生預設與 Compose 的保守配置可能不同；完整範例見 [.env.example](.env.example)。

| 變數 | 原生預設 | 用途 |
| --- | --- | --- |
| `DASHCAM_DATA_DIR` | 專案 `data/` | SQLite、影片、金鑰與工作狀態 |
| `DASHCAM_HOST` / `DASHCAM_PORT` | `0.0.0.0` / `8080` | 原生監聽位址；範例限制 localhost |
| `DASHCAM_COOKIE_SECURE` | production 為 true | 公開 HTTPS 請設 true |
| `DASHCAM_TRUST_PROXY` | false | 僅在可信反代後方開啟 |
| `DASHCAM_SFTP_ENABLED` / `DASHCAM_SFTP_PORT` | true / 2022 | 範例與 Compose 預設關閉 SFTP |
| `DASHCAM_SFTP_PUBLIC_HOST` | localhost | 提供給使用者的連線主機 |
| `DASHCAM_JOB_CONCURRENCY` / `DASHCAM_JOBS_PER_USER` | 2 / 1 | 全站／每人背景併發 |
| `DASHCAM_TRIM_THREADS` | 核心數一半、至少 1 | 編碼執行緒；小主機建議 2 |
| `DASHCAM_MAX_SESSION_BYTES` | 0（不限） | 範例限制 50 GiB |
| `DASHCAM_MIN_FREE_DISK_BYTES` | 512 MiB | 安全磁碟保留量 |
| `DASHCAM_CLIP_MAX_SEC` | 1200 | 每段匯出上限 |
| `DASHCAM_BACKUP_KEEP` | 7 | SQLite 快照保留份數（非完整影片備份） |

## 維運與備份

[維運手冊](docs/OPERATIONS.md) 包含 HTTPS 反代、容量、健康檢查、完整備份、雜湊驗證、
還原演練與升級回退。資料庫自動快照**不包含影片與金鑰**，不能代替完整離線備份。

```bash
npm run doctor
npm run backup -- create /srv/backups/dashcam-2026-09-12 --server-stopped
npm run backup -- verify /srv/backups/dashcam-2026-09-12
```

建立／還原前必須先停止服務與其他寫入者；確認旗標不會替你停止服務。
本版適用單一服務程序與本機磁碟，尚不支援多副本共用 SQLite 或網路檔案系統。

## 開發與測試

```bash
npm run typecheck
npm run build
npm run format:check
npm test
npx playwright install chromium
npm run test:ui
```

測試使用獨立暫存資料與合成影片，不操作部署者的真實素材。
原生 UI 無額外前端建置；`npm run dev` 可熱重載後端（環境變數請由 shell 注入）。
已整理旅程 CLI：`npm run import -- <來源目錄> --dry-run`，確認後移除 dry-run；
`--move` 會搬走來源，請謹慎使用。

七階段實作與驗證紀錄見 [IMPLEMENTATION.md](docs/IMPLEMENTATION.md)，
升級摘要見 [CHANGELOG.md](CHANGELOG.md)，協作規範見 [CONTRIBUTING.md](CONTRIBUTING.md)。
GitHub Actions 的 [Verify 工作流程](https://github.com/Zhuyuan0907/Dashcam-Viewer/actions/workflows/verify.yml) 會驗證測試與 Compose 啟動；
瀏覽器測試同時載入多支影片，建議在有足夠剩餘記憶體的開發機執行。
Python 舊版留在 `legacy-python/` 供歷史參考，不再作為目前伺服器入口。
此工作區沒有 Docker，容器建置需於具有 Docker 的環境另行驗證。

本維護者的後續實作流程記錄於 [AGENTS.md](AGENTS.md)：測試、commit、push 後，
還必須部署並重新載入正式網站驗證；單純推送程式碼不代表網站已更新。

## 授權

[MIT](LICENSE)。歡迎提交可重現問題、測試與支援新記錄器格式的 Pull Request。
