import DatabaseCtor, { type Database } from "better-sqlite3";
import { createDb } from "../db/client.ts";

const [filename, timeout] = process.argv.slice(2);
if (!filename) throw new Error("缺少待打开的备份文件");

const pragma = DatabaseCtor.prototype.pragma;
let attempts = 0;
let notified = false;
DatabaseCtor.prototype.pragma = function (this: Database, statement, options) {
  if (statement !== "journal_mode = WAL")
    return pragma.call(this, statement, options);
  if (attempts === 0 && timeout !== undefined)
    pragma.call(this, `busy_timeout = ${Number(timeout)}`);
  attempts += 1;
  const started = performance.now();
  try {
    return pragma.call(this, statement, options);
  } catch (error) {
    if (
      !notified &&
      error instanceof DatabaseCtor.SqliteError &&
      error.code === "SQLITE_BUSY"
    ) {
      notified = true;
      process.send?.({
        busy: error.code,
        elapsedMs: performance.now() - started,
      });
    }
    throw error;
  }
};

try {
  const { $client: sqlite } = createDb(filename);
  try {
    process.send?.({
      ok: true,
      journalMode: sqlite.pragma("journal_mode", { simple: true }),
      foreignKeys: sqlite.pragma("foreign_keys", { simple: true }),
      busyTimeout: sqlite.pragma("busy_timeout", { simple: true }),
      row: sqlite.prepare("SELECT value FROM backup_probe").pluck().get(),
    });
  } finally {
    sqlite.close();
  }
} catch (error) {
  if (!(error instanceof DatabaseCtor.SqliteError)) throw error;
  process.send?.({ ok: false, code: error.code, attempts });
} finally {
  process.disconnect();
}
