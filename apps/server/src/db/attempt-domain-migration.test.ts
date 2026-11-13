import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, it } from "vitest";
import { createDb } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { makeMigrationsFolderUpTo } from "./test-utils.ts";

it("升级保留历史异常行，新冻结卷的非法归属和协议不能写入", () => {
  const db = createDb(":memory:");
  try {
    migrate(db, {
      migrationsFolder: makeMigrationsFolderUpTo("0062_wise_lethal_legion"),
    });
    const insert = db.$client.prepare(`
      INSERT INTO attempts (id, student_id, source_type, status, started_at, frozen_at, practice_workflow_version)
      VALUES (?, 'student', ?, 'draft', '2026-10-01', '2026-10-01', ?)
    `);
    db.$client
      .prepare(
        "INSERT INTO students (id, display_name, login_name, link_token, created_at) VALUES ('student', '学生', 'student', 'token', '2026-10-01')",
      )
      .run();
    insert.run("old-orphan", "assignment", 1);
    runMigrations(db);
    expect(db.$client.prepare("SELECT id FROM attempts").pluck().all()).toEqual(
      ["old-orphan"],
    );
    insert.run("new-orphan", "assignment", null);
    insert.run("new-invalid-protocol", "wrong", 1);
    insert.run("new-valid", "wrong", null);
    const markFrozen = db.$client.prepare(
      "INSERT INTO attempt_context_freezes (attempt_id, frozen_at) VALUES (?, '2026-10-01')",
    );
    expect(() => markFrozen.run("new-orphan")).toThrow("作答归属无效");
    expect(() => markFrozen.run("new-invalid-protocol")).toThrow(
      "作答协议无效",
    );
    expect(() => markFrozen.run("new-valid")).not.toThrow();
    expect(() =>
      db.$client
        .prepare(
          "UPDATE attempts SET practice_workflow_version = 1 WHERE id = 'new-valid'",
        )
        .run(),
    ).toThrow("作答协议无效");
  } finally {
    db.$client.close();
  }
});
