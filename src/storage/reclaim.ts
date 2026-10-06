/**
 * 儲存空間回收：找出「佔空間但介面看不到」的影片，由管理員逐項確認後刪除。
 *
 *   superseded   已被合併旅程取代的來源旅程（瀏覽頁已隱藏，但影片仍在磁碟）
 *   orphan_dir   舊版中斷合併留下、沒有 info.json 也沒有 DB 紀錄的旅程夾
 *   unregistered 有 info.json 但 DB 沒有紀錄（可用「從磁碟重建」救回，不提供刪除）
 *
 * 刪除時一律重新掃描、以伺服器端計算的 id 對應，不信任用戶端傳來的路徑。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Database as DB } from "better-sqlite3";
import { DATA_DIR, TRIPS_DIR } from "../config.js";
import { withinTrips } from "../util/paths.js";
import { deleteTrip, getTrip } from "../trips/repo.js";
import type { JobRegistry } from "../jobs.js";

export type ReclaimKind = "superseded" | "orphan_dir" | "unregistered";
export interface ReclaimItem {
  id: string;
  kind: ReclaimKind;
  label: string;
  detail: string;
  bytes: number;
  deletable: boolean;
}
export interface StorageReport {
  disk: { total: number; free: number };
  footage_bytes: number;
  trip_count: number;
  items: ReclaimItem[];
}

/** 中斷殘留至少要這麼舊才列為可刪（避免碰到剛建立、還在寫入的資料夾）。 */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const itemId = (kind: ReclaimKind, key: string) =>
  `${kind}:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}`;

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isFile())
      total += await fs.stat(full).then(
        (s) => s.size,
        () => 0,
      );
    else if (e.isDirectory()) total += await dirBytes(full);
  }
  return total;
}

/** 旅程層級的資料夾（父層為 YYYY-MM-DD 日期夾），含 legacy 與 by-user/by-device 兩種佈局。 */
async function tripLevelDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (DATE_RE.test(e.name)) {
        for (const t of await fs.readdir(full, { withFileTypes: true }).catch(() => []))
          if (t.isDirectory() && !t.name.startsWith(".") && !t.name.includes(".youtube-cleanup-"))
            out.push(path.join(full, t.name));
      } else if (depth < 4) await visit(full, depth + 1);
    }
  };
  await visit(root, 0);
  return out;
}

interface Candidate extends ReclaimItem {
  dir: string;
  tripId?: string;
}

async function scan(
  db: DB,
  jobs?: JobRegistry,
): Promise<{ candidates: Candidate[]; footage: number; count: number }> {
  const rows = db
    .prepare("SELECT trip_id,date,trip_dir,front_path,rear_path,superseded_by FROM trips")
    .all() as Array<{
    trip_id: string;
    date: string;
    trip_dir: string | null;
    front_path: string | null;
    rear_path: string | null;
    superseded_by: string | null;
  }>;
  const known = new Set<string>();
  let footage = 0;
  for (const r of rows) {
    for (const p of [
      r.trip_dir,
      r.front_path && path.dirname(r.front_path),
      r.rear_path && path.dirname(r.rear_path),
    ])
      if (p) known.add(path.resolve(p));
    for (const p of [r.front_path, r.rear_path])
      if (p)
        footage += await fs.stat(p).then(
          (s) => s.size,
          () => 0,
        );
  }
  const candidates: Candidate[] = [];
  for (const r of rows) {
    if (!r.superseded_by || !r.trip_dir) continue;
    const replacement = getTrip(db, r.superseded_by);
    const dir = path.resolve(r.trip_dir);
    let blocker = "";
    if (!replacement) blocker = "取代它的合併旅程不存在";
    else if (!withinTrips(dir) || dir === path.resolve(TRIPS_DIR)) blocker = "旅程目錄不正確";
    else if (replacement.trip_dir && path.resolve(replacement.trip_dir) === dir)
      blocker = "與合併旅程共用目錄";
    else if (
      rows.some((o) => o.trip_id !== r.trip_id && o.trip_dir && path.resolve(o.trip_dir) === dir)
    )
      blocker = "其他旅程共用此目錄";
    else if (db.prepare("SELECT 1 FROM trip_clips WHERE trip_id=? LIMIT 1").get(r.trip_id))
      blocker = "有匯出片段，請先到片段頁處理";
    else if (jobs?.busy(r.trip_id)) blocker = "背景作業進行中";
    else {
      const replacementFiles = [replacement.front_path, replacement.rear_path].filter(
        Boolean,
      ) as string[];
      const sizes = await Promise.all(
        replacementFiles.map((f) =>
          fs.stat(f).then(
            (s) => s.size,
            () => 0,
          ),
        ),
      );
      if (!replacementFiles.length || sizes.some((s) => s === 0))
        blocker = "合併旅程的影片缺失，保留來源";
    }
    const bytes = await dirBytes(dir);
    if (!bytes) continue;
    candidates.push({
      id: itemId("superseded", r.trip_id),
      kind: "superseded",
      label: `${r.date} ${path.basename(dir)}`,
      detail:
        blocker || `已合併進「${path.basename(replacement!.trip_dir ?? "")}」，瀏覽頁已隱藏這趟`,
      bytes,
      deletable: !blocker,
      dir,
      tripId: r.trip_id,
    });
  }
  for (const dir of await tripLevelDirs(TRIPS_DIR)) {
    const resolved = path.resolve(dir);
    if (known.has(resolved)) continue;
    const hasInfo = await fs.stat(path.join(dir, "info.json")).then(
      () => true,
      () => false,
    );
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const stat = await fs.lstat(dir).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;
    const bytes = await dirBytes(dir);
    const label = `${path.basename(path.dirname(dir))} ${path.basename(dir)}`;
    if (hasInfo) {
      candidates.push({
        id: itemId("unregistered", resolved),
        kind: "unregistered",
        label,
        detail: "有 info.json 但資料庫沒有紀錄，可用「從磁碟重建」救回",
        bytes,
        deletable: false,
        dir: resolved,
      });
      continue;
    }
    let blocker = "";
    if (Date.now() - stat.mtimeMs < ORPHAN_MIN_AGE_MS) blocker = "一小時內仍有變動，稍後再檢查";
    else if (entries.some((e) => !e.isFile() || !/\.(mp4|jpg|json)$/i.test(e.name)))
      blocker = "含有非旅程檔案，請手動檢查";
    candidates.push({
      id: itemId("orphan_dir", resolved),
      kind: "orphan_dir",
      label,
      detail: blocker || "合併中斷留下的半成品（沒有 info.json、未出現在瀏覽頁）",
      bytes,
      deletable: !blocker,
      dir: resolved,
    });
  }
  candidates.sort((a, b) => b.bytes - a.bytes);
  return { candidates, footage, count: rows.length };
}

export async function storageReport(db: DB, jobs?: JobRegistry): Promise<StorageReport> {
  const { candidates, footage, count } = await scan(db, jobs);
  const st = await fs.statfs(DATA_DIR);
  return {
    disk: { total: st.blocks * st.bsize, free: st.bavail * st.bsize },
    footage_bytes: footage,
    trip_count: count,
    items: candidates.map(({ dir: _d, tripId: _t, ...item }) => item),
  };
}

export async function reclaimItems(
  db: DB,
  ids: string[],
  jobs?: JobRegistry,
): Promise<Array<{ id: string; deleted: boolean; bytes: number; detail?: string }>> {
  const { candidates } = await scan(db, jobs);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const results: Array<{ id: string; deleted: boolean; bytes: number; detail?: string }> = [];
  for (const id of new Set(ids)) {
    const c = byId.get(id);
    if (!c) {
      results.push({ id, deleted: false, bytes: 0, detail: "項目已不存在，請重新掃描" });
      continue;
    }
    if (!c.deletable) {
      results.push({ id, deleted: false, bytes: 0, detail: c.detail });
      continue;
    }
    try {
      const real = await fs.realpath(c.dir);
      if (real !== c.dir || !withinTrips(real) || real === path.resolve(TRIPS_DIR))
        throw new Error("目錄含符號連結或不在旅程區");
      if (c.kind === "superseded") await deleteTrip(db, c.tripId!);
      else await fs.rm(real, { recursive: true, force: true });
      results.push({ id, deleted: true, bytes: c.bytes });
    } catch (e) {
      results.push({
        id,
        deleted: false,
        bytes: 0,
        detail: e instanceof Error ? e.message : "刪除失敗",
      });
    }
  }
  return results;
}
