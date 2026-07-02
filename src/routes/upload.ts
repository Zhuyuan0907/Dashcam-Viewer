/**
 * SFTP 上傳工作階段 API(所有登入者;每階段綁定 userId)。
 *
 * 取代舊的 HTTP multipart 上傳。流程:
 *   POST   /api/upload-sessions          建立工作階段,回傳一次性 SFTP 連線資訊 + 專屬資料夾
 *   GET    /api/upload-sessions          列出自己還活著的工作階段(供 F5 重現,含倒數計時)
 *   DELETE /api/upload-sessions/:id      取消(刪資料夾與 SFTP 存取)
 *   POST   /api/upload-sessions/:id/confirm?gap_min=  ingest → 觸發既有處理管線(走 SSE)
 */
import type { FastifyInstance } from "fastify";
import { ingestFlatFolder } from "../uploads/ingest.js";
import { startProcessing } from "./process.js";
import { makeRequireUser, type AppContext } from "../context.js";
import type { SftpSession } from "../sftp/sessions.js";

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
      sftp: {
        host,
        port,
        username: sessions.sftpUsername(s),
        password: s.password,
        url: `sftp://${sessions.sftpUsername(s)}@${host}:${port}`,
      },
    };
  }

  app.post("/api/upload-sessions", { preHandler: requireUser }, async (req) => {
    const user = req.user!;
    const s = sessions.create({ id: user.id, username: user.username }, effectiveIdle(user));
    return present(s);
  });

  app.get("/api/upload-sessions", { preHandler: requireUser }, async (req) => {
    const user = req.user!;
    return sessions.listForUser(user.id).map(present);
  });

  app.delete<{ Params: { id: string } }>(
    "/api/upload-sessions/:id",
    { preHandler: requireUser },
    async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s || s.userId !== req.user!.id) {
        return reply.code(404).send({ detail: "工作階段不存在" });
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
      if (s.conns > 0) {
        return reply.code(409).send({ detail: "仍有 SFTP 連線在傳輸,請先中斷連線再確認" });
      }

      const gapDefault = settings.defaultGapMin();
      const gapMin = Math.min(
        120,
        Math.max(1, Number.parseInt(req.query.gap_min ?? String(gapDefault), 10) || gapDefault),
      );
      const ingest = await ingestFlatFolder(s.id);
      if (ingest.accepted === 0) {
        return reply.code(400).send({
          detail: "資料夾內沒有可處理的影片檔案",
          rejected: ingest.rejected,
        });
      }

      startProcessing(ctx, s.id, gapMin, ingest.uploadType);
      return {
        status: "started",
        session_id: s.id,
        accepted: ingest.accepted,
        rejected: ingest.rejected,
        upload_type: ingest.uploadType,
      };
    },
  );
}
