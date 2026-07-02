/**
 * 進入點:初始化 DB、組裝 app、啟動 SFTP 伺服器與回收迴圈、監聽。
 */
import { HOST, PORT, SFTP_ENABLED, SFTP_PORT, UPLOAD_SWEEP_SEC } from "./config.js";
import { getDb, ensureDataDirs, purgeExpiredSessions } from "./db.js";
import { SftpSessionManager } from "./sftp/sessions.js";
import { buildSftpServer, type SftpServerHandle } from "./sftp/server.js";
import { SSERegistry } from "./uploads/sse.js";
import { SettingsStore } from "./settings/store.js";
import { sweepQuarantine } from "./incidents/repo.js";
import { buildApp } from "./app.js";
import type { AppContext } from "./context.js";

async function main(): Promise<void> {
  ensureDataDirs();
  const db = getDb();
  purgeExpiredSessions(db);

  const ctx: AppContext = {
    db,
    sessions: new SftpSessionManager(db),
    sse: new SSERegistry(),
    settings: new SettingsStore(db),
  };

  const app = await buildApp(ctx, { logger: true });

  // 啟動時清理孤兒上傳資料夾(中斷/崩潰殘留),避免暫存累積佔碟。
  try {
    const orphans = await ctx.sessions.purgeOrphanDirs();
    if (orphans > 0) app.log.info(`清理 ${orphans} 個孤兒上傳資料夾`);
  } catch (e) {
    app.log.warn({ err: e }, "清理孤兒資料夾失敗");
  }

  // ── 內嵌 SFTP 伺服器 ──
  let sftp: SftpServerHandle | null = null;
  if (SFTP_ENABLED) {
    sftp = await buildSftpServer(ctx.sessions);
    await sftp.start();
    app.log.info(`SFTP 上傳伺服器已啟動於 :${SFTP_PORT}`);
  }

  // ── 回收迴圈:閒置上傳工作階段 + 過期 SSE channel + 逾期隔離素材 ──
  let quarantineCheck = 0;
  const sweep = setInterval(() => {
    void (async () => {
      for (const id of ctx.sessions.findExpired()) {
        await ctx.sessions.remove(id);
      }
      ctx.sse.sweep();
      // 隔離素材逾期清理:不必每輪都掃,約每 100 輪(預設 ~50 分)一次即可。
      if (quarantineCheck++ % 100 === 0) {
        const maxAge = ctx.settings.quarantineRetentionDays() * 86_400;
        const n = await sweepQuarantine(db, maxAge).catch(() => 0);
        if (n > 0) app.log.info(`清理 ${n} 筆逾期隔離素材`);
      }
    })();
  }, UPLOAD_SWEEP_SEC * 1000);
  sweep.unref();

  const shutdown = async (): Promise<void> => {
    clearInterval(sweep);
    if (sftp) await sftp.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ host: HOST, port: PORT });
}

main().catch((err) => {
  console.error("啟動失敗:", err);
  process.exit(1);
});
