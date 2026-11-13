import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readConfig } from "../src/config";
import { createDb } from "../src/db/client";
import * as schema from "../src/db/schema";
import { gcNoteVersions } from "../src/services/note-gc";

const { values } = parseArgs({
  options: {
    "apply-offline": { type: "boolean" },
  },
});
const apply = values["apply-offline"] === true;
const { dataDir } = readConfig();
const path = join(dataDir, "tutor.db");
if (!existsSync(path)) throw new Error("指定数据目录没有作答数据库");

// 盘点连接只读。回收应在停止服务及备份任务后执行。
const db = apply
  ? createDb(path)
  : drizzle(new Database(path, { readonly: true, fileMustExist: true }), {
      schema,
    });
try {
  const result = gcNoteVersions(db, dataDir, { dryRun: !apply });
  console.log(
    JSON.stringify({ mode: apply ? "回收" : "盘点", ...result }, null, 2),
  );
  if (
    result.fileFailures > 0 ||
    result.unreadableBackupDbs > 0 ||
    result.malformedBodyPaths > 0
  ) {
    process.exitCode = 1;
  }
} finally {
  db.$client.close();
}
