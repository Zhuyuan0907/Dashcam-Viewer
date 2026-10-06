# 開發指南

提交規範與審查要點見 [CONTRIBUTING.md](../CONTRIBUTING.md)，歷次實作紀錄見 [IMPLEMENTATION.md](IMPLEMENTATION.md)。

## 技術架構

- **後端**：Node.js 22+、Fastify 5、TypeScript（ESM，相對 import 帶 `.js` 副檔名），編譯到 `dist/`。
- **資料庫**：SQLite（better-sqlite3，同步 API）。結構在啟動時以 `CREATE TABLE IF NOT EXISTS`
  與冪等 `ALTER` 升級，不需要另外跑遷移。
- **影片**：系統 FFmpeg／FFprobe，以子程序執行。旅程合併為無損串接；裁剪與精確匯出才重新編碼。
- **前端**：純 HTML／CSS／JS，**沒有建置步驟**，放在 `static/` 由伺服器直接提供。
  UI 文字在出頁時由 `src/routes/pages.ts` 注入（`data-i18n` 屬性 + `window.__S`）。

## 專案結構

```
src/
  server.ts / app.ts     進入點、Fastify 組裝、啟動時的中斷殘留修復
  config.ts              環境變數 → 常數
  db.ts                  SQLite schema 與升級
  routes/                HTTP API 與頁面（trips、upload、edit、clips、shares、ops、youtube…）
  trips/                 organizer（切趟／合併）、prebuilt（已整理旅程匯入）、repo（旅程 DB 存取）
  uploads/ sftp/         瀏覽器分塊續傳、內建 SFTP、扁平資料夾分流
  dashcams/              各記錄器檔名解析與鏡頭配對
  media/                 FFmpeg 包裝、時間軸、磁碟預留
  youtube/               OAuth、上傳佇列、播放清單配對、狀態同步
  storage/               儲存空間回收、備份打包
  settings/              站台設定與 UI 字串預設
static/                  各頁 HTML + 共用 app.js / style.css / ui.css / themes.css
test/                    *.test.ts（node:test）與 ui-*.spec.ts（Playwright）
docs/                    使用者與部署文件
legacy-python/           舊 FastAPI 版，僅供參考
```

慣例：

- 旅程讀寫集中在 `trips/repo.ts`，片段在 `clips/repo.ts`，不要在 routes 散落 SQL。
- `/api/trips/*` 是 catch-all，其他旅程相關 API 用獨立前綴（`/api/trip-note/*`、`/api/trip-clips/*`…）。
- API 回傳明確的 DTO，不要直接輸出 `SELECT *`。
- 會改動檔案的流程（合併、裁剪、清理）都要能在中斷後安全恢復，並附重啟測試。
- 程式註解與 UI 以繁體中文為主。

## 開發與測試

```bash
npm ci
npm run dev            # tsx 熱重載後端（環境變數請由 shell 提供）
npm run typecheck
npm run build
npm run format:check
npm test               # node:test，單元與 API 測試
npx playwright install chromium
npm run test:ui        # Playwright 瀏覽器測試，自動建立暫存資料與合成影片
```

- 測試一律使用暫存目錄與合成影片，**不要**指向真實的影片資料。
- 小記憶體主機執行瀏覽器測試時加 `DASHCAM_E2E_LOW_MEMORY=1`，且不要和其他重工作同時跑。
- 已整理旅程批次匯入：`npm run import -- <來源目錄> --dry-run`，確認後再移除 `--dry-run`；
  `--move` 會搬走來源。
- GitHub Actions 的 [Verify](https://github.com/Zhuyuan0907/Dashcam-Viewer/actions/workflows/verify.yml)
  會執行建置、格式、單元測試、瀏覽器測試與 Compose 啟動檢查。

## 前端慣例

- 新的文字／數值欄位用 `.form-input`，下拉選單再加 `.form-select`。
- 按鈕：主要動作 `.btn .btn--solid`、次要 `.btn .btn--ghost`、危險 `.btn .btn--danger`。
- 內文中的超連結用沒有 class 的 `<a>`（放在 `p`、`li`、`span` 等文字容器內）或加 `.link`，會自動顯示成可點樣式。
- 主題色票在 `static/themes.css`（港灣／陶土／暮山），元件只用語意變數，不要為各主題複製樣式。
- 修改 CSS／JS 後，請同步更新各 HTML 引用的 `?v=` 版本，避免瀏覽器快取舊檔。
- 經 Prettier 排版的頁面（例如 `youtube.html`）**不要**放 `data-i18n` 屬性：多行標籤會讓出頁時的字串替換出錯。
- 新增可自訂的 UI 字串：在 `src/settings/strings.default.ts` 加鍵，頁面用 `data-i18n` 或 `t()`；
  動態 JS 用到其他命名空間時，要加進 `pages.ts` 的 `PAGE_NS`。

## 版本與提交

- Conventional Commits（`feat(upload): …`、`fix(media): …`、`test: …`）。
- 變更資料庫或持久化檔案格式時，在 PR／CHANGELOG 寫明升級與回退方式。
- 發版前確認 `npm audit` 沒有 high／critical。
