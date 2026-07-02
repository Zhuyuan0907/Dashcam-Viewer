/**
 * 設定儲存層:settings KV 表(記憶體 write-through 快取)+ 可編輯字串檔。
 *
 * 讀取層級:DB 值 > SETTINGS_DEFAULTS > (運作參數再 fallback 到 config.ts 常數,已內含於 defaults)。
 * 仿 SftpSessionManager:建構時從 DB rehydrate,寫入即更新記憶體。
 */
import fs from "node:fs";
import YAML from "yaml";
import type { DB } from "../db.js";
import { STRINGS_PATH } from "../config.js";
import { SETTINGS_DEFAULTS, type SettingsKey, type SettingsShape } from "./defaults.js";
import { STRINGS_DEFAULT } from "./strings.default.js";

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export class SettingsStore {
  private readonly mem = new Map<string, unknown>();
  private stringsCache: Record<string, string> | null = null;

  constructor(private readonly db: DB) {
    const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{
      key: string;
      value: string;
    }>;
    for (const r of rows) {
      try {
        this.mem.set(r.key, JSON.parse(r.value));
      } catch {
        /* 略過損壞的列 */
      }
    }
  }

  /** 取單一鍵:DB > 預設。 */
  get<K extends SettingsKey>(key: K): SettingsShape[K] {
    if (this.mem.has(key)) return this.mem.get(key) as SettingsShape[K];
    return SETTINGS_DEFAULTS[key];
  }

  /** 合併視圖(預設疊上已存值),供管理表單。 */
  getAll(): SettingsShape {
    const out = { ...SETTINGS_DEFAULTS } as Record<string, unknown>;
    for (const [k, v] of this.mem) out[k] = v;
    return out as SettingsShape;
  }

  /** 寫單一鍵(write-through)。 */
  set(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) " +
          "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      )
      .run(key, JSON.stringify(value), now());
    this.mem.set(key, value);
  }

  /** 交易式批次寫入(供表單 PUT)。 */
  setMany(obj: Record<string, unknown>): void {
    const tx = this.db.transaction((entries: [string, unknown][]) => {
      for (const [k, v] of entries) this.set(k, v);
    });
    tx(Object.entries(obj));
  }

  // ── 運作參數型別存取器(預設已 fallback 到 config 常數) ──
  sftpPublicHost(): string {
    return this.get("sftp_public_host");
  }
  sftpPort(): number {
    return this.get("sftp_port");
  }
  uploadIdleSec(): number {
    return this.get("upload_session_idle_sec");
  }
  defaultGapMin(): number {
    return this.get("default_gap_min");
  }
  quarantineRetentionDays(): number {
    return this.get("quarantine_retention_days");
  }

  // ── 字串檔(YAML,可直接編輯,改後重啟即生效) ──
  /** 讀取並深合併字串(預設疊在底層,避免部分編輯出現 undefined)。 */
  readStrings(): Record<string, string> {
    if (this.stringsCache) return this.stringsCache;
    let fileObj: Record<string, string> = {};
    try {
      const raw = fs.readFileSync(STRINGS_PATH, "utf8");
      const parsed = YAML.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string") fileObj[k] = v;
        }
      }
    } catch {
      /* 檔案不存在或損壞 → 僅用預設,並嘗試種子 */
      this.seedStringsIfMissing();
    }
    this.stringsCache = { ...STRINGS_DEFAULT, ...fileObj };
    return this.stringsCache;
  }

  private seedStringsIfMissing(): void {
    try {
      if (!fs.existsSync(STRINGS_PATH)) {
        const header =
          "# UI 介面字串(繁體中文)。直接編輯本檔後重啟服務即生效。\n" +
          "# 帶 {name} 的值會被程式內插,請保留。\n\n";
        fs.writeFileSync(STRINGS_PATH, header + YAML.stringify(STRINGS_DEFAULT), "utf8");
      }
    } catch {
      /* 種子失敗不致命 */
    }
  }
}

/**
 * 公開 config(GET /api/config),不含任何機密。
 * 注意:UI 字串(ui)已不再由此端點外送 —— 改由伺服器在出頁時注入(見 routes/pages.ts),
 * 避免 admin/ops 介面字串洩露給未登入者。
 */
export function buildPublicConfig(store: SettingsStore): Record<string, unknown> {
  const s = store.getAll();
  return {
    brand: {
      title: s.site_title,
      iconDataUrl: s.icon_data_url,
      faviconDataUrl: s.favicon_data_url,
      footerText: s.footer_text,
      loginTagline: s.login_tagline,
      loginBg: s.login_bg,
      links: s.links,
    },
    behavior: {
      locale: s.locale,
      units: s.units,
      itemsPerPage: s.items_per_page,
      defaultCamera: s.default_camera,
    },
    defaults: {
      gapMin: store.defaultGapMin(),
    },
    titleTemplate: "{page} — {brand}",
  };
}
