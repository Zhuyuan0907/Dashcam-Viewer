/**
 * 集中設定 — 全部可由環境變數覆寫,公開部署者不必硬綁 /mnt/data。
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 專案根目錄(dist/ 或 src/ 的上一層)。 */
export const BASE_DIR = path.resolve(__dirname, "..");

/**
 * 影片與資料庫的根目錄。
 * 預設為專案下的 ./data(相對於 BASE_DIR,不綁定任何掛載碟);
 * 正式部署時用環境變數 DASHCAM_DATA_DIR 指向實際資料碟,例如 /mnt/data/dashcam。
 */
export const DATA_DIR = (() => {
  const v = process.env.DASHCAM_DATA_DIR;
  if (v !== undefined && v !== "") return path.resolve(v);
  return path.join(BASE_DIR, "data");
})();

export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const TRIPS_DIR = path.join(DATA_DIR, "trips");
export const DB_PATH = path.join(DATA_DIR, "dashcam.db");
/** 已整理旅程的上傳暫存區(uploads/prebuilt)。 */
export const PREBUILT_DIR = path.join(UPLOAD_DIR, "prebuilt");
/** 處理失敗時隔離保留原始素材的根目錄(供管理員事後重試)。 */
export const QUARANTINE_DIR = path.join(DATA_DIR, "quarantine");

/** 可直接編輯的 UI 字串檔(YAML,執行期資料,非編譯資產;改後重啟即生效)。 */
export const STRINGS_PATH = path.join(DATA_DIR, "strings.yml");
/** 品牌 icon/favicon 的 data-URL 解碼後位元組上限(遠低於 1MB bodyLimit)。 */
export const ICON_MAX_BYTES = envInt("DASHCAM_ICON_MAX_BYTES", 256 * 1024);

/** 靜態前端目錄(原封不動沿用)。 */
export const STATIC_DIR = path.join(BASE_DIR, "static");

export const PORT = envInt("DASHCAM_PORT", 8080);
export const HOST = env("DASHCAM_HOST", "0.0.0.0");

/** Session 有效期(秒),預設 30 天。 */
export const SESSION_TTL = envInt("DASHCAM_SESSION_TTL", 30 * 86_400);

/**
 * 上傳閒置回收門檻(秒)。只有在「沒有任何進行中請求」且閒置超過此值時才清理。
 * 預設 900s(15 分),遠高於單一大檔的上傳時間,避免誤刪進行中的上傳。
 */
export const UPLOAD_STALE_SEC = envInt("DASHCAM_UPLOAD_STALE_SEC", 900);

/** 回收掃描間隔(秒)。 */
export const UPLOAD_SWEEP_SEC = envInt("DASHCAM_UPLOAD_SWEEP_SEC", 30);

// ── SFTP 上傳工作階段 ────────────────────────────────────────────────────────
/** 是否啟用內嵌 SFTP 上傳伺服器。 */
export const SFTP_ENABLED = env("DASHCAM_SFTP_ENABLED", "true").toLowerCase() !== "false";

/** SFTP 監聽埠(系統 sshd 通常在 22,這裡預設 2022 避開)。 */
export const SFTP_PORT = envInt("DASHCAM_SFTP_PORT", 2022);

/** SFTP 監聽位址。 */
export const SFTP_HOST = env("DASHCAM_SFTP_HOST", "0.0.0.0");

/**
 * 顯示給使用者的對外主機名(連線資訊用,如 sftp://<這個>:2022)。
 * 預設 localhost,正式部署請用 DASHCAM_SFTP_PUBLIC_HOST 設成你的網域或對外 IP。
 */
export const SFTP_PUBLIC_HOST = env("DASHCAM_SFTP_PUBLIC_HOST", "localhost");

/** SFTP host key 路徑(不存在時自動以 ssh-keygen 產生)。 */
export const SFTP_HOST_KEY_PATH = path.join(DATA_DIR, "sftp_host_key");

/**
 * 上傳工作階段閒置回收門檻(秒)。沒有任何 SFTP 連線、且閒置超過此值即刪除資料夾
 * 並讓該 session 失效。預設 600s(10 分)。
 */
export const UPLOAD_SESSION_IDLE_SEC = envInt("DASHCAM_UPLOAD_SESSION_IDLE_SEC", 600);

/**
 * 單檔上傳大小上限(bytes),預設 16 GiB(行車記錄影片可能很大)。
 * 設為 0 表示不限制。
 */
export const MAX_FILE_BYTES = envInt("DASHCAM_MAX_FILE_BYTES", 16 * 1024 * 1024 * 1024);

/** 每次 multipart 請求的檔案數上限。 */
export const MAX_FILES_PER_REQUEST = envInt("DASHCAM_MAX_FILES_PER_REQUEST", 200);

/**
 * Cookie secure 旗標:
 *   "auto"(預設)= 僅在 NODE_ENV=production 時開啟
 *   "true" / "false" = 強制
 * 反向代理走 HTTPS 時建議設 true。
 */
function resolveCookieSecure(): boolean {
  const raw = env("DASHCAM_COOKIE_SECURE", "auto").toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return process.env.NODE_ENV === "production";
}
export const COOKIE_SECURE = resolveCookieSecure();

/** PBKDF2 參數(與舊 Python 版相容,切勿更動,否則既有密碼無法驗證)。 */
export const PBKDF2_ITER = 310_000;
export const PBKDF2_KEYLEN = 32;
export const PBKDF2_DIGEST = "sha256";
export const PBKDF2_SALT_BYTES = 32;

/** 登入速率限制:時間窗(毫秒)內最多嘗試次數。 */
export const LOGIN_RATE_MAX = envInt("DASHCAM_LOGIN_RATE_MAX", 5);
export const LOGIN_RATE_WINDOW_MS = envInt("DASHCAM_LOGIN_RATE_WINDOW_MS", 60_000);

/**
 * 影片裁剪(重編碼)使用的 ffmpeg 執行緒上限。預設為「核心數的一半、至少 1」,
 * 避免長片裁剪把整台機器 CPU 打滿而影響串流/其他請求。設 0 表示不限(交給 ffmpeg 自動)。
 */
export const TRIM_THREADS = (() => {
  const raw = process.env.DASHCAM_TRIM_THREADS;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const cores = (() => {
    try {
      return os.cpus().length;
    } catch {
      return 2;
    }
  })();
  return Math.max(1, Math.floor(cores / 2));
})();
