/**
 * 測試輔助:建立帶 admin 登入 cookie 的 app(供 config/settings/strings API 測試)。
 * 呼叫端必須在 import 此檔之前先設好 process.env.DASHCAM_DATA_DIR。
 */
import path from "node:path";
import { createDb } from "../src/db.js";
import { SftpSessionManager } from "../src/sftp/sessions.js";
import { SSERegistry } from "../src/uploads/sse.js";
import { SettingsStore } from "../src/settings/store.js";
import { JobRegistry } from "../src/jobs.js";
import { buildApp } from "../src/app.js";
import { newSessionToken } from "../src/auth.js";
import type { AppContext } from "../src/context.js";

let seq = 0;

export async function makeAdminApp(dataDir: string) {
  const db = createDb(path.join(dataDir, `api${seq++}.db`));
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, email, created_at) VALUES (1,'admin','h','admin','',0)",
  ).run();
  const token = newSessionToken();
  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?,1,?,?)",
  ).run(token, Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000));

  const ctx: AppContext = {
    db,
    sessions: new SftpSessionManager(db),
    sse: new SSERegistry(),
    settings: new SettingsStore(db),
    jobs: new JobRegistry(),
  };
  const app = await buildApp(ctx);
  return { app, ctx, cookie: `session_token=${token}` };
}
