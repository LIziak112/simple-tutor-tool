import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sessions, teachers } from "./schema";
import { createTestDb } from "./test-utils";

/** sqlite_master 行的最小形状（建表元数据查询用） */
interface TableNameRow {
  name: string;
}

describe("createTestDb（内存库 + 迁移）", () => {
  it("迁移后 teachers 与 sessions 表存在", () => {
    const db = createTestDb();
    const rows = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('teachers', 'sessions') ORDER BY name",
      )
      .all() as TableNameRow[];
    expect(rows.map((r) => r.name)).toEqual(["sessions", "teachers"]);
    db.$client.close();
  });
});

describe("teachers / sessions 表读写", () => {
  it("插入一条 teacher 与一条 session 后可原样读回", () => {
    const db = createTestDb();
    const createdAt = new Date().toISOString();

    const teacher = {
      id: randomUUID(),
      passwordHash: "scrypt$模拟哈希",
      apiToken: null,
      createdAt,
    };
    db.insert(teachers).values(teacher).run();

    const session = {
      id: randomUUID(),
      subjectType: "teacher" as const,
      subjectId: teacher.id,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt,
    };
    db.insert(sessions).values(session).run();

    expect(
      db.select().from(teachers).where(eq(teachers.id, teacher.id)).get(),
    ).toEqual(teacher);
    expect(
      db.select().from(sessions).where(eq(sessions.id, session.id)).get(),
    ).toEqual(session);
    db.$client.close();
  });

  it("teachers 单行设计：无密码/Token 的初始行也能落库读回", () => {
    const db = createTestDb();
    const row = {
      id: randomUUID(),
      passwordHash: null,
      apiToken: null,
      createdAt: new Date().toISOString(),
    };
    db.insert(teachers).values(row).run();
    expect(db.select().from(teachers).get()).toEqual(row);
    db.$client.close();
  });
});
