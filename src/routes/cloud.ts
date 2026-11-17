/**
 * 維運 › 雲端備份 API（全部限管理員；金鑰與服務網址限總管理員）。
 * 金鑰只以加密形式保存，任何回應都不會帶出金鑰、上傳權杖或伺服器上的絕對路徑。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { makeRequireAdmin, makeRequireOwner, type AppContext } from "../context.js";
import { CloudBackupService, type BackupRow } from "../cloud/service.js";
import { DEFAULT_ENDPOINT } from "../cloud/chunkproxy.js";

export const STORAGE_SITE = "https://cp.c-h.tw/";

function dto(row: BackupRow) {
  return {
    id: row.id,
    kind: row.kind,
    trip_id: row.trip_id,
    camera: row.camera,
    date: row.date,
    trip_no: row.trip_no,
    start_epoch: row.start_epoch,
    end_epoch: row.end_epoch,
    volume: row.volume,
    volumes: row.volumes,
    size: row.byte_length,
    file_size: row.source_size,
    uploaded_bytes: row.uploaded_bytes,
    parts_done: row.parts_done,
    part_count: row.part_count,
    status: row.status,
    message: row.message,
    remote_name: row.remote_name,
    remote_id: row.remote_id,
    sha256: row.sha256,
    verified: !!row.remote_sha256 && row.remote_sha256 === row.sha256,
    remote_state: row.remote_state,
    attempts: row.attempts,
    not_before: row.not_before,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  // 避免試算表把開頭的 = + - @ 當成公式執行。
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const wallClock = (epoch: number | null) =>
  epoch ? new Date(epoch * 1000).toISOString().slice(0, 16).replace("T", " ") : "";

export function registerCloudBackup(app: FastifyInstance, ctx: AppContext): void {
  const service = (ctx.cloud ??= new CloudBackupService(ctx));
  const requireAdmin = makeRequireAdmin(ctx),
    requireOwner = makeRequireOwner(ctx);
  // 不接受跨站帶 cookie 的寫入。
  const sameOrigin = async (req: FastifyRequest) => {
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host === req.host) return;
      } catch {}
      throw Object.assign(new Error("不接受跨站請求"), { statusCode: 403 });
    }
  };
  const read = { preHandler: requireAdmin };
  const write = { preHandler: [requireAdmin, sameOrigin] };
  const ownerWrite = { preHandler: [requireOwner, sameOrigin] };
  const guard =
    (fn: (req: any, reply: any) => Promise<unknown> | unknown) => async (req: any, reply: any) => {
      reply.header("Cache-Control", "no-store");
      try {
        return await fn(req, reply);
      } catch (error) {
        return reply.code(400).send({
          detail:
            error instanceof Error && !/ENOENT|EACCES|EIO|SQLITE/.test(error.message)
              ? error.message
              : "操作失敗，請稍後再試",
        });
      }
    };
  const page = (value: unknown) => Math.max(1, Math.min(10_000, Math.floor(Number(value)) || 1));
  const limitOf = (value: unknown, max: number, fallback: number) =>
    Math.max(1, Math.min(max, Math.floor(Number(value)) || fallback));
  const found = (req: any) => {
    const row = service.get(Number(req.params.id));
    if (!row) throw new Error("找不到這筆備份紀錄");
    return row;
  };

  app.addHook("onReady", () => service.start());
  app.addHook("onClose", () => service.stop());

  app.get(
    "/api/cloud-backup/status",
    read,
    guard((req) => {
      const config = service.config();
      const live = service.live;
      const current = live ? service.get(live.id) : undefined;
      return {
        configured: !!config.secret,
        key_hint: config.key_hint,
        endpoint: config.endpoint,
        default_endpoint: DEFAULT_ENDPOINT,
        storage_site: STORAGE_SITE,
        can_edit_key: !!req.user.is_owner,
        auto_new: !!config.auto_new,
        auto_since: config.auto_since || null,
        db_snapshot: !!config.db_snapshot,
        rate_mbps: config.rate_mbps,
        paused: !!config.paused,
        pause_reason: config.pause_reason || null,
        topup_url: config.topup_url,
        last_db_at: config.last_db_at || null,
        stats: service.stats(),
        current: current
          ? {
              ...dto(current),
              phase: live!.phase,
              done: live!.done,
              total: live!.total,
              rate: Math.round(live!.rate),
            }
          : null,
      };
    }),
  );

  app.put(
    "/api/cloud-backup/key",
    ownerWrite,
    guard((req) => {
      const key = typeof req.body?.api_key === "string" ? req.body.api_key.trim() : "";
      if (!/^[\x21-\x7e]{16,256}$/.test(key))
        throw new Error("API 金鑰格式不正確（應為 cpk_ 開頭的一串英數字）");
      service.setKey(key);
      return { configured: true, key_hint: key.slice(-4) };
    }),
  );
  app.delete(
    "/api/cloud-backup/key",
    ownerWrite,
    guard(async () => {
      await service.clearKey();
      return { configured: false };
    }),
  );
  app.put(
    "/api/cloud-backup/endpoint",
    ownerWrite,
    guard((req) => {
      const raw = typeof req.body?.endpoint === "string" ? req.body.endpoint.trim() : "";
      const endpoint = raw || DEFAULT_ENDPOINT;
      let url: URL;
      try {
        url = new URL(endpoint);
      } catch {
        throw new Error("服務網址格式不正確");
      }
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
        throw new Error("服務網址必須是 https:// 開頭、不含帳密與查詢參數");
      service.updateSettings({ endpoint: url.toString().replace(/\/+$/, "") });
      return { endpoint: service.config().endpoint };
    }),
  );
  app.put(
    "/api/cloud-backup/settings",
    write,
    guard((req) => {
      const body = req.body ?? {};
      const settings: { auto_new?: boolean; db_snapshot?: boolean; rate_mbps?: number } = {};
      if (body.auto_new !== undefined) {
        if (typeof body.auto_new !== "boolean") throw new Error("自動備份設定格式不正確");
        settings.auto_new = body.auto_new;
      }
      if (body.db_snapshot !== undefined) {
        if (typeof body.db_snapshot !== "boolean") throw new Error("資料庫快照設定格式不正確");
        settings.db_snapshot = body.db_snapshot;
      }
      if (body.rate_mbps !== undefined) {
        if (!Number.isInteger(body.rate_mbps) || body.rate_mbps < 0 || body.rate_mbps > 10_000)
          throw new Error("速度上限須為 0–10000 的整數（0 = 不限）");
        settings.rate_mbps = body.rate_mbps;
      }
      service.updateSettings(settings);
      const config = service.config();
      return {
        auto_new: !!config.auto_new,
        db_snapshot: !!config.db_snapshot,
        rate_mbps: config.rate_mbps,
      };
    }),
  );
  app.post(
    "/api/cloud-backup/pause",
    write,
    guard(async (req) => {
      if (typeof req.body?.paused !== "boolean") throw new Error("請指定暫停或繼續");
      await service.setPaused(req.body.paused);
      return { paused: req.body.paused };
    }),
  );
  // 開一個分段上傳再立刻取消：確認金鑰有效、點數足夠（取消會退還點數）。
  app.post(
    "/api/cloud-backup/check",
    { ...write, config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    guard(() => service.check()),
  );

  app.get<{ Querystring: { filter?: string; page?: string; limit?: string } }>(
    "/api/cloud-backup/trips",
    read,
    guard(async (req) => {
      const filter = ["pending", "all", "done"].includes(req.query.filter)
        ? req.query.filter
        : "pending";
      const p = page(req.query.page),
        limit = limitOf(req.query.limit, 100, 30);
      return { ...(await service.trips(filter, p, limit)), page: p, limit };
    }),
  );
  app.post(
    "/api/cloud-backup/enqueue",
    write,
    guard(async (req) => {
      const body = req.body ?? {};
      const cameras = body.cameras ?? "both";
      if (!["both", "front", "rear"].includes(cameras)) throw new Error("鏡頭選項不正確");
      if (body.all_pending === true) {
        const ids = (
          ctx.db
            .prepare(
              "SELECT trip_id FROM trips WHERE superseded_by IS NULL ORDER BY date,start_epoch",
            )
            .all() as {
            trip_id: string;
          }[]
        ).map((r) => r.trip_id);
        return service.enqueue(
          ids,
          cameras,
          req.user.id,
          (s) => s === "none" || s === "stale" || s === "failed",
        );
      }
      const ids = body.trip_ids;
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 2000 ||
        !ids.every((id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 512)
      )
        throw new Error("請選擇要備份的旅程");
      return service.enqueue(ids, cameras, req.user.id);
    }),
  );
  app.post(
    "/api/cloud-backup/database",
    write,
    guard((req) => ({ queued: service.enqueueDatabase(req.user.id) })),
  );

  app.get<{ Querystring: { view?: string; page?: string; limit?: string } }>(
    "/api/cloud-backup/jobs",
    read,
    guard((req) => {
      const view = ["active", "done", "cancelled"].includes(req.query.view)
        ? req.query.view
        : "active";
      const p = page(req.query.page),
        limit = limitOf(req.query.limit, 100, 20);
      const { total, rows } = service.list(view, p, limit);
      return { total, page: p, limit, jobs: rows.map(dto) };
    }),
  );
  app.get(
    "/api/cloud-backup/jobs/:id",
    read,
    guard((req) => {
      const row = found(req);
      return { job: dto(row), events: service.events(row.id) };
    }),
  );
  app.post(
    "/api/cloud-backup/jobs/:id/retry",
    write,
    guard((req) => ({ queued: service.retry(found(req).id) })),
  );
  app.post(
    "/api/cloud-backup/jobs/:id/cancel",
    write,
    guard(async (req) => ({ cancelled: await service.cancel(found(req).id) })),
  );
  app.post(
    "/api/cloud-backup/cancel-queued",
    write,
    guard(async () => ({ cancelled: await service.cancelQueued() })),
  );

  // 還原用清單（CSV，Excel 可直接開啟）：雲端檔名、檔案編號、SHA-256 與本機相對路徑。
  app.get(
    "/api/cloud-backup/manifest.csv",
    read,
    guard((_req, reply) => {
      const header = [
        "雲端檔名",
        "雲端檔案編號",
        "SHA-256",
        "大小(bytes)",
        "種類",
        "旅程日期",
        "開始(車機時間)",
        "結束(車機時間)",
        "鏡頭",
        "分卷",
        "本機路徑(相對旅程資料夾)",
        "完成時間(UTC)",
        "旅程代號",
      ];
      const lines = [header.map(csvCell).join(",")];
      for (const row of service.manifest())
        lines.push(
          [
            row.remote_name,
            row.remote_id,
            row.sha256,
            row.byte_length,
            row.kind === "trip" ? "影片" : "資料庫",
            row.date,
            wallClock(row.start_epoch),
            wallClock(row.end_epoch),
            row.camera === "front" ? "前鏡頭" : row.camera === "rear" ? "後鏡頭" : "",
            row.volumes > 1 ? `${row.volume}/${row.volumes}` : "",
            service.relativeSource(row),
            row.completed_at ? new Date(row.completed_at).toISOString() : "",
            row.trip_id,
          ]
            .map(csvCell)
            .join(","),
        );
      const stamp = new Date().toISOString().slice(0, 10);
      reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="dashcam-cloud-backup-${stamp}.csv"`);
      return "﻿" + lines.join("\r\n") + "\r\n";
    }),
  );
}
