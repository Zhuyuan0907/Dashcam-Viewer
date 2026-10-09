# Dashcam Viewer

開源、自架的行車記錄器影片管理系統。把記憶卡裡零碎的影片上傳後，自動依「日期／趟次」
無損合併成完整旅程，在網頁上同步觀看前後雙鏡頭，再剪出片段、限時分享，或備份到 YouTube
釋放硬碟空間。資料都在你自己的主機上，不需要任何雲端帳號。

Node.js 22+ · Fastify · TypeScript · SQLite · FFmpeg · 原生 HTML/CSS/JS · MIT

## 主要功能

| | |
| --- | --- |
| **上傳與整理** | 瀏覽器拖放（分塊續傳，可關頁）或 SFTP；自動切趟、無損合併前後鏡頭，背景執行 |
| **觀看** | 雙鏡頭子母畫面、切換主鏡頭、縮放平移、逐格、變速、截圖、時光機瀏覽、續看記憶 |
| **剪輯** | 時間軸選取區間，匯出獨立片段（前／後／子母畫面），或永久裁短整趟（可還原） |
| **分享與檢舉** | 免登入限時分享連結；片段一鍵產生檢舉文字與違規時間 |
| **YouTube 備份** | 三步驟上傳（選影片、標題與隱私、確認），每日上限平均分散上傳；前後鏡頭自動配成播放清單；同步 YouTube 即時狀態；確認後清理本機 |
| **維運** | 失敗事件善後、旅程健康檢查、儲存空間回收、唯讀資料庫檢視、自動 DB 快照 |
| **多使用者** | 帳號角色、每人多台記錄器、旅程預設私人、可個別公開 |

支援 MiVue MP20、Polaroid MS279WG，以及通用命名格式（`20260912_103045_F.mp4`）。
詳見 [使用說明 › 支援的影片格式](docs/USER_GUIDE.md#支援的影片格式)。

## 快速開始

### Docker Compose（建議）

```bash
git clone https://github.com/Zhuyuan0907/Dashcam-Viewer.git
cd Dashcam-Viewer
cp .env.example .env
docker compose up -d --build
```

開啟 <http://localhost:8080/setup> 建立第一個帳號（站台擁有者）。

> **不要執行 `docker compose down -v`**，它會刪除存放所有影片的資料 volume。

### 原生安裝

需要 Node.js 22+ 與 FFmpeg（含 FFprobe）。

```bash
npm ci
cp .env.example .env     # 至少設定 DASHCAM_DATA_DIR
npm run build
npm start
```

完整步驟、HTTPS、SFTP 與所有環境變數見 [安裝與設定](docs/INSTALL.md)。

## 文件

| 文件 | 給誰看 | 內容 |
| --- | --- | --- |
| [使用說明](docs/USER_GUIDE.md) | 所有使用者 | 上傳、觀看、剪輯、分享、檢舉、YouTube 備份、常見問題 |
| [管理員手冊](docs/ADMIN_GUIDE.md) | 管理員 | 使用者與角色、外觀品牌、維運頁、儲存空間、YouTube 授權設定 |
| [安裝與設定](docs/INSTALL.md) | 部署者 | Docker／原生安裝、反向代理、環境變數一覽 |
| [維運與災難復原](docs/OPERATIONS.md) | 部署者 | 健康檢查、完整備份、還原演練、升級回退 |
| [開發指南](docs/DEVELOPMENT.md) | 開發者 | 專案結構、測試、前端慣例、提交流程 |
| [更新紀錄](CHANGELOG.md) | 所有人 | 各版本變更 |

## 授權

[MIT](LICENSE)。歡迎回報可重現的問題，或提交支援新記錄器格式的 Pull Request，
請先閱讀 [CONTRIBUTING.md](CONTRIBUTING.md)。
