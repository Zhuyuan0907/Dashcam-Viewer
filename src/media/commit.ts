/** Filesystem changes are recoverable until the SQLite metadata transaction commits. */
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { DB } from "../db.js";
import { withinTrips } from "../util/paths.js";

interface Replacement {
  target: string;
  staged: string;
  rollback: string;
}
async function rollback(entries: Replacement[]): Promise<void> {
  for (const e of entries) {
    if (!withinTrips(e.target) || !withinTrips(e.rollback))
      throw new Error("Invalid recovery path");
    // Copy rather than consume the backup: recovery itself may be interrupted.
    await fs.copyFile(e.rollback, e.target);
  }
}
async function clean(entries: Replacement[]): Promise<void> {
  for (const e of entries)
    for (const p of [e.rollback, e.staged]) {
      if (!withinTrips(p)) continue;
      await fs.rm(p, { force: true }).catch(() => {});
    }
}
export async function recoverMediaCommits(db: DB): Promise<number> {
  const rows = db.prepare("SELECT id, entries FROM media_commits").all() as {
    id: string;
    entries: string;
  }[];
  for (const row of rows) {
    const entries = JSON.parse(row.entries) as Replacement[];
    await rollback(entries);
    db.prepare("DELETE FROM media_commits WHERE id=?").run(row.id);
    await clean(entries);
  }
  return rows.length;
}
export async function commitMedia(
  db: DB,
  tripId: string,
  files: { target: string; staged: string }[],
  commit: () => void,
): Promise<void> {
  const id = randomUUID();
  const entries = files.map((e) => ({ ...e, rollback: `${e.target}.${id}.rollback` }));
  // Backups must all exist before any target is replaced.
  try {
    for (const e of entries) {
      if (!withinTrips(e.target) || !withinTrips(e.staged)) throw new Error("Invalid media path");
      await fs.copyFile(e.target, e.rollback);
    }
  } catch (error) {
    await clean(entries);
    throw error;
  }
  try {
    db.prepare("INSERT INTO media_commits(id, trip_id, entries) VALUES (?,?,?)").run(
      id,
      tripId,
      JSON.stringify(entries),
    );
  } catch (error) {
    await clean(entries);
    throw error;
  }
  try {
    for (const e of entries) await fs.rename(e.staged, e.target);
    db.transaction(() => {
      commit();
      db.prepare("DELETE FROM media_commits WHERE id=?").run(id);
    })();
  } catch (error) {
    // Failed recovery deliberately retains journal + backups for next startup.
    await rollback(entries);
    db.prepare("DELETE FROM media_commits WHERE id=?").run(id);
    await clean(entries);
    throw error;
  }
  await clean(entries);
}
