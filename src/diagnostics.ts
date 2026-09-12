import fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DATA_DIR,
  COOKIE_SECURE,
  TRUST_PROXY,
  SFTP_ENABLED,
  SHARE_TOKEN_KEY_PATH,
  MIN_FREE_DISK_BYTES,
} from "./config.js";
import type { DB } from "./db.js";

export async function diagnostics(db?: DB) {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const check = async (name: string, run: () => Promise<string>) => {
    try {
      checks.push({ name, ok: true, detail: await run() });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
  checks.push({
    name: "node",
    ok: Number(process.versions.node.split(".")[0]) >= 22,
    detail: process.versions.node,
  });
  for (const command of ["ffmpeg", "ffprobe", ...(SFTP_ENABLED ? ["ssh-keygen"] : [])]) {
    await check(command, async () => {
      if (command === "ssh-keygen") {
        await promisify(execFile)("sh", ["-c", "command -v ssh-keygen"], { timeout: 5000 });
        return "available";
      }
      const { stdout } = await promisify(execFile)(command, ["-version"], {
        timeout: 5000,
        maxBuffer: 65536,
      });
      return stdout.split("\n")[0] ?? command;
    });
  }
  await check("data-directory", async () => {
    await fs.access(DATA_DIR, constants.R_OK | constants.W_OK);
    return DATA_DIR;
  });
  await check("free-space", async () => {
    const stat = await fs.statfs(DATA_DIR),
      bytes = stat.bavail * stat.bsize;
    if (bytes < MIN_FREE_DISK_BYTES) throw Error(`剩餘 ${bytes} bytes，低於安全保留量`);
    return `${bytes} bytes available`;
  });
  if (db)
    await check("sqlite", async () => {
      const integrity = db.pragma("quick_check", { simple: true });
      if (integrity !== "ok") throw Error(String(integrity));
      return "ok";
    });
  const keyPresent = await fs
    .stat(SHARE_TOKEN_KEY_PATH)
    .then((s) => s.isFile())
    .catch(() => false);
  return {
    ok: checks.every((c) => c.ok),
    checks,
    security: {
      secure_cookie: COOKIE_SECURE,
      trust_proxy: TRUST_PROXY,
      sftp_enabled: SFTP_ENABLED,
      share_key_present: keyPresent,
    },
    notes: [
      "分享金鑰在首次建立可恢復分享連結時產生；不存在不一定是故障。",
      "HTTP 直連僅適用可信內網；公開服務請使用 HTTPS。",
    ],
  };
}
