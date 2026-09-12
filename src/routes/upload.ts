/**
 * 上傳工作階段 API(所有登入者;每階段綁定 userId)。
 *
 * 流程:
 *   POST   /api/upload-sessions          建立工作階段,回傳一次性 SFTP 連線資訊 + 專屬資料夾
 *   GET    /api/upload-sessions          列出自己還活著的工作階段(供 F5 重現,含倒數計時)
 *   DELETE /api/upload-sessions/:id      取消(刪資料夾與 SFTP 存取)
 *   POST   /api/upload-sessions/:id/confirm?gap_min=  ingest → 觸發既有處理管線(走 SSE)
 *
 * 瀏覽器直傳(HTTP,與 SFTP 共用同一個 session 資料夾,confirm/ingest 下游零改動):
 *   POST   /api/upload-sessions/:id/check      檔名預檢(classifyUpload),上傳前就標示格式不符
 *   GET    /api/upload-sessions/:id/files      列出已上傳的檔案(SFTP 傳的也看得到)
 *   PUT    /api/upload-sessions/:id/files/*    串流寫入單一檔案(application/octet-stream)
 *   DELETE /api/upload-sessions/:id/files/*    刪除誤傳的單一檔案
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { ingestFlatFolder } from "../uploads/ingest.js";
import { describeUpload } from "../uploads/routing.js";
import { startProcessing } from "./process.js";
import { safeJoin } from "../util/paths.js";
import { MAX_FILE_BYTES, MAX_SESSION_BYTES, MIN_FREE_DISK_BYTES, UPLOAD_DIR } from "../config.js";
import { makeRequireUser, type AppContext } from "../context.js";
import { UploadSessionCreationBlockedError, type SftpSession } from "../sftp/sessions.js";
import { defaultDevice, getDevice, listDevices, snapshotDevice } from "../devices/repo.js";

/** 單檔 HTTP body 上限:有設 MAX_FILE_BYTES 用之,0(不限)時給一個寬鬆天花板。 */
const HTTP_FILE_LIMIT = MAX_FILE_BYTES > 0 ? MAX_FILE_BYTES : 64 * 1024 * 1024 * 1024;

/** 正規化並驗證 client 傳來的相對路徑;不合法回 null。 */
function cleanRelPath(raw: string): string | null {
  const rel = (raw ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.length > 512 || rel.includes("\0")) return null;
  const segs = rel.split("/");
  if (segs.length > 8) return null;
  if (segs.some((s) => s === "" || s === "." || s === ".." || s.endsWith(".part"))) return null;
  return rel;
}

export function registerUploadSessions(app: FastifyInstance, ctx: AppContext): void {
  const { db, sessions, settings } = ctx;
  // 上傳開放給所有登入者(含訪客);每個工作階段綁定 userId,確認/取消仍限本人。
  const requireUser = makeRequireUser(ctx);

  /**
   * 使用者的有效上傳 idle 逾時(秒)。0=不限。
   * 規則:users.upload_idle_sec(非 null,0=不限)→ 否則 admin ⇒ 不限(0)→ 否則全域預設。
   */
  function effectiveIdle(user: { id: number; role: string }): number {
    const row = db
      .prepare("SELECT upload_idle_sec FROM users WHERE id = ?")
      .get(user.id) as { upload_idle_sec: number | null } | undefined;
    if (row && row.upload_idle_sec !== null) return row.upload_idle_sec;
    return user.role === "admin" ? 0 : settings.uploadIdleSec();
  }

  /** 把 session 轉成回給 client 的 JSON(含 SFTP 連線資訊與倒數)。 */
  function present(s: SftpSession): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    const idle = now - s.lastActivity;
    const unlimited = s.idleSec <= 0;
    const host = settings.sftpPublicHost();
    const port = settings.sftpPort();
    // 有 SFTP 連線在傳輸時不倒數(前端顯示「上傳中」);閒置(conns===0)才開始倒數。
    const uploading = s.conns > 0;
    const counting = s.status === "active" && !uploading && !unlimited;
    return {
      id: s.id,
      status: s.status,
      created_at: s.createdAt,
      file_count: s.fileCount,
      total_bytes: s.totalBytes,
      idle_sec: idle,
      idle_ttl_sec: unlimited ? null : s.idleSec,
      uploading,
      speed_bps: sessions.currentSpeed(s),
      expires_in: counting ? Math.max(0, s.idleSec - idle) : null,
      conns: s.conns,
      device_id: s.deviceId,
      device: s.deviceSnapshot,
      sftp: {
        host,
        port,
        username: sessions.sftpUsername(s),
        password: s.password,
        url: `sftp://${sessions.sftpUsername(s)}@${host}:${port}`,
      },
    };
  }

  app.post<{ Body: { device_id?: number | null } }>("/api/upload-sessions", { preHandler: requireUser }, async (req, reply) => {
    const user = req.user!;
    const rawId = req.body?.device_id;
    let device = rawId === undefined || rawId === null
      ? defaultDevice(db, user.id)
      : Number.isInteger(rawId)
        ? getDevice(db, user.id, rawId)
        : null;
    if (rawId !== undefined && rawId !== null && !device) {
      return reply.code(404).send({ detail: "找不到此行車記錄器" });
    }
    try {
      const s = sessions.create(
        { id: user.id, username: user.username },
        effectiveIdle(user),
        device ? { id: device.id, snapshot: snapshotDevice(device) } : null,
      );
      return present(s);
    } catch (error) {
      if (error instanceof UploadSessionCreationBlockedError) {
        return reply.code(409).send({ detail: error.message });
      }
      throw error;
    }
  });

  app.get("/api/upload-sessions", { preHandler: requireUser }, async (req) => {
    const user = req.user!;
    return sessions.listForUser(user.id).map(present);
  });

  app.patch<{ Params: { id: string }; Body: { device_id?: number | null } }>(
    "/api/upload-sessions/:id/device",
    { preHandler: requireUser },
    async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s || s.userId !== req.user!.id) {
        return reply.code(404).send({ detail: "工作階段不存在" });
      }
      if (s.status !== "active" || s.conns > 0) {
        return reply.code(409).send({ detail: "傳輸或處理期間無法更換來源記錄器" });
      }
      const rawId = req.body?.device_id;
      const device = Number.isInteger(rawId) ? getDevice(db, req.user!.id, rawId!) : null;
      if (!device) return reply.code(404).send({ detail: "找不到此行車記錄器" });
      sessions.setDevice(s.id, { id: device.id, snapshot: snapshotDevice(device) });
      return present(s);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/upload-sessions/:id",
    { preHandler: requireUser },
    async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s || s.userId !== req.user!.id) {
        return reply.code(404).send({ detail: "工作階段不存在" });
      }
      // 防護:處理中(ffmpeg 正在讀來源夾)絕不可刪,否則素材與進行中的合併一起毀;
      // 有連線在傳輸也不可刪(前端倒數歸零的自動回收可能因本地時鐘偏差誤發)。
      if (s.status === "processing") {
        return reply.code(409).send({ detail: "此工作階段正在處理中,無法取消" });
      }
      if (s.conns > 0) {
        return reply.code(409).send({ detail: "仍有連線在傳輸,請先中斷連線再取消" });
      }
      await sessions.remove(s.id);
      return { status: "ok" };
    },
  );

  app.post<{ Params: { id: string }; Querystring: { gap_min?: string } }>(
    "/api/upload-sessions/:id/confirm",
    { preHandler: requireUser },
    async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s || s.userId !== req.user!.id) {
        return reply.code(404).send({ detail: "工作階段不存在" });
      }
      if (s.status !== "active") {
        return reply.code(400).send({ detail: "此工作階段已在處理中" });
      }
      if (db.prepare('SELECT 1 FROM upload_files WHERE session_id=? AND complete=0 LIMIT 1').get(s.id)) {
        return reply.code(409).send({detail:'檔案尚未收齊，請重新選取相同檔案續傳'});
      }
      if (s.conns > 0) {
        return reply.code(409).send({ detail: "仍有 SFTP 連線在傳輸,請先中斷連線再確認" });
      }
      if (!s.deviceSnapshot && listDevices(db, req.user!.id).length > 0) {
        return reply.code(400).send({ detail: "請先選擇這批影片使用的行車記錄器" });
      }
      // 同步上鎖:在 await 之前立刻把狀態改為 processing,擋掉「雙擊確認」造成兩條處理管線
      // 同時 ingest + 兩個 ffmpeg 併寫同一輸出檔而損毀。better-sqlite3 同步、Node 單執行緒,
      // 「檢查 active + 設 processing」之間無 await → 具原子性。
      sessions.setStatus(s.id, "processing");

      try {
        const gapDefault = settings.defaultGapMin();
        const gapMin = Math.min(
          120,
          Math.max(1, Number.parseInt(req.query.gap_min ?? String(gapDefault), 10) || gapDefault),
        );
        const ingest = await ingestFlatFolder(s.id);
        if (ingest.accepted === 0) {
          // 沒有可處理檔案 → 解鎖,讓使用者補傳後可再次確認。
          sessions.setStatus(s.id, "active");
          return reply.code(400).send({
            detail: "資料夾內沒有可處理的影片檔案",
            rejected: ingest.rejected,
          });
        }
        if (ingest.rawProfiles.length > 1) {
          sessions.setStatus(s.id, "active");
          return reply.code(400).send({
            detail: "同一工作階段不可混合不同命名格式的原始片段，請分批上傳",
            profiles: ingest.rawProfiles,
          });
        }
        const actualProfile = ingest.rawProfiles[0];
        if (
          actualProfile && s.deviceSnapshot && s.deviceSnapshot.profile_key !== "custom" &&
          actualProfile !== s.deviceSnapshot.profile_key
        ) {
          sessions.setStatus(s.id, "active");
          return reply.code(400).send({
            detail: "影片檔名格式與所選行車記錄器不符，請更換來源記錄器後再確認",
            expected_profile: s.deviceSnapshot.profile_key,
            actual_profile: actualProfile,
          });
        }

        startProcessing(ctx, s.id, gapMin, ingest.uploadType);
        return {
          status: "started",
          session_id: s.id,
          accepted: ingest.accepted,
          rejected: ingest.rejected,
          upload_type: ingest.uploadType,
          profile: actualProfile ?? null,
        };
      } catch (e) {
        // ingest 例外 → 解鎖,避免卡死在 processing。
        sessions.setStatus(s.id, "active");
        throw e;
      }
    },
  );

  // ── 瀏覽器直傳(HTTP) ─────────────────────────────────────────────────────────

  /** 取出屬於請求者、且仍可收檔的 session;否則以 reply 短路。 */
  function activeSessionOf(
    req: { params: { id: string }; user?: { id: number } },
  ): SftpSession | null {
    const s = sessions.get(req.params.id);
    if (!s || s.userId !== req.user!.id) return null;
    return s;
  }

  // 檔名預檢:回傳每個相對路徑的分類結果,讓前端上傳前就標示會被拒絕/略過的檔案。
  app.post<{ Params: { id: string }; Body: { paths?: unknown } }>(
    "/api/upload-sessions/:id/check",
    { preHandler: requireUser },
    async (req, reply) => {
      const s = activeSessionOf(req);
      if (!s) return reply.code(404).send({ detail: "工作階段不存在" });
      const raw = req.body?.paths;
      if (!Array.isArray(raw) || raw.length > 5000) {
        return reply.code(400).send({ detail: "paths 必須是陣列(至多 5000 筆)" });
      }
      const results = raw.map((p) => {
        const rel = typeof p === "string" ? cleanRelPath(p) : null;
        if (!rel) return { path: String(p ?? ""), action: "reject" as const };
        const d = describeUpload(rel);
        return {
          path: rel,
          action: d.decision.action,
          profile: d.profile,
          camera: d.camera,
          reason: d.reason,
        };
      });
      return { results };
    },
  );

  // 列出 session 資料夾內已上傳的檔案(含 SFTP 傳入的;供前端顯示清單)。
  app.get<{ Params: { id: string } }>(
    "/api/upload-sessions/:id/files",
    { preHandler: requireUser },
    async (req, reply) => {
      const s = activeSessionOf(req);
      if (!s) return reply.code(404).send({ detail: "工作階段不存在" });
      const root = sessions.rootDir(s.id);
      const out: Array<{ path: string; size: number }> = [];
      async function walk(dir: string, prefix: string): Promise<void> {
        let entries: fs.Dirent[];
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (out.length >= 2000) return;
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
          else if (e.isFile() && !e.name.endsWith(".part")) {
            let size = 0;
            try {
              size = (await fsp.stat(path.join(dir, e.name))).size;
            } catch {
              continue;
            }
            out.push({ path: rel, size });
          }
        }
      }
      await walk(root, "");
      out.sort((a, b) => a.path.localeCompare(b.path));
      return { files: out };
    },
  );

  // 串流寫入單一檔案。先寫 <名>.part 再原子 rename,中斷不留半成品;
  // 同名覆寫(方便失敗重試),計數器會先扣掉舊檔大小。
  app.put<{ Params: { id: string; "*": string } }>(
    "/api/upload-sessions/:id/files/*",
    { preHandler: requireUser, bodyLimit: HTTP_FILE_LIMIT },
    async (req, reply) => {
      const s = activeSessionOf(req);
      if (!s) return reply.code(404).send({ detail: "工作階段不存在" });
      if (s.status !== "active") return reply.code(400).send({ detail: "此工作階段已在處理中" });

      const rel = cleanRelPath(req.params["*"]);
      if (!rel) return reply.code(400).send({ detail: "檔名不合法" });
      if(db.prepare('SELECT 1 FROM upload_manifests WHERE session_id=?').get(s.id))return reply.code(409).send({detail:'此階段使用續傳模式，請透過分塊端點上傳'});
      const root = sessions.rootDir(s.id);
      let dst: string;
      try {
        dst = safeJoin(root, rel);
      } catch {
        return reply.code(400).send({ detail: "檔名不合法" });
      }

      const body = req.body as NodeJS.ReadableStream | undefined;
      if (!body || typeof (body as NodeJS.ReadableStream).pipe !== "function") {
        return reply.code(400).send({ detail: "請以 application/octet-stream 串流上傳檔案內容" });
      }

      const tmp = `${dst}.part`;
      let written = 0;
      let prevSize = 0;
      const counter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          written += chunk.length;
          if (MAX_FILE_BYTES > 0 && written > MAX_FILE_BYTES) {
            cb(new Error("檔案超過單檔大小上限"));
            return;
          }
          sessions.touch(s.id, { bytes: chunk.length });
          if (MAX_SESSION_BYTES > 0 && s.totalBytes > MAX_SESSION_BYTES) {
            cb(new Error("此工作階段已達上傳總量上限"));
            return;
          }
          cb(null, chunk);
        },
      });

      // 必須在第一個 await 前同步登記。否則 statfs/stat/mkdir 的等待空窗內，confirm
      // 可能開始 ingest，或 cancel 刪掉整個 session；隨後這個 PUT 又會重建孤兒目錄。
      sessions.connOpened(s.id);
      try {
        // 磁碟可用空間保護(與 SFTP 寫入同一道防線)。
        if (MIN_FREE_DISK_BYTES > 0) {
          try {
            const st = await fsp.statfs(UPLOAD_DIR);
            if (st.bsize * st.bavail < MIN_FREE_DISK_BYTES) {
              return reply.code(507).send({ detail: "磁碟可用空間不足,已拒絕寫入" });
            }
          } catch {
            /* statfs 失敗不擋 */
          }
        }
        if (MAX_SESSION_BYTES > 0 && s.totalBytes >= MAX_SESSION_BYTES) {
          return reply.code(413).send({ detail: "此工作階段已達上傳總量上限" });
        }
        try {
          prevSize = (await fsp.stat(dst)).size; // 覆寫:記下舊檔大小供計數校正
        } catch {
          prevSize = 0;
        }
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await pipeline(body, counter, fs.createWriteStream(tmp));
        await fsp.rename(tmp, dst);
        // 計數校正:串流中已逐塊累加 bytes;覆寫需扣舊檔大小,新檔才 +1 檔數。
        sessions.touch(s.id, { bytes: -prevSize, files: prevSize > 0 ? 0 : 1 });
        return { status: "ok", path: rel, size: written };
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        // 寫入失敗:把已累計的 bytes 退回,避免統計虛胖。
        sessions.touch(s.id, { bytes: -written });
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ detail: `寫入失敗:${msg}` });
      } finally {
        sessions.connClosed(s.id);
      }
    },
  );

  // 刪除誤傳的單一檔案。
  app.delete<{ Params: { id: string; "*": string } }>(
    "/api/upload-sessions/:id/files/*",
    { preHandler: requireUser },
    async (req, reply) => {
      const s = activeSessionOf(req);
      if (!s) return reply.code(404).send({ detail: "工作階段不存在" });
      if (s.status !== "active") return reply.code(400).send({ detail: "此工作階段已在處理中" });
      const rel = cleanRelPath(req.params["*"]);
      if (!rel) return reply.code(400).send({ detail: "檔名不合法" });
      let target: string;
      try {
        target = safeJoin(sessions.rootDir(s.id), rel);
      } catch {
        return reply.code(400).send({ detail: "檔名不合法" });
      }
      // 刪檔也會跨 await；先鎖住 session，避免 confirm 同時開始讀取或 cancel 刪除根目錄。
      sessions.connOpened(s.id);
      try {
        let size = 0;
        try {
          size = (await fsp.stat(target)).size;
        } catch {
          return reply.code(404).send({ detail: "檔案不存在" });
        }
        await fsp.rm(target, { force: true });
        sessions.touch(s.id, { bytes: -size, files: -1 });
        return { status: "ok" };
      } finally {
        sessions.connClosed(s.id);
      }
    },
  );
}
