# 自架維運與災難復原

## 部署邊界

本系統採單一 Node.js 程序、SQLite 與本機磁碟。不可讓多個容器／程序共用同一資料目錄，
也不要把 SQLite 放在 NFS／SMB。工作佇列、磁碟預留與媒體鎖目前是單程序協調。
建議以 2 核心、2–4 GB 記憶體起步，先把工作併發設為 1、編碼執行緒設為 2，
再依自己的影片做容量及效能測試；這不是已測得的容量保證。

首次部署只綁 localhost，在 `/setup` 建立站台擁有者後再開放可信內網或 HTTPS。
不要在尚未初始化時把 `/setup` 暴露於公網。一般使用者由管理員建立，無開放註冊。
公開旅程代表站內可見；免登入分享需額外建立限時 bearer 連結，持有連結者即可觀看。
分享連結、車牌、GPS、影片與備份皆應視為敏感資料。

反代範例見 `deploy/nginx.conf.example`。HTTPS 請設定 `DASHCAM_COOKIE_SECURE=true`；
只有可信反代會覆寫 X-Forwarded-For 時才能開啟 `DASHCAM_TRUST_PROXY=true`。
SFTP 使用另一個 TCP 埠，HTTP 反代不能代替它。未使用時維持關閉。

## 健檢

- `/healthz`：公開、只回傳服務與 SQLite 可用性，不輸出路徑、容量或帳號。
- 維運頁「部署環境健檢」：管理員可查看 Node、FFmpeg、FFprobe、目錄權限及剩餘空間。
- `npm run doctor`：原生部署的唯讀檢查。新站尚無資料庫時會明確顯示，不會偷偷建庫。
- Compose：`docker compose logs --tail=100 dashcam`、`docker compose ps`。

Docker 映像使用非 root UID 1000，資料 volume 必須可寫。不要用 chmod 777 解決權限問題。
SQLite 自動快照在 `backups/`，預設每 24 小時、保留 7 份；它不含影片或分享金鑰。

## 完整備份（原生部署）

完整備份是離線操作。先停止 systemd 服務、所有 CLI 匯入工具與其他寫入者，確認 FFmpeg
已退出，再執行。`--server-stopped` 是操作員確認，不是自動停機機制。

```bash
sudo systemctl stop dashcam
npm run backup -- create /srv/backups/dashcam-2026-09-12 --server-stopped
npm run backup -- verify /srv/backups/dashcam-2026-09-12
sudo systemctl start dashcam
```

目的資料夾必須不存在、且位於 `DASHCAM_DATA_DIR` 外。備份包含資料庫、WAL、影片、
上傳續傳狀態、隔離素材、工作歷史、分享金鑰、SFTP host key 與 strings.yml。
每個檔案有 SHA-256 清單，另驗證 SQLite；失敗不會覆寫舊備份，未完成的目錄須人工檢查。
雜湊只能偵測損壞，不是防偽簽章。備份需另行加密並存放於不同磁碟或異地。

自訂 `DASHCAM_SHARE_TOKEN_KEY_PATH` 在資料目錄外時，本工具會拒絕建立完整備份，
避免誤稱已包含金鑰；請停機後把外部金鑰與完整資料目錄另行封存，記錄原本路徑。
不要刪除金鑰：遺失會讓既有分享連結無法重新顯示。

## 還原演練（原生部署）

1. 停止所有寫入者，先驗證備份。保持程式版本與備份對應。
2. 把現有資料目錄**移到另一個保留位置**，不要直接刪除或覆蓋。
3. 在 `.env` 中使用原本的絕對資料路徑。資料庫仍存絕對媒體路徑，因此工具會拒絕改路徑還原。
4. `npm run backup -- restore /srv/backups/dashcam-2026-09-12 --server-stopped`
5. 檢查檔案擁有者，執行 `npm run doctor`，啟動服務。
6. 用管理員登入，抽查一支影片、裁剪還原、既有分享與背景作業；未完成工作標示中斷後人工重試。

工具只還原到不存在的目的目錄，不覆寫目前資料。還原失敗保留現場，先檢查再移開重試。
異機還原也需相同容器／原生資料路徑；任意路徑重定位尚未自動化。

## Compose volume 備份／還原

```bash
docker compose stop dashcam
docker compose cp dashcam:/data ./dashcam-volume-backup
docker compose start dashcam
```

目的目錄使用全新名稱。`compose cp` 是離線 volume 複製，不會自動生成本專案的雜湊清單。
還原前先把現有 `/data` 另外備份，使用全新 volume，將備份內容複製到 `/data`，
確認 UID/GID 1000 與資料內容後啟動。容器內資料路徑固定 `/data`，不要任意改名。
絕對不要使用 `docker compose down -v` 當作更新指令，它會刪除影片 volume。

## 升級與失敗處理

1. 完整停機備份，記下目前 commit：`git rev-parse HEAD`。
2. `git pull --ff-only`；原生執行 `npm ci && npm run build`，Compose 執行 `docker compose build`。
3. 啟動，檢查 `/healthz` 與維運頁。新增欄位自動遷移；不要只降版程式卻沿用新資料庫。
4. 必須回退時，用舊 commit 加上升級前完整備份還原。

早期版本預設使用 `/mnt/data/dashcam`；本版預設是專案的 `data/`。
升級前務必在 `.env` 明確設定**原本的資料目錄**，避免看到空的新站而誤以為資料遺失。
舊的 `DASHCAM_CLIP_CONCURRENCY` 已由 `DASHCAM_JOB_CONCURRENCY` 與
`DASHCAM_JOBS_PER_USER` 取代，會一起限制匯入、裁剪及匯出。
自訂 `strings.yml` 不會被預設字串覆蓋；若舊版檢舉提示推薦快速模式，請同步改成
「保留原始素材並核對輸出；快速模式可能包含選取範圍外影格」。

瀏覽器重開：續傳需重新選取相同檔案；上傳尚未完整送達時不能關頁。
服務重啟：已接受但未完成的工作標示「中斷」，不承諾從同一影格續編碼。
磁碟不足：釋放空間後重試，切勿手動刪除 `.orig`、rollback 或 `media_commits` 紀錄。
匯入失敗：先到維運事件檢查隔離素材，不要在確認資料完整前清空事件或隔離目錄。

目前 Docker 建置需由有 Docker 的環境／CI 驗證；此開發工作區沒有 Docker daemon。
