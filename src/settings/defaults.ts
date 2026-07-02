/**
 * 設定預設值(來源真相)。
 *
 * 層級:DB settings 表 > 此處 SETTINGS_DEFAULTS > (運作參數再 fallback 到 config.ts env 常數)。
 * 全部放在 src/ 下才會編進 dist/。strings 的預設另見 strings.default.ts。
 */
import {
  SFTP_PUBLIC_HOST,
  SFTP_PORT,
  UPLOAD_SESSION_IDLE_SEC,
} from "../config.js";

export interface BrandLink {
  label: string;
  href: string;
}

/** 所有可由管理頁設定的純量鍵與其預設值。空字串/空陣列代表「沿用內建外觀」。 */
export const SETTINGS_DEFAULTS = {
  // ── 品牌 ──
  site_title: "行車記錄",
  footer_text: "",
  login_tagline: "",
  icon_data_url: "", // 空 → 沿用內建 SVG 標記
  favicon_data_url: "",
  login_bg: "", // 空 → 沿用內建;可為 CSS 色值或 data-URL

  // ── 介面行為 ──
  locale: "zh-TW",
  units: "km" as "km" | "mi",
  items_per_page: 12,
  default_camera: "front" as "front" | "rear",

  // ── 運作參數(fallback 到 config.ts env 常數) ──
  sftp_public_host: SFTP_PUBLIC_HOST,
  sftp_port: SFTP_PORT,
  upload_session_idle_sec: UPLOAD_SESSION_IDLE_SEC,
  default_gap_min: 15,
  /** 處理失敗時隔離保留原始素材的天數,逾期由背景 sweep 自動清理。 */
  quarantine_retention_days: 7,

  // ── 自訂連結(頁尾) ──
  links: [] as BrandLink[],
};

export type SettingsKey = keyof typeof SETTINGS_DEFAULTS;
export type SettingsShape = typeof SETTINGS_DEFAULTS;
