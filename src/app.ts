/**
 * 組裝 Fastify 應用程式(供 server 與測試共用)。
 */
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { STATIC_DIR } from "./config.js";
import type { AppContext } from "./context.js";
import { registerPages } from "./routes/pages.js";
import { registerAuth } from "./routes/auth.js";
import { registerUsers } from "./routes/users.js";
import { registerAccount } from "./routes/account.js";
import { registerAdmin } from "./routes/admin.js";
import { registerVideo } from "./routes/video.js";
import { registerUploadSessions } from "./routes/upload.js";
import { registerProcess } from "./routes/process.js";
import { registerTrips } from "./routes/trips.js";
import { registerEdit } from "./routes/edit.js";
import { registerConfig } from "./routes/config.js";
import { registerOps } from "./routes/ops.js";

export interface BuildOptions {
  logger?: boolean;
}

export async function buildApp(ctx: AppContext, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 1 * 1024 * 1024, // JSON body 上限 1MB(檔案走 multipart 串流,不受此限)
    trustProxy: true,
  });

  await app.register(cookie);
  await app.register(helmet, {
    // 既有前端使用 inline script/style;此 CSP 在允許其運作的前提下仍保留其他防護。
    // 注意:本應用預設以「純 HTTP」在區網提供,因此關閉所有會強制 HTTPS 的標頭
    //（upgrade-insecure-requests / HSTS / COOP / Origin-Agent-Cluster),
    // 否則瀏覽器會把 /static/* 升級成 https:// 而失敗。若以 HTTPS 反代部署可再開啟。
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        // 既有前端用 inline onclick 事件處理器,需允許(否則按鈕全失效)
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "https://www.gravatar.com", "data:"],
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    hsts: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
  });
  await app.register(rateLimit, { global: false });
  await app.register(fastifyStatic, { root: STATIC_DIR, prefix: "/static/" });

  registerPages(app, ctx);
  registerAuth(app, ctx);
  registerUsers(app, ctx);
  registerAccount(app, ctx);
  registerAdmin(app, ctx);
  registerVideo(app, ctx);
  registerUploadSessions(app, ctx);
  registerProcess(app, ctx);
  registerTrips(app, ctx);
  registerEdit(app, ctx);
  registerConfig(app, ctx);
  registerOps(app, ctx);

  return app;
}
