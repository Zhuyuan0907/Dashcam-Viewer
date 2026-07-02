/**
 * 一次性時區遷移:把既有 trips 的 start_epoch/end_epoch 從「伺服器本地時區解讀」
 * 轉成「UTC 解讀」的牆鐘 epoch(與修正後的 organizer/prebuilt 一致)。
 *
 * 原本 parseEpoch 用 new Date(本地) 把行車記錄器牆鐘當伺服器本地時區算 epoch。
 * 修正後改 Date.UTC + 前端以 UTC 顯示。此腳本把舊資料一次補正:
 *   新 epoch = Date.UTC(舊 epoch 在伺服器本地時區的 年,月,日,時,分,秒)
 * 必須在「與當初匯入相同時區的伺服器」上執行(本機 Europe/Berlin)。會精準處理 DST。
 *
 * 以 settings 表的 `_tz_migrated` 旗標防止重複執行(重複會二次偏移)。
 * 用法:npm run migrate-tz   (加 --force 可強制再跑,慎用)
 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db.js";

const force = process.argv.includes("--force");

function toUtcWallClock(oldEpoch: number): number {
  const d = new Date(oldEpoch * 1000); // 以伺服器本地時區取出當初的牆鐘分量
  return Math.floor(
    Date.UTC(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      d.getHours(),
      d.getMinutes(),
      d.getSeconds(),
    ) / 1000,
  );
}

const db = getDb();

const done = db.prepare("SELECT value FROM settings WHERE key = '_tz_migrated'").get() as
  | { value: string }
  | undefined;
if (done && !force) {
  console.log("時區遷移先前已執行過(settings._tz_migrated)。如確需重跑請加 --force。");
  process.exit(0);
}

const rows = db
  .prepare("SELECT trip_id, start_epoch, end_epoch, trip_dir FROM trips")
  .all() as Array<{ trip_id: string; start_epoch: number; end_epoch: number; trip_dir: string | null }>;

const upd = db.prepare("UPDATE trips SET start_epoch = ?, end_epoch = ? WHERE trip_id = ?");
let nDb = 0;
let nInfo = 0;

const tx = db.transaction(() => {
  for (const r of rows) {
    const ns = toUtcWallClock(r.start_epoch);
    const ne = toUtcWallClock(r.end_epoch);
    if (ns === r.start_epoch && ne === r.end_epoch) continue;
    upd.run(ns, ne, r.trip_id);
    nDb++;
    if (r.trip_dir) {
      const f = path.join(r.trip_dir, "info.json");
      try {
        const j = JSON.parse(fs.readFileSync(f, "utf-8")) as Record<string, unknown>;
        j.start_epoch = ns;
        j.end_epoch = ne;
        fs.writeFileSync(f, JSON.stringify(j, null, 2));
        nInfo++;
      } catch {
        /* info.json 不存在或損壞,略過 */
      }
    }
  }
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('_tz_migrated', '1', ?)",
  ).run(Math.floor(Date.now() / 1000));
});
tx();

console.log(`時區遷移完成:更新 ${nDb}/${rows.length} 趟(DB)、${nInfo} 個 info.json。`);
process.exit(0);
