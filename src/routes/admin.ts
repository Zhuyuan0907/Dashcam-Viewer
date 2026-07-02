/**
 * 伺服器狀態 API(僅限管理員)。
 */
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { DATA_DIR, TRIPS_DIR, DB_PATH } from "../config.js";
import { effectiveGravatar } from "../gravatar.js";
import { listTripsForFiles } from "../trips/repo.js";
import { makeRequireAdmin, type AppContext } from "../context.js";

function duBytes(dir: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("du", ["-sb", dir], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(0);
    }, 30_000);
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(0);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(0);
      const n = Number.parseInt(out.split(/\s+/)[0] ?? "0", 10);
      resolve(Number.isFinite(n) ? n : 0);
    });
  });
}

export function registerAdmin(app: FastifyInstance, ctx: AppContext): void {
  const requireAdmin = makeRequireAdmin(ctx);

  app.get("/api/admin/storage", { preHandler: requireAdmin }, async () => {
    const st = await fs.statfs(DATA_DIR);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    const used = total - free;

    const tripsBytes = await duBytes(TRIPS_DIR);
    let dbBytes = 0;
    try {
      dbBytes = (await fs.stat(DB_PATH)).size;
    } catch {
      /* DB 尚未建立 */
    }

    return {
      disk_total: total,
      disk_used: used,
      disk_free: free,
      disk_pct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
      trips_bytes: tripsBytes,
      db_bytes: dbBytes,
    };
  });

  app.get("/api/admin/active-uploads", { preHandler: requireAdmin }, async () => {
    const now = Math.floor(Date.now() / 1000);
    return ctx.sessions.listAll().map((s) => ({
      session_id: s.id,
      username: s.username,
      gravatar_url: effectiveGravatar({ username: s.username }) ?? "",
      upload_type: "sftp",
      file_count: s.fileCount,
      total_bytes: s.totalBytes,
      speed_bps: ctx.sessions.currentSpeed(s),
      last_filename: "",
      status: s.status, // active | processing | done
      conns: s.conns,
      elapsed_sec: now - s.createdAt,
      idle_sec: now - s.lastActivity,
    }));
  });

  // 管理員中斷任一使用者的上傳工作階段(刪資料夾 + 列)。
  app.delete<{ Params: { id: string } }>(
    "/api/admin/active-uploads/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const s = ctx.sessions.get(req.params.id);
      if (!s) return reply.code(404).send({ detail: "工作階段不存在" });
      await ctx.sessions.remove(s.id);
      return { status: "ok" };
    },
  );

  // 檔案總管:所有旅程依日期分組,含磁碟路徑與大小(供管理員檢視 / 下載 / 刪除)。
  app.get("/api/admin/files", { preHandler: requireAdmin }, async () => {
    const rows = await listTripsForFiles(ctx.db);
    const byDate = new Map<string, Array<Record<string, unknown>>>();
    for (const r of rows) {
      const item = {
        trip_id: r.trip_id,
        day_order: r.day_order,
        start_epoch: r.start_epoch,
        end_epoch: r.end_epoch,
        duration_sec: r.duration_sec,
        trip_dir: r.trip_dir,
        front_path: r.front_path,
        rear_path: r.rear_path,
        has_front: r.has_front,
        has_rear: r.has_rear,
        bytes: r.bytes,
        owner_username: r.owner_username,
      };
      const arr = byDate.get(r.date);
      if (arr) arr.push(item);
      else byDate.set(r.date, [item]);
    }
    // rows 已依 start_epoch DESC;date 依序(新到舊)彙整。
    return [...byDate.entries()].map(([date, trips]) => ({ date, trips }));
  });
}
