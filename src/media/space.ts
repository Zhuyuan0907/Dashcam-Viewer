import fs from "node:fs/promises";
import { DATA_DIR, MIN_FREE_DISK_BYTES } from "../config.js";
let reserved = 0;
export class InsufficientSpaceError extends Error {
  readonly statusCode = 507;
}
export async function reserveSpace(bytes: number, directory = DATA_DIR): Promise<() => void> {
  const disk = await fs.statfs(directory);
  if (disk.bavail * disk.bsize - reserved < bytes + MIN_FREE_DISK_BYTES)
    throw new InsufficientSpaceError("磁碟空間不足，請清理容量後重試");
  reserved += bytes;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      reserved -= bytes;
    }
  };
}
export async function reserveForMedia(paths: string[], factor = 3): Promise<() => void> {
  const sizes = await Promise.all(paths.map((p) => fs.stat(p).then((s) => s.size)));
  return reserveSpace(sizes.reduce((a, b) => a + b, 0) * factor);
}
