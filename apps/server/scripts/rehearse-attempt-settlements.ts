import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { runBackfills } from "../src/db/backfill.ts";
import { createDb } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { backfillSubmissionTime } from "../src/services/backfill-submission-time.ts";

const { values } = parseArgs({
  options: { db: { type: "string" }, output: { type: "string" } },
});
if (!values.db || !values.output)
  throw new Error("需要 --db 只读原件和 --output 新副本，禁止原地执行");
const sourcePath = resolve(values.db),
  output = resolve(values.output);
const hashOf = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const sourceHash = hashOf(sourcePath);
const source = new Database(sourcePath, {
  readonly: true,
  fileMustExist: true,
});
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
interface TableFacts {
  name: string;
  columns: string[];
  count: number;
  maxRowid: number;
  digest: string;
}

/** 对原始字节值做摘要；不解释、输出学生答案、题目或随笔正文。 */
function digestTable(
  db: Database.Database,
  name: string,
  columns: string[],
  maxRowid?: number,
) {
  const hash = createHash("sha256");
  const query = `SELECT rowid,${columns.map(quote).join(",")} FROM ${quote(name)} ${maxRowid === undefined ? "" : "WHERE rowid<=?"} ORDER BY rowid`;
  const statement = db.prepare(query).raw();
  for (const row of maxRowid === undefined
    ? statement.iterate()
    : statement.iterate(maxRowid))
    hash.update(JSON.stringify(row)).update("\n");
  return hash.digest("hex");
}
function inventory(db: Database.Database): TableFacts[] {
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pluck()
    .all() as string[];
  return names.map((name) => {
    const columns = (
      db.prepare(`PRAGMA table_info(${quote(name)})`).all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    const { count, maxRowid } = db
      .prepare(
        `SELECT count(*) AS count,coalesce(max(rowid),0) AS maxRowid FROM ${quote(name)}`,
      )
      .get() as { count: number; maxRowid: number };
    return {
      name,
      columns,
      count,
      maxRowid,
      digest: digestTable(db, name, columns),
    };
  });
}
const count = (db: Database.Database, query: string) =>
  db.prepare(query).pluck().get() as number;
const started = performance.now();
try {
  if (source.pragma("integrity_check", { simple: true }) !== "ok")
    throw new Error("源完整性检查失败");
  const original = inventory(source);
  const timeDryRun = backfillSubmissionTime(source);
  // wx 拒绝已有路径、硬链接、符号链接；backup 从只读连接生成独立新副本。
  closeSync(openSync(output, "wx", 0o600));
  await source.backup(output);
  const db = createDb(output);
  try {
    const timeApplied = backfillSubmissionTime(db.$client, { apply: true });
    const before = inventory(db.$client);
    const timeChangedTables = original
      .filter(
        (table) =>
          digestTable(db.$client, table.name, table.columns) !== table.digest,
      )
      .map((table) => table.name);
    const responseColumns = original
      .find((table) => table.name === "responses")
      ?.columns.filter((column) => column !== "active_sec");
    if (
      !responseColumns ||
      timeChangedTables.some((name) => name !== "responses") ||
      digestTable(source, "responses", responseColumns) !==
        digestTable(db.$client, "responses", responseColumns)
    )
      throw new Error("计时补缺改变了许可外的原字段或rowid");
    const sourceTimes = new Map(
      (
        source
          .prepare(
            "SELECT r.id,r.active_sec AS activeSec,a.status FROM responses r JOIN attempts a ON a.id=r.attempt_id",
          )
          .all() as { id: string; activeSec: number | null; status: string }[]
      ).map((row) => [row.id, row]),
    );
    let changedDraftTimes = 0;
    for (const row of db.$client
      .prepare("SELECT id,active_sec AS activeSec FROM responses")
      .all() as { id: string; activeSec: number | null }[]) {
      const old = sourceTimes.get(row.id);
      if (old && old.activeSec !== row.activeSec) {
        if (
          old.activeSec !== null ||
          old.status !== "draft" ||
          row.activeSec === null
        )
          throw new Error("计时补缺越过历史非空账或完成卷");
        changedDraftTimes++;
      }
    }
    const oldResponseMeta = db.$client
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE tbl_name='responses' AND type IN ('index','trigger') ORDER BY name",
      )
      .all();
    runMigrations(db);
    runBackfills(db);
    const altered = before
      .filter((table) => {
        const extensible = ["__drizzle_migrations", "data_migrations"].includes(
          table.name,
        );
        return (
          digestTable(
            db.$client,
            table.name,
            table.columns,
            extensible ? table.maxRowid : undefined,
          ) !== table.digest ||
          (!extensible &&
            count(db.$client, `SELECT count(*) FROM ${quote(table.name)}`) !==
              table.count)
        );
      })
      .map((table) => table.name);
    const currentMeta = db.$client
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE tbl_name='responses' AND type IN ('index','trigger') ORDER BY name",
      )
      .all();
    const oldResponseMetaPreserved = oldResponseMeta.every((item) =>
      currentMeta.some(
        (candidate) => JSON.stringify(candidate) === JSON.stringify(item),
      ),
    );
    const metrics = {
      completed: count(
        db.$client,
        "SELECT count(*) FROM attempts WHERE status IN ('submitted','graded')",
      ),
      finals: count(
        db.$client,
        "SELECT count(*) FROM attempt_settlements WHERE kind='final'",
      ),
      completedWithoutOneFinal: count(
        db.$client,
        "SELECT count(*) FROM attempts a WHERE status IN ('submitted','graded') AND (SELECT count(*) FROM attempt_settlements s WHERE s.attempt_id=a.id AND kind='final')<>1",
      ),
      draftFinals: count(
        db.$client,
        "SELECT count(*) FROM attempt_settlements s JOIN attempts a ON a.id=s.attempt_id WHERE a.status='draft'",
      ),
      unassignedCompletedRows: count(
        db.$client,
        "SELECT count(*) FROM responses r JOIN attempts a ON a.id=r.attempt_id WHERE a.status IN ('submitted','graded') AND r.settlement_seq IS NULL",
      ),
      danglingMembership: count(
        db.$client,
        "SELECT count(*) FROM responses r WHERE settlement_seq IS NOT NULL AND NOT EXISTS(SELECT 1 FROM attempt_settlements s WHERE s.attempt_id=r.attempt_id AND s.seq=r.settlement_seq)",
      ),
      wrongCounts: count(
        db.$client,
        "SELECT count(*) FROM attempt_settlements s WHERE question_count<>(SELECT count(*) FROM responses r WHERE r.attempt_id=s.attempt_id AND r.settlement_seq=s.seq)",
      ),
      wrongTimes: count(
        db.$client,
        "SELECT count(*) FROM attempt_settlements s WHERE active_sec IS NOT (SELECT sum(active_sec) FROM responses r WHERE r.attempt_id=s.attempt_id AND r.settlement_seq=s.seq)",
      ),
      wrongCreatedAt: count(
        db.$client,
        "SELECT count(*) FROM attempt_settlements s JOIN attempts a ON a.id=s.attempt_id WHERE s.kind='final' AND s.created_at IS NOT a.submitted_at",
      ),
      zeroQuestionFinals: count(
        db.$client,
        "SELECT count(*) FROM attempt_settlements WHERE kind='final' AND question_count=0",
      ),
      missingSnapshotCompletedRows: count(
        db.$client,
        "SELECT count(*) FROM responses r JOIN attempts a ON a.id=r.attempt_id WHERE a.status IN ('submitted','graded') AND ownclass_question_snapshot_valid(r.question_snapshot_json)=0",
      ),
      abandonedCompleted: count(
        db.$client,
        "SELECT count(*) FROM attempts WHERE status IN ('submitted','graded') AND abandoned_at IS NOT NULL",
      ),
      completedWithoutTime: count(
        db.$client,
        "SELECT count(*) FROM attempts WHERE status IN ('submitted','graded') AND active_sec IS NULL",
      ),
    };
    const changes = count(db.$client, "SELECT total_changes()");
    const secondTime = backfillSubmissionTime(db.$client, { apply: true });
    runMigrations(db);
    runBackfills(db);
    const secondWrites = count(db.$client, "SELECT total_changes()") - changes;
    const foreignKeys = db.$client.pragma("foreign_key_check") as unknown[];
    const integrity = db.$client.pragma("integrity_check", { simple: true });
    if (
      altered.length ||
      !oldResponseMetaPreserved ||
      secondWrites ||
      foreignKeys.length ||
      integrity !== "ok" ||
      metrics.completed !== metrics.finals ||
      metrics.completedWithoutOneFinal ||
      metrics.draftFinals ||
      metrics.unassignedCompletedRows ||
      metrics.danglingMembership ||
      metrics.wrongCounts ||
      metrics.wrongTimes ||
      metrics.wrongCreatedAt
    )
      throw new Error(
        `结算副本校验失败：${JSON.stringify({ altered, oldResponseMetaPreserved, secondWrites, foreignKeyViolations: foreignKeys.length, integrity, metrics })}`,
      );
    if (hashOf(sourcePath) !== sourceHash) throw new Error("源原件哈希变化");
    console.log(
      JSON.stringify(
        {
          sourceSha256: sourceHash,
          sourceBytes: statSync(sourcePath).size,
          sourceMode: (statSync(sourcePath).mode & 0o777).toString(8),
          originalTables: original.length,
          originalRows: original.reduce((n, t) => n + t.count, 0),
          oldColumnsAndRowidsUnchanged: true,
          changedDraftTimes,
          timeOnlyNullDraftRowsChanged: true,
          oldResponseMetaPreserved,
          migrationBefore: original.find(
            (t) => t.name === "__drizzle_migrations",
          )?.count,
          migrationAfter: count(
            db.$client,
            "SELECT count(*) FROM __drizzle_migrations",
          ),
          timeDryRun,
          timeApplied,
          secondTime,
          secondWrites,
          foreignKeyViolations: foreignKeys.length,
          integrity,
          metrics,
          elapsedMs: Math.round(performance.now() - started),
        },
        null,
        2,
      ),
    );
  } finally {
    db.$client.close();
  }
} finally {
  source.close();
}
