/**
 * 內嵌 SFTP 伺服器(Pterodactyl wings 模式)。
 *
 * 驗證:username = `帳號.sid`,密碼 = 該 session 的一次性密碼。通過後把連線沙箱在
 * UPLOAD_DIR/<sid>。每條連線只允許 SFTP 子系統,拒絕 shell/exec(不可當一般 SSH 用)。
 */
import crypto from "node:crypto";
import ssh2 from "ssh2";
import type { Connection, AuthContext, Session } from "ssh2";
import { SFTP_HOST, SFTP_PORT } from "../config.js";
import type { SftpSessionManager } from "./sessions.js";
import { ensureHostKey } from "./hostkey.js";
import { bindSftpHandlers } from "./handlers.js";

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** 解析 `帳號.sid`(sid 為最後一個點之後的段)。 */
function parseUsername(raw: string): { account: string; sid: string } | null {
  const i = raw.lastIndexOf(".");
  if (i <= 0 || i === raw.length - 1) return null;
  return { account: raw.slice(0, i), sid: raw.slice(i + 1) };
}

export interface SftpServerHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function buildSftpServer(sessions: SftpSessionManager): Promise<SftpServerHandle> {
  const hostKey = await ensureHostKey();

  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client: Connection) => {
    let sid: string | null = null;
    let root: string | null = null;

    client.on("authentication", (ctx: AuthContext) => {
      if (ctx.method !== "password") return ctx.reject(["password"]);
      const parsed = parseUsername(ctx.username);
      if (!parsed) return ctx.reject();
      const s = sessions.get(parsed.sid);
      if (!s || s.status !== "active" || s.username !== parsed.account) return ctx.reject();
      if (!timingSafeEqualStr(ctx.password, s.password)) return ctx.reject();
      sid = s.id;
      root = sessions.rootDir(s.id);
      sessions.connOpened(s.id);
      ctx.accept();
    });

    client.on("ready", () => {
      client.on("session", (acceptSession: () => Session) => {
        const session = acceptSession();
        // 只開放 SFTP;明確拒絕 shell/exec
        session.on("shell", (_accept: unknown, reject: () => void) => reject());
        session.on("exec", (_accept: unknown, reject: () => void) => reject());
        session.on("sftp", (acceptSftp: () => unknown) => {
          const sftp = acceptSftp();
          if (sid) {
            const id = sid;
            bindSftpHandlers(sftp, root!, (delta) => sessions.touch(id, delta));
          }
        });
      });
    });

    client.on("close", () => {
      if (sid) sessions.connClosed(sid);
    });
    client.on("error", () => {
      /* 連線層錯誤(例如握手失敗);close 會接著處理計數 */
    });
  });

  return {
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(SFTP_PORT, SFTP_HOST, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
