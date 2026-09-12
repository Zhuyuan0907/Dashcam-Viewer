import Database from "better-sqlite3";
import { DB_PATH } from "../config.js";
import { diagnostics } from "../diagnostics.js";

let db: Database.Database | undefined;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch {}
try {
  const result = await diagnostics(db);
  console.log(JSON.stringify({ ...result, database_present: !!db }, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} finally {
  db?.close();
}
