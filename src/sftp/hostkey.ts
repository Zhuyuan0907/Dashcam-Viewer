/**
 * SFTP host key 取得 — 不存在時以 ssh-keygen 產生 ed25519(OpenSSH 格式,ssh2 可直接解析)。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SFTP_HOST_KEY_PATH } from "../config.js";

function generate(keyPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // -t ed25519 -N ""(無密碼)-C 註解 -f 輸出;OpenSSH 私鑰格式
    const proc = spawn(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", "dashcam-sftp", "-f", keyPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ssh-keygen 失敗(code ${code}):${stderr.trim()}`));
    });
  });
}

/** 取得 host key 私鑰內容;首次呼叫會自動產生並以 0600 權限保存。 */
export async function ensureHostKey(keyPath: string = SFTP_HOST_KEY_PATH): Promise<Buffer> {
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    await generate(keyPath);
    fs.chmodSync(keyPath, 0o600);
  }
  return fs.readFileSync(keyPath);
}
