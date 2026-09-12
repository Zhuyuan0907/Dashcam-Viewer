import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { fileHash } from "../util/file-hash.js";
import { isSafeRelative, safeJoin } from "../util/paths.js";

interface Manifest {
  version: 1;
  source: string;
  created_at: string;
  files: { path: string; sha256: string }[];
}

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(relative: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw Error(`備份不接受符號連結：${name}`);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files.push(name);
      else throw Error(`不支援的特殊檔案：${name}`);
    }
  }
  await walk("");
  return files.sort();
}

function checkDatabase(file: string): void {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma("quick_check", { simple: true }) !== "ok")
      throw Error("SQLite integrity check failed");
  } finally {
    db.close();
  }
}

/** Offline-only contract: caller must stop every writer before invoking this operation. */
export async function createBundle(source: string, destination: string): Promise<Manifest> {
  source = path.resolve(source);
  destination = path.resolve(destination);
  if (destination === source || destination.startsWith(source + path.sep))
    throw Error("備份必須放在資料目錄以外");
  const files = await filesUnder(source);
  checkDatabase(path.join(source, "dashcam.db"));
  await fs.mkdir(destination, { mode: 0o700 }); // Refuse existing destinations; never overwrite backups.
  await fs.cp(source, path.join(destination, "data"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const manifest: Manifest = {
    version: 1,
    source,
    created_at: new Date().toISOString(),
    files: [],
  };
  for (const file of files)
    manifest.files.push({
      path: file,
      sha256: await fileHash(path.join(destination, "data", file)),
    });
  await fs.writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  await verifyBundle(destination);
  return manifest;
}

export async function verifyBundle(directory: string): Promise<Manifest> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(directory, "manifest.json"), "utf8"),
  ) as Manifest;
  if (
    manifest.version !== 1 ||
    typeof manifest.source !== "string" ||
    !Array.isArray(manifest.files)
  )
    throw Error("無效備份清單");
  const data = path.join(directory, "data"),
    actual = await filesUnder(data);
  if (actual.length !== manifest.files.length) throw Error("備份檔案數不符");
  const remaining = new Set(actual);
  for (const entry of manifest.files) {
    if (
      typeof entry.path !== "string" ||
      !isSafeRelative(entry.path) ||
      !remaining.delete(entry.path)
    )
      throw Error("不安全或重複的備份路徑");
    if ((await fileHash(safeJoin(data, entry.path))) !== entry.sha256)
      throw Error(`備份校驗失敗：${entry.path}`);
  }
  checkDatabase(path.join(data, "dashcam.db"));
  return manifest;
}

export async function restoreBundle(directory: string, destination: string): Promise<void> {
  const manifest = await verifyBundle(directory);
  destination = path.resolve(destination);
  if (destination !== manifest.source) throw Error("資料庫含絕對媒體路徑，請還原至原始資料路徑");
  await fs.mkdir(destination, { mode: 0o700 }); // Existing data must be moved aside by the operator.
  for (const name of await fs.readdir(path.join(directory, "data"))) {
    await fs.cp(path.join(directory, "data", name), path.join(destination, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  checkDatabase(path.join(destination, "dashcam.db"));
}
