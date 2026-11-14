import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { backfillMemoMetadata } from "./backfill-memo-metadata.ts";
import { createDb } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { memos } from "./schema.ts";
import { makeMigrationsFolderUpTo } from "./test-utils.ts";

describe("0064历史库升级与随笔回填", () => {
  it("迁移与回填保留所有行，按学生连续编号，完成标记失败时整批回滚", () => {
    const db = createDb(":memory:");
    const prefix = makeMigrationsFolderUpTo("0064_lumpy_skullbuster");
    try {
      db.$client.pragma("foreign_keys = OFF");
      migrate(db, { migrationsFolder: prefix });
      db.$client.pragma("foreign_keys = ON");
      const insert = db.$client.prepare(
        "INSERT INTO memos(id, student_id, client_id, kind, text, anchor_json, tags_json, source, device, created_at, recorded_at) VALUES (?, ?, ?, 'text', '历史随笔', '{\"kind\":\"none\"}', '[]', 'self', 'desktop', ?, ?)",
      );
      for (const [studentId, at] of [
        ["old-a", "2026-01-02"],
        ["old-a", "2026-01-01"],
        ["old-b", "2026-01-01"],
      ])
        insert.run(
          randomUUID(),
          studentId,
          randomUUID(),
          `${at}T00:00:00.000Z`,
          `${at}T00:00:00.000Z`,
        );
      runMigrations(db);
      db.$client.exec(
        "CREATE TRIGGER fail_memo_marker BEFORE INSERT ON data_migrations WHEN NEW.key = 'session_context_memo_metadata_v1' BEGIN SELECT RAISE(ABORT, '模拟回填标记失败'); END",
      );
      expect(() => backfillMemoMetadata(db)).toThrow("模拟回填标记失败");
      expect(
        db
          .select()
          .from(memos)
          .all()
          .every((row) => row.seq === null),
      ).toBe(true);
      db.$client.exec("DROP TRIGGER fail_memo_marker");
      backfillMemoMetadata(db);
      const rows = db.select().from(memos).all();
      expect(rows).toHaveLength(3);
      expect(
        rows
          .filter((r) => r.studentId === "old-a")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((r) => r.seq),
      ).toEqual([1, 2]);
      expect(
        rows.filter((r) => r.studentId === "old-b").map((r) => r.seq),
      ).toEqual([1]);
      expect(
        rows.every((r) => r.deviceId === null && r.contextJson === null),
      ).toBe(true);
      backfillMemoMetadata(db);
      expect(db.select().from(memos).all()).toEqual(rows);
    } finally {
      db.$client.close();
      rmSync(prefix, { recursive: true, force: true });
    }
  });
});
