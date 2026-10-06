import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";

/** Separate from database snapshots; never send credentials or upload URLs to clients. */
export class YoutubeVault {
  constructor(private readonly file = path.join(DATA_DIR, "youtube.key")) {}
  private key(create: boolean): Buffer {
    try {
      const key = fs.readFileSync(this.file);
      if (key.length !== 32) throw new Error("YouTube 金鑰損壞，請還原金鑰備份");
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) throw new Error("YouTube 金鑰遺失，請還原金鑰備份");
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const key = crypto.randomBytes(32);
      try {
        fs.writeFileSync(this.file, key, { flag: "wx", mode: 0o600 });
        return key;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return this.key(false);
      }
    }
  }
  seal(value: unknown, context: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key(true), iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  }
  open<T>(value: string, context: string): T {
    const packed = Buffer.from(value, "base64url");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.key(false),
      packed.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(packed.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString(),
    );
  }
}
