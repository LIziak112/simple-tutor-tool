import { rmSync } from "node:fs";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, it } from "vitest";
import { backfillAttemptSettlements } from "./backfill-attempt-settlements.ts";
import { createDb } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { makeMigrationsFolderUpTo } from "./test-utils.ts";

it("0066旧库追加迁移保留所有旧列/rowid/index/trigger，完成卷读取及回填兼容", () => {
  const db = createDb(":memory:");
  const prefix = makeMigrationsFolderUpTo("0066_lonely_captain_midlands");
  try {
    migrate(db, { migrationsFolder: prefix });
    db.$client.exec(`INSERT INTO students(id,display_name,login_name,link_token,created_at) VALUES('s','学生','s','s','2026-01-01');
    INSERT INTO attempts(id,student_id,source_type,status,started_at,submitted_at) VALUES('a','s','wrong','graded','2026-01-01T00:00:00.000Z','2026-01-01T00:01:00.000Z');
    INSERT INTO responses(rowid,id,attempt_id,question_id) VALUES(7,'r1','a','q1'),(29,'r2','a','q2');`);
    const before = db.$client
      .prepare("SELECT rowid,* FROM responses ORDER BY rowid")
      .all();
    const metadata = db.$client
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE tbl_name='responses' AND type IN ('index','trigger') ORDER BY name",
      )
      .all();
    runMigrations(db);
    backfillAttemptSettlements(db, new Date("2026-11-01T00:00:00.000Z"));
    expect(
      db.$client.prepare("SELECT rowid,* FROM responses ORDER BY rowid").all(),
    ).toEqual(before.map((r) => ({ ...(r as object), settlement_seq: 1 })));
    const afterMeta = db.$client
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE tbl_name='responses' AND type IN ('index','trigger') ORDER BY name",
      )
      .all();
    expect(afterMeta).toEqual(expect.arrayContaining(metadata));
    const changes = db.$client.prepare("SELECT total_changes()").pluck().get();
    runMigrations(db);
    backfillAttemptSettlements(db, new Date());
    expect(db.$client.prepare("SELECT total_changes()").pluck().get()).toBe(
      changes,
    );
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    expect(db.$client.pragma("integrity_check", { simple: true })).toBe("ok");
  } finally {
    db.$client.close();
    rmSync(prefix, { recursive: true, force: true });
  }
});
