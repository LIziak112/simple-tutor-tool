import { rmSync } from "node:fs";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, it } from "vitest";
import { createDb } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { makeMigrationsFolderUpTo } from "./test-utils.ts";

it("追加v2三表保留所有旧行/索引/触发器，重复迁移零写入", () => {
  const db = createDb(":memory:");
  const prefix = makeMigrationsFolderUpTo("0070_attempt_time_guards");
  try {
    migrate(db, { migrationsFolder: prefix });
    db.$client.exec(`INSERT INTO students(id,display_name,login_name,link_token,created_at) VALUES('s','学生','s','s','2026-01-01');
      INSERT INTO attempts(id,student_id,source_type,status,started_at,submitted_at) VALUES('a','s','wrong','graded','2026-01-01T00:00:00.000Z','2026-01-01T00:01:00.000Z');
      INSERT INTO responses(rowid,id,attempt_id,question_id) VALUES(7,'r1','a','q1'),(29,'r2','a','q2');`);
    const tables = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name",
      )
      .all() as { name: string }[];
    const columns = new Map(
      tables.map(({ name }) => [
        name,
        (
          db.$client.prepare(`PRAGMA table_info("${name}")`).all() as {
            name: string;
          }[]
        )
          .map((row) => `"${row.name}"`)
          .join(","),
      ]),
    );
    const read = () =>
      tables.map(({ name }) => [
        name,
        db.$client
          .prepare(
            `SELECT rowid,${columns.get(name)} FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`,
          )
          .all(),
      ]);
    const rows = read();
    const metadata = db.$client
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE type IN ('index','trigger') ORDER BY name",
      )
      .all();
    runMigrations(db);
    expect(read()).toEqual(rows);
    expect(
      db.$client
        .prepare(
          "SELECT type,name,sql FROM sqlite_master WHERE type IN ('index','trigger') ORDER BY name",
        )
        .all(),
    ).toEqual(expect.arrayContaining(metadata));
    expect(
      db.$client
        .prepare("SELECT count(*) n FROM ai_review_v2_runs")
        .pluck()
        .get(),
    ).toBe(0);
    const before = db.$client.prepare("SELECT total_changes()").pluck().get();
    runMigrations(db);
    expect(db.$client.prepare("SELECT total_changes()").pluck().get()).toBe(
      before,
    );
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    expect(db.$client.pragma("integrity_check", { simple: true })).toBe("ok");
  } finally {
    db.$client.close();
    rmSync(prefix, { recursive: true, force: true });
  }
});
