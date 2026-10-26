import { expect, it } from "vitest";
import { createDb } from "./client";
import { runMigrations } from "./migrate";

it("已试用 PR16 的数据库合并 v2 后不重复建表且保留自定义提示词", () => {
  const db = createDb(":memory:");
  try {
    runMigrations(db);
    // 模拟合并前已执行的 PR16 迁移记录：迁移内容相同，原时间不能改变。
    const originalHash =
      "d2c82f5e6b3af6a31b9b7a116915b8a84ae94f1795a844ec71769cc2cbb90445";
    db.$client
      .prepare("UPDATE __drizzle_migrations SET created_at = ? WHERE hash = ?")
      .run(1792935275845, originalHash);
    db.$client
      .prepare(
        "INSERT INTO ai_prompt_overrides (owner_type, owner_id, slot_key, body, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "teacher",
        "migration-test",
        "content-ai-instruction",
        "保留已有提示词",
        "2026-10-26T00:00:00.000Z",
      );
    expect(() => runMigrations(db)).not.toThrow();
    expect(
      db.$client
        .prepare("SELECT body FROM ai_prompt_overrides WHERE owner_id = ?")
        .get("migration-test"),
    ).toEqual({ body: "保留已有提示词" });
    expect(
      db.$client
        .prepare(
          "SELECT count(*) AS n FROM __drizzle_migrations WHERE hash = ?",
        )
        .get(originalHash),
    ).toEqual({ n: 1 });
  } finally {
    db.$client.close();
  }
});
