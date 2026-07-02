import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "settings-"));
process.env.DASHCAM_DATA_DIR = DATA;
process.env.DASHCAM_UPLOAD_SESSION_IDLE_SEC = "600";

const { createDb } = await import("../src/db.js");
const { SettingsStore, buildPublicConfig } = await import("../src/settings/store.js");

let seq = 0;
function store() {
  const db = createDb(path.join(DATA, `s${seq++}.db`));
  return new SettingsStore(db);
}

test("空表時 get 回傳預設值", () => {
  const s = store();
  assert.equal(s.get("site_title"), "行車記錄");
  assert.equal(s.get("units"), "km");
  assert.equal(s.defaultGapMin(), 15);
});

test("運作參數 fallback 到 config 常數", () => {
  const s = store();
  assert.equal(s.uploadIdleSec(), 600, "未設定時用 env/config 預設");
  s.set("upload_session_idle_sec", 120);
  assert.equal(s.uploadIdleSec(), 120, "設定後用 DB 值");
});

test("set/get write-through;getAll 合併", () => {
  const s = store();
  s.set("site_title", "我的行車");
  assert.equal(s.get("site_title"), "我的行車");
  const all = s.getAll();
  assert.equal(all.site_title, "我的行車");
  assert.equal(all.units, "km", "未設定鍵仍回預設");
});

test("setMany 交易批次寫入", () => {
  const s = store();
  s.setMany({ site_title: "我的行車", default_gap_min: 30, units: "mi" });
  assert.equal(s.get("site_title"), "我的行車");
  assert.equal(s.defaultGapMin(), 30);
  assert.equal(s.get("units"), "mi");
});

test("字串:YAML 檔深合併在預設之上", async () => {
  const fs = await import("node:fs");
  const { STRINGS_PATH } = await import("../src/config.js");
  const YAML = (await import("yaml")).default;
  // 寫一個只覆寫單一鍵的 yml,其餘應仍來自預設(深合併)
  fs.writeFileSync(STRINGS_PATH, YAML.stringify({ "nav.home": "Home" }), "utf8");
  const s = store();
  const ui = s.readStrings();
  assert.equal(ui["nav.home"], "Home", "yml 覆寫生效");
  assert.equal(ui["nav.browse"], "瀏覽旅程", "未覆寫鍵仍為預設(深合併)");
  fs.rmSync(STRINGS_PATH, { force: true });
});

test("buildPublicConfig 形狀正確、不含 ui 字串與機密", () => {
  const s = store();
  const cfg = buildPublicConfig(s) as any;
  assert.ok(cfg.brand && cfg.behavior && cfg.defaults);
  assert.equal(cfg.brand.title, "行車記錄");
  assert.equal(typeof cfg.titleTemplate, "string");
  assert.equal(cfg.ui, undefined, "ui 字串不再經此端點外送");
  // 不應出現任何明顯機密鍵
  assert.equal((cfg as any).password, undefined);
});
