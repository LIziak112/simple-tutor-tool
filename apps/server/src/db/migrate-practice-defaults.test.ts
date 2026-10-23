import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { makeMigrationsFolderUpTo } from "./test-utils.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tutor-m5d1-migrate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * M5-D1 迁移（0039：units.practice_defaults_json 新列）前的边界。
 * 存量夹具走原生 SQL 明确旧列——drizzle 绑定当前 schema，向截断旧表插含
 * 新列的行会越过本迁移要验证的缺省行为。
 */
const PRE_M5D1_LAST_TAG = "0038_youthful_harrier";

describe("M5-D1 迁移 0039：units.practice_defaults_json 缺省与存量兼容", () => {
  it("存量库升级：units 新列 NULL 缺省（无推荐），存量行完好且幂等", () => {
    const db = createDb(join(dir, "legacy.db"));
    migrate(db, {
      migrationsFolder: makeMigrationsFolderUpTo(PRE_M5D1_LAST_TAG),
    });
    const now = new Date().toISOString();
    db.$client
      .prepare(
        `INSERT INTO units (id, teacher_id, title, topic, "order", updated_at, deleted_at)
         VALUES ('unit-legacy', 'teacher-legacy', '存量单元', NULL, 0, ?, NULL)`,
      )
      .run(now);

    expect(() => runMigrations(db)).not.toThrow();

    const unit = db.$client
      .prepare(
        "SELECT title, practice_defaults_json AS practice FROM units WHERE id = 'unit-legacy'",
      )
      .get() as { title: string; practice: string | null };
    expect(unit.title).toBe("存量单元");
    expect(unit.practice).toBeNull();

    // 再跑一次不报错（幂等）
    expect(() => runMigrations(db)).not.toThrow();
    db.$client.close();
  });

  it("空库直接迁到最新后新列存在（NULL 可空，语义同 teaching_pack_json 先例）", () => {
    const db = createDb(join(dir, "fresh.db"));
    runMigrations(db);
    const col = db.$client
      .prepare(
        "SELECT name, \"notnull\" AS notNullFlag FROM pragma_table_info('units') WHERE name = 'practice_defaults_json'",
      )
      .get() as { name: string; notNullFlag: number } | undefined;
    expect(col).toBeDefined();
    expect(col?.notNullFlag).toBe(0);
    db.$client.close();
  });
});
