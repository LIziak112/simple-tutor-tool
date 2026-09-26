import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { runMigrations } from "./migrate";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tutor-t05-migrate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runMigrations（幂等）", () => {
  it("对同一文件库连续执行两次迁移不报错，且迁移记录不重复", () => {
    const db = createDb(join(dir, "tutor.db"));
    runMigrations(db);
    // 第二次启动路径：已应用的迁移应被跳过，不抛错
    runMigrations(db);

    const rows = db.$client
      .prepare("SELECT count(*) AS n FROM __drizzle_migrations")
      .get() as { n: number };
    expect(rows.n).toBe(1);

    const tables = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('teachers', 'sessions')",
      )
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(2);
    db.$client.close();
  });
});
