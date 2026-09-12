/**
 * 進入點:初始化 DB、組裝 app、啟動 SFTP 伺服器與回收迴圈、監聽。
 */
import {
  HOST,
  PORT,
  SFTP_ENABLED,
  SFTP_PORT,
  UPLOAD_SWEEP_SEC,
  BACKUP_ENABLED,
  BACKUP_DIR,
  BACKUP_INTERVAL_HOURS,
  BACKUP_KEEP,
} from "./config.js";
import { getDb, ensureDataDirs, purgeExpiredSessions, backupDb, pruneBackups } from "./db.js";
import { SftpSessionManager } from "./sftp/sessions.js";
import { buildSftpServer, type SftpServerHandle } from "./sftp/server.js";
import { SSERegistry } from "./uploads/sse.js";
import { SettingsStore } from "./settings/store.js";
import { JobRegistry } from "./jobs.js";
import { sweepQuarantine } from "./incidents/repo.js";
import { recoverInterruptedTrims } from "./routes/edit.js";
import { cleanupOrphanClips } from "./routes/clips.js";
import { syncTripInfoDeviceMetadata } from "./trips/repo.js";
import { buildApp } from "./app.js";
import type { AppContext } from "./context.js";
import { stopMediaProcesses } from "./media/ffmpeg.js";

/** ISO 時間戳做為備份檔名(檔名安全:去掉 ":" 與毫秒)。 */
function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function main(): Promise<void> {
  ensureDataDirs();
  const db = getDb();
  purgeExpiredSessions(db);

  const ctx: AppContext = {
    db,
    sessions: new SftpSessionManager(db),
    sse: new SSERegistry(),
    settings: new SettingsStore(db),
    jobs: new JobRegistry(),
  };

  const app = await buildApp(ctx, { logger: true });

  // 進程層級的安全網:背景 void promise(sweep / SSE / ffmpeg 後續)若拋出未捕捉的 rejection,
  // 只記錄不讓整個服務崩潰(否則磁碟滿等瞬時錯誤會造成 systemd 反覆重啟的 crash loop)。
  process.on("unhandledRejection", (reason) =>
    app.log.error({ err: reason }, "unhandledRejection"),
  );
  process.on("uncaughtException", (err) => {
    app.log.fatal({ err }, "uncaughtException: terminating unsafe process");
    stopMediaProcesses();
    process.exit(1);
  });

  // 啟動時的崩潰/中斷殘留修復。
  // A failed rollback is not safe to serve. Let the supervisor report startup failure.
  const trimFixed = await recoverInterruptedTrims(db);
  try {
    const orphans = await ctx.sessions.purgeOrphanDirs();
    if (orphans > 0) app.log.info(`清理 ${orphans} 個孤兒上傳資料夾`);
    if (trimFixed > 0) app.log.info(`修復 ${trimFixed} 個中斷的裁剪殘留(暫存檔/遺失播放檔)`);
    const clipOrphans = await cleanupOrphanClips(db);
    if (clipOrphans > 0) app.log.info(`清理 ${clipOrphans} 個孤兒匯出片段`);
    const metadataMarker = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("schema.trip_info_devices_v1") as { value: string } | undefined;
    if (!metadataMarker) {
      const synced = await syncTripInfoDeviceMetadata(db);
      if (synced.failed === 0) {
        db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, '1', ?)").run(
          "schema.trip_info_devices_v1",
          Math.floor(Date.now() / 1000),
        );
      }
      app.log.info(
        `旅程 metadata 裝置快照同步：掃描 ${synced.scanned}、更新 ${synced.updated}、失敗 ${synced.failed}`,
      );
    }
  } catch (e) {
    app.log.warn({ err: e }, "啟動殘留修復失敗");
  }

  // ── 內嵌 SFTP 伺服器 ──
  let sftp: SftpServerHandle | null = null;
  if (SFTP_ENABLED) {
    sftp = await buildSftpServer(ctx.sessions);
    await sftp.start();
    app.log.info(`SFTP 上傳伺服器已啟動於 :${SFTP_PORT}`);
  }

  // ── 資料庫自動備份:開機先做一次,之後每 BACKUP_INTERVAL_HOURS 由 sweep 觸發 ──
  let lastBackupMs = 0;
  const doBackup = (): void => {
    if (!BACKUP_ENABLED) return;
    try {
      const file = backupDb(db, BACKUP_DIR, backupStamp());
      pruneBackups(BACKUP_DIR, BACKUP_KEEP);
      app.log.info(`資料庫已備份:${file}`);
    } catch (e) {
      // 失敗也推進時間戳(退避):否則磁碟滿等持續性故障會讓每 30 秒的 sweep
      // 反覆重跑整個 VACUUM INTO,雪上加霜。下個備份週期自然重試。
      app.log.warn({ err: e }, "資料庫備份失敗(下個週期重試)");
    } finally {
      lastBackupMs = Date.now();
    }
  };
  doBackup();

  // ── 回收迴圈:閒置上傳工作階段 + 過期 SSE channel + 逾期隔離素材 + 定期 DB 備份 ──
  let quarantineCheck = 0;
  const sweep = setInterval(() => {
    // 整段包在 try/catch:任一步驟(含同步 better-sqlite3)拋例外都不得逸出成 unhandledRejection,
    // 否則背景迴圈一次錯誤就拖垮整個服務。
    void (async () => {
      try {
        for (const id of ctx.sessions.findExpired()) {
          // findExpired 是快照;逐一 await 期間 session 可能已被確認(轉 processing)
          // 或有新連線進來 —— 刪除前再驗一次即時狀態,避免把「剛活過來」的階段連夾刪掉。
          const s = ctx.sessions.get(id);
          if (!s || s.conns > 0 || s.status === "processing") continue;
          await ctx.sessions.remove(id);
        }
        ctx.sse.sweep();
        // 隔離素材逾期清理 + 過期登入 session 清理:不必每輪都掃,約每 100 輪(預設 ~50 分)一次。
        if (quarantineCheck++ % 100 === 0) {
          const maxAge = ctx.settings.quarantineRetentionDays() * 86_400;
          const n = await sweepQuarantine(db, maxAge).catch(() => 0);
          if (n > 0) app.log.info(`清理 ${n} 筆逾期隔離素材`);
          purgeExpiredSessions(db); // 長時間運行不重啟時,過期 token 也要定期清
        }
        if (BACKUP_ENABLED && Date.now() - lastBackupMs >= BACKUP_INTERVAL_HOURS * 3_600_000) {
          doBackup();
        }
      } catch (e) {
        app.log.error({ err: e }, "回收迴圈發生錯誤(已忽略,不中斷服務)");
      }
    })();
  }, UPLOAD_SWEEP_SEC * 1000);
  sweep.unref();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return; // 重複收訊只跑一次
    shuttingDown = true;
    // 逾時保底:若 SFTP/HTTP 因既有連線卡住無法優雅關閉,10 秒後強制結束(避免無限期不退出)。
    const force = setTimeout(() => {
      app.log.error("關機逾時,強制結束");
      stopMediaProcesses();
      process.exit(1);
    }, 10_000);
    force.unref();
    try {
      clearInterval(sweep);
      ctx.tasks?.stop();
      while (ctx.tasks?.active()) await new Promise((resolve) => setTimeout(resolve, 100));
      if (sftp) await sftp.stop();
      stopMediaProcesses();
      await app.close();
    } catch (e) {
      app.log.error({ err: e }, "關機過程發生錯誤");
    }
    clearTimeout(force);
    try {
      db.close();
    } catch (e) {
      app.log.error({ err: e }, "關閉資料庫失敗");
    }
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
