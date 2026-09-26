import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loginFailures, sessions, students, teachers } from "./schema";
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

describe("students 表（T2.1 学生账号）", () => {
  /** 一条可直接落库的学生行（linkToken/loginName 均唯一） */
  function studentRow(overrides: Partial<typeof students.$inferInsert> = {}) {
    return {
      id: randomUUID(),
      displayName: "张三",
      loginName: "张三",
      passwordHash: null,
      linkToken: `link-${randomUUID()}`,
      linkEnabled: true,
      passwordEnabled: false,
      note: null,
      archivedAt: null,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("迁移后 students 表存在，可原样读回（布尔列按 0/1 映射）", () => {
    const db = createTestDb();
    const tables = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'students'",
      )
      .all() as TableNameRow[];
    expect(tables.map((r) => r.name)).toEqual(["students"]);

    const row = studentRow();
    db.insert(students).values(row).run();
    expect(db.select().from(students).where(eq(students.id, row.id)).get()).toEqual(
      row,
    );
    db.$client.close();
  });

  it("loginName 与 linkToken 数据库层唯一（迁移生成的 UNIQUE 索引兜底）", () => {
    const db = createTestDb();
    const first = studentRow();
    db.insert(students).values(first).run();
    // 同 loginName 不同 id → 违反唯一约束
    expect(() =>
      db.insert(students).values(studentRow({ loginName: first.loginName })).run(),
    ).toThrow();
    // 同 linkToken 不同 loginName → 同样违反
    expect(() =>
      db
        .insert(students)
        .values(studentRow({ loginName: "李四", linkToken: first.linkToken }))
        .run(),
    ).toThrow();
    db.$client.close();
  });
});

describe("login_failures 表（T1.9 登录限流）", () => {
  it("迁移后 login_failures 表存在，可按 key 读写计数行", () => {
    const db = createTestDb();
    const tables = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'login_failures'",
      )
      .all() as TableNameRow[];
    expect(tables.map((r) => r.name)).toEqual(["login_failures"]);

    const row = {
      key: "name:teacher",
      count: 3,
      lockedUntil: new Date(Date.now() + 600_000).toISOString(),
    };
    db.insert(loginFailures).values(row).run();
    expect(
      db
        .select()
        .from(loginFailures)
        .where(eq(loginFailures.key, row.key))
        .get(),
    ).toEqual(row);
    db.$client.close();
  });
});
