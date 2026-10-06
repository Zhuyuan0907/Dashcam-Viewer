# 安裝與設定

- [系統需求](#系統需求)
- [Docker Compose 安裝](#docker-compose-安裝)
- [原生安裝](#原生安裝)
- [首次設定](#首次設定)
- [對外開放：HTTPS 與反向代理](#對外開放https-與反向代理)
- [SFTP 上傳](#sftp-上傳)
- [環境變數一覽](#環境變數一覽)
- [升級](#升級)

備份、還原與故障處理見 [維運與災難復原](OPERATIONS.md)。

---

## 系統需求

- 建議 2 核心、2–4 GB 記憶體起步；硬碟依影片量而定（雙鏡頭常見每小時數 GB 到 10 GB，依記錄器畫質而異）。
- 單一服務程序 + SQLite + 本機磁碟。**不要**讓多個程序共用同一資料目錄，也不要把資料放在 NFS／SMB。
- 整理影片時需要約等同上傳量的暫存空間。

## Docker Compose 安裝

```bash
git clone https://github.com/Zhuyuan0907/Dashcam-Viewer.git
cd Dashcam-Viewer
cp .env.example .env
docker compose up -d --build
```

- 資料存在 `dashcam-data` volume（容器內 `/data`），更新容器不會刪除資料。
- 預設只監聽本機；要給內網使用時修改 `.env` 的 `DASHCAM_BIND_IP`。
- **不要執行 `docker compose down -v`**，會連資料 volume 一起刪掉。
- 映像以非 root（UID 1000）執行，資料 volume 必須可寫；不要用 `chmod 777` 解決權限問題。

## 原生安裝

需要 Node.js 22+、FFmpeg（含 FFprobe）。啟用 SFTP 需 `ssh-keygen`。
`better-sqlite3` 若沒有對應的預編譯檔，另需 Python 3、make 與 C++ 編譯器。

```bash
npm ci
cp .env.example .env
# 編輯 .env：DASHCAM_DATA_DIR 請設為可寫入的絕對路徑，例如 /srv/dashcam
npm run build
npm start
```

- `npm start`、`npm run doctor`、`npm run backup` 會自動讀取 `.env`。
- 開機自動啟動：參考 [dashcam.service.example](../dashcam.service.example) 建立 systemd 服務。
- `npm run doctor` 可做唯讀環境檢查（FFmpeg、權限、空間）。

## 首次設定

1. 開啟 `http://localhost:8080/setup` 建立第一個帳號，它就是**站台擁有者**。
   遠端主機可先用 SSH tunnel 連到本機埠完成這一步。**不要**在初始化前把 `/setup` 暴露到公網。
2. 到「管理 › 使用者」建立其他帳號（沒有開放註冊）。
3. 到「管理 › 外觀與品牌」設定站名與圖示。
4. 要使用 YouTube 備份時，依 [管理員手冊 › YouTube 授權設定](ADMIN_GUIDE.md#youtube-授權設定) 完成一次性設定。

## 對外開放：HTTPS 與反向代理

- Nginx 範例：[deploy/nginx.conf.example](../deploy/nginx.conf.example)。Cloudflare Tunnel 等也可以。
- 走 HTTPS 時設定 `DASHCAM_COOKIE_SECURE=true`。
- 只有在可信反向代理會覆寫 `X-Forwarded-For` 時才開 `DASHCAM_TRUST_PROXY=true`（影響登入頻率限制）。
- 上傳大檔時，反向代理需允許長時間連線與大請求本文（分塊為 4 MiB）。

## SFTP 上傳

內建 SFTP 伺服器（非系統 sshd），每個上傳工作階段有獨立的一次性帳密與沙箱資料夾。

- `DASHCAM_SFTP_ENABLED=true`，預設埠 2022，需在防火牆／路由器另外開放。HTTP 反向代理無法轉送 SFTP。
- `DASHCAM_SFTP_PUBLIC_HOST` 設為使用者連線用的主機名稱或 IP（顯示在上傳頁）。
- 不使用時保持關閉。

## 環境變數一覽

完整範例見 [.env.example](../.env.example)。

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `DASHCAM_DATA_DIR` | 專案 `data/` | 資料庫、影片、金鑰與工作狀態。正式環境請用絕對路徑 |
| `DASHCAM_HOST` / `DASHCAM_PORT` | `0.0.0.0` / `8080` | 監聽位址與埠 |
| `DASHCAM_BIND_IP` | `127.0.0.1` | （Compose）對外發佈的位址 |
| `DASHCAM_COOKIE_SECURE` | production 為 true | HTTPS 請設 true |
| `DASHCAM_TRUST_PROXY` | false | 僅在可信反向代理後方開啟 |
| `DASHCAM_SESSION_TTL` | 2592000（30 天） | 登入有效秒數 |
| `DASHCAM_LOGIN_RATE_MAX` / `_WINDOW_MS` | 5 / 60000 | 每個 IP 在時間窗內的登入嘗試上限 |
| `DASHCAM_SFTP_ENABLED` / `DASHCAM_SFTP_PORT` | true / 2022 | 內建 SFTP（範例與 Compose 預設關閉） |
| `DASHCAM_SFTP_HOST` / `DASHCAM_SFTP_PUBLIC_HOST` | `0.0.0.0` / localhost | SFTP 綁定位址／顯示給使用者的主機 |
| `DASHCAM_UPLOAD_SESSION_IDLE_SEC` | 600 | SFTP 工作階段閒置失效秒數 |
| `DASHCAM_UPLOAD_STALE_SEC` / `_SWEEP_SEC` | 900 / 30 | 過期上傳判定秒數／清理檢查週期 |
| `DASHCAM_MAX_FILE_BYTES` | 16 GiB | 單檔上限 |
| `DASHCAM_MAX_SESSION_BYTES` | 0（不限） | 單一工作階段總量上限（範例 50 GiB） |
| `DASHCAM_MAX_FILES_PER_REQUEST` | 200 | 單次請求檔案數上限 |
| `DASHCAM_MIN_FREE_DISK_BYTES` | 512 MiB | 磁碟安全保留量，低於此值拒絕寫入 |
| `DASHCAM_JOB_CONCURRENCY` / `DASHCAM_JOBS_PER_USER` | 2 / 1 | 全站／每人同時背景工作數 |
| `DASHCAM_TRIM_THREADS` | 核心數一半 | 編碼執行緒；小主機建議 2 |
| `DASHCAM_CLIP_MAX_SEC` | 1200 | 單一匯出片段最長秒數 |
| `DASHCAM_ICON_MAX_BYTES` | 256 KiB | 站台圖示上傳上限 |
| `DASHCAM_BACKUP_ENABLED` | true | SQLite 自動快照 |
| `DASHCAM_BACKUP_INTERVAL_HOURS` / `DASHCAM_BACKUP_KEEP` | 24 / 7 | 快照間隔與保留份數（**不含影片**） |
| `DASHCAM_SHARE_TOKEN_KEY_PATH` | `DATA_DIR/share_token.key` | 分享連結金鑰位置 |

「管理 › 行為與上傳設定」可覆寫部分顯示用參數（切趟間隔、SFTP 顯示主機／埠、上傳閒置），
但 SFTP 實際綁定的埠只看環境變數。

## 升級

1. 先依 [維運與災難復原](OPERATIONS.md) 停機備份資料庫與金鑰。
2. 取得新版程式 → `npm ci && npm run build`（或 `docker compose up -d --build`）。
3. 重啟服務。資料庫結構會在啟動時自動、冪等地升級。

**從舊版升級：** 以前使用 `/mnt/data/dashcam` 等路徑的，請在升級前把原路徑明確寫進
`DASHCAM_DATA_DIR`。不要把新站的初始化畫面誤認為資料遺失。
