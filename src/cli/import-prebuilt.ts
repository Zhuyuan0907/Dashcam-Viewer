#!/usr/bin/env node
/**
 * CLI:把已整理的旅程資料夾匯入 dashcam(與伺服器共用 trips/prebuilt 邏輯)。
 *
 * 資料夾結構(可巢狀,會遞迴尋找日期夾):
 *   <來源>/.../YYYY-MM-DD/HH.MM-HH.MM (N分)/{前鏡頭.mp4, 後鏡頭.mp4, 資訊.txt}
 *
 * 用法:
 *   npm run import -- <來源資料夾>            複製匯入
 *   npm run import -- <來源資料夾> --move      搬移而非複製
 *   npm run import -- <來源資料夾> --dry-run   只預覽
 */
import fs from "node:fs/promises";
import { TRIPS_DIR } from "../config.js";
import { getDb, ensureDataDirs } from "../db.js";
import { importPrebuiltTrips } from "../trips/prebuilt.js";
import { upsertTrip, type TripInfo } from "../trips/repo.js";
import path from "node:path";

function tripDirOf(info: TripInfo): string | null {
  const p = info.front_path ?? info.rear_path;
  return p ? path.dirname(p) : null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const move = args.includes("--move");
  const dryRun = args.includes("--dry-run");
  const paths = args.filter((a) => !a.startsWith("--"));

  if (paths.length === 0) {
    console.log("用法: npm run import -- <來源資料夾> [--move] [--dry-run]");
    process.exit(1);
  }
  const src = path.resolve(paths[0]!);
  try {
    if (!(await fs.stat(src)).isDirectory()) throw new Error();
  } catch {
    console.error(`找不到資料夾: ${src}`);
    process.exit(1);
  }

  console.log(`來源: ${src}`);
  console.log(`模式: ${dryRun ? "預覽" : move ? "搬移" : "複製"}`);

  ensureDataDirs();
  const db = dryRun ? null : getDb();

  let imported = 0;
  let skipped = 0;
  for await (const ev of importPrebuiltTrips(src, {
    tripsDir: TRIPS_DIR,
    mode: move ? "move" : "copy",
    recursive: true,
    dryRun,
  })) {
    if (ev.tripInfo) {
      imported++;
      if (db) upsertTrip(db, ev.tripInfo, tripDirOf(ev.tripInfo));
      console.log(`  ✓ ${ev.message}`);
    } else if (ev.message.startsWith("略過")) {
      skipped++;
      console.log(`  － ${ev.message}`);
    } else if (ev.message.startsWith("×")) {
      console.log(`  ${ev.message}`);
    }
  }

  if (db) db.close();
  console.log(`\n完成:${dryRun ? "預覽" : move ? "搬移" : "匯入"} ${imported} 趟,略過 ${skipped} 個`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
