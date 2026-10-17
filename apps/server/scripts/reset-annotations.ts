import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { readConfig } from "../src/config";
import { createDb } from "../src/db/client";
import { resetDraftAttemptAnnotations } from "../src/services/annotation-reset";

/** 仅供停服维护；默认只盘点，执行必须提供已完成的一致性数据库备份。 */
const args = process.argv.slice(2);
const argumentValue = (flag: string) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const attemptId = argumentValue("--attempt");
if (!attemptId || !/^[a-f0-9-]{36}$/i.test(attemptId))
  throw new Error("请提供 --attempt UUID");
const dbPath = join(readConfig(process.env).dataDir, "tutor.db");
if (!existsSync(dbPath)) throw new Error("作答数据库不存在");
const inspect = (database: Database.Database) => ({
  attempt: database
    .prepare("SELECT status FROM attempts WHERE id=?")
    .get(attemptId),
  materials: database
    .prepare(
      "SELECT b.id AS base_id,b.question_id,b.created_at,b.image_hash,a.id AS annotation_id,a.revision,a.hash,coalesce(a.stroke_count,0) AS strokes FROM annotation_bases b LEFT JOIN annotations a ON a.base_id=b.id WHERE b.attempt_id=? AND b.phase='scratch' ORDER BY b.question_id",
    )
    .all(attemptId),
});
if (!args.includes("--execute")) {
  const database = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    console.log(JSON.stringify(inspect(database), null, 2));
  } finally {
    database.close();
  }
} else {
  const backupPath = argumentValue("--backup-db");
  const expectedBases = Number(argumentValue("--expected-bases"));
  const expectedStrokes = Number(argumentValue("--expected-strokes"));
  if (
    !backupPath ||
    resolve(backupPath) === resolve(dbPath) ||
    !existsSync(backupPath)
  )
    throw new Error("执行必须指定独立的 --backup-db 一致性备份");
  if (
    ![expectedBases, expectedStrokes].every(
      (number) => Number.isSafeInteger(number) && number >= 0,
    )
  )
    throw new Error("请提供盘点后的 --expected-bases 与 --expected-strokes");
  const backup = new Database(backupPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    if (backup.pragma("integrity_check", { simple: true }) !== "ok")
      throw new Error("备份完整性校验失败");
    const snapshot = inspect(backup);
    const live = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      if (JSON.stringify(inspect(live)) !== JSON.stringify(snapshot))
        throw new Error("备份与当前标画内容不一致，请重新备份");
    } finally {
      live.close();
    }
    if (snapshot.materials.length !== expectedBases || !snapshot.attempt)
      throw new Error("备份与盘点范围不一致");
  } finally {
    backup.close();
  }
  const db = createDb(dbPath);
  try {
    console.log(
      JSON.stringify(
        resetDraftAttemptAnnotations(db, attemptId, {
          expectedBases,
          expectedStrokes,
        }),
      ),
    );
  } finally {
    db.$client.close();
  }
}
