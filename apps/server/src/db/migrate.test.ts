import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { resolveMigrationsFolder, runMigrations } from "./migrate";
import {
  assignments,
  attempts,
  courses,
  ink,
  questions,
  responses,
  students,
  teachers,
  units,
} from "./schema";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tutor-t05-migrate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 期望的迁移条数：直接读迁移目录的 journal，后续任务追加迁移不需要回来改这里 */
function countJournalEntries(): number {
  const journal = JSON.parse(
    readFileSync(
      join(resolveMigrationsFolder(), "meta", "_journal.json"),
      "utf8",
    ),
  ) as { entries: unknown[] };
  return journal.entries.length;
}

describe("runMigrations（幂等）", () => {
  it("对同一文件库连续执行两次迁移不报错，且迁移记录不重复", () => {
    const db = createDb(join(dir, "tutor.db"));
    runMigrations(db);
    // 第二次启动路径：已应用的迁移应被跳过，不抛错
    runMigrations(db);

    const rows = db.$client
      .prepare("SELECT count(*) AS n FROM __drizzle_migrations")
      .get() as { n: number };
    expect(rows.n).toBe(countJournalEntries());

    const tables = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('teachers', 'sessions')",
      )
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(2);
    db.$client.close();
  });
});

describe("T6R.2 迁移：空库与带存量库", () => {
  /** journal 条目最小形状（定位新迁移用） */
  interface JournalEntry {
    idx: number;
    when: number;
    tag: string;
  }

  function journalEntries(): JournalEntry[] {
    const journal = JSON.parse(
      readFileSync(
        join(resolveMigrationsFolder(), "meta", "_journal.json"),
        "utf8",
      ),
    ) as { entries: JournalEntry[] };
    return journal.entries;
  }

  /** 找到创建 notes 表的迁移（从最新往回扫；本任务新增迁移是唯一命中） */
  function notesMigrationEntry(): JournalEntry {
    const entries = journalEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry === undefined) {
        continue;
      }
      const sql = readFileSync(
        join(resolveMigrationsFolder(), `${entry.tag}.sql`),
        "utf8",
      );
      // drizzle-kit 生成反引号，历史迁移有双引号——两种都兼容
      if (/CREATE TABLE [`"]notes[`"]/.test(sql)) {
        return entry;
      }
    }
    throw new Error("journal 中未找到创建 notes 表的迁移（T6R.2）");
  }

  /**
   * 模拟 T6R.2 之前的存量库：全量迁移后撤销新迁移（按依赖序 drop 四表 +
   * 删除其 __drizzle_migrations 记账行，created_at 与 journal.when 对齐），
   * 然后插入存量业务数据（attempts/responses/ink 等），再 runMigrations
   * 让新迁移在带数据的库上真实执行一遍。
   */
  function revertNotesMigrationAndSeedLegacy(db: ReturnType<typeof createDb>): {
    attemptId: string;
    questionId: string;
  } {
    const entry = notesMigrationEntry();
    // 子表在前（外键依赖序）
    for (const table of [
      "submission_evidence",
      "note_images",
      "note_versions",
      "notes",
    ]) {
      db.$client.exec(`DROP TABLE IF EXISTS "${table}"`);
    }
    db.$client
      .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
      .run(entry.when);

    // 存量夹具：教师 → 学生 → 课程 → 单元 → 题目 → 作业 → attempt → response → ink
    const now = new Date().toISOString();
    const teacherId = randomUUID();
    db.insert(teachers)
      .values({
        id: teacherId,
        loginName: "teacher",
        isAdmin: true,
        disabledAt: null,
        passwordHash: "scrypt$模拟哈希",
        apiToken: null,
        createdAt: now,
      })
      .run();
    const studentId = randomUUID();
    db.insert(students)
      .values({
        id: studentId,
        teacherId,
        displayName: "张三",
        loginName: "张三",
        passwordHash: null,
        linkToken: `link-${randomUUID()}`,
        linkEnabled: true,
        passwordEnabled: false,
        note: null,
        archivedAt: null,
        createdAt: now,
      })
      .run();
    const courseId = randomUUID();
    db.insert(courses)
      .values({
        id: courseId,
        teacherId,
        title: "初一上",
        order: 0,
        archivedAt: null,
        description: null,
        createdAt: now,
      })
      .run();
    const unitId = "unit-练习四";
    db.insert(units)
      .values({
        id: unitId,
        teacherId,
        courseId: null,
        folderId: null,
        lectureId: null,
        title: "练习四",
        topic: null,
        order: 0,
        updatedAt: now,
        deletedAt: null,
      })
      .run();
    const questionId = "练习四-1";
    db.insert(questions)
      .values({
        id: questionId,
        teacherId,
        unitId,
        order: 0,
        type: "judge",
        difficulty: 1,
        stemMd: "题干 [[正确]]",
        optionsJson: null,
        answersJson: '{"kind":"judge","value":true}',
        hintsJson: "[]",
        solutionMd: null,
        sourceMd: "::::question{type=judge difficulty=1}\n题干 [[正确]]\n::::",
        version: 3,
        updatedAt: now,
        deletedAt: null,
      })
      .run();
    const assignmentId = randomUUID();
    db.insert(assignments)
      .values({
        id: assignmentId,
        teacherId,
        unitId: null,
        courseId,
        title: "练习四",
        dueAt: null,
        answerRelease: "on_submit",
        deletedAt: null,
        createdAt: now,
      })
      .run();
    const attemptId = randomUUID();
    db.insert(attempts)
      .values({
        id: attemptId,
        studentId,
        sourceType: "assignment",
        assignmentId,
        courseId,
        unitId,
        attemptNo: 1,
        status: "draft",
        startedAt: now,
        submittedAt: null,
        activeSec: null,
        device: null,
        scoreAuto: null,
        scoreFinal: null,
      })
      .run();
    db.insert(responses)
      .values({
        id: randomUUID(),
        attemptId,
        questionId,
        questionVersion: 3,
        questionSnapshotJson: '{"id":"练习四-1","type":"judge"}',
        answerJson: '{"kind":"judge","value":true}',
        autoCorrect: null,
        finalCorrect: null,
        teacherMark: null,
        teacherComment: null,
        activeSec: null,
        hintsUsed: 0,
        hintsOpenedJson: null,
        changeCount: 2,
        inkId: null,
      })
      .run();
    db.insert(ink)
      .values({
        id: randomUUID(),
        attemptId,
        questionId,
        strokesPath: `blobs/ink/${attemptId}/${encodeURIComponent(questionId)}.json.gz`,
        pngPath: `blobs/ink/${attemptId}/${encodeURIComponent(questionId)}.png`,
        width: 1000,
        height: 800,
        strokeCount: 5,
        updatedAt: now,
      })
      .run();
    return { attemptId, questionId };
  }

  it("空库（全新文件库）迁移后四表存在且迁移记录与 journal 一致", () => {
    const db = createDb(join(dir, "fresh.db"));
    runMigrations(db);
    const tables = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('notes','note_versions','note_images','submission_evidence') ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((r) => r.name)).toEqual([
      "note_images",
      "note_versions",
      "notes",
      "submission_evidence",
    ]);
    const rows = db.$client
      .prepare("SELECT count(*) AS n FROM __drizzle_migrations")
      .get() as { n: number };
    expect(rows.n).toBe(countJournalEntries());
    db.$client.close();
  });

  it("带存量 attempts/responses/ink 的库上迁移成功：存量数据完好、外键干净、幂等", () => {
    const db = createDb(join(dir, "legacy.db"));
    runMigrations(db);
    const seeded = revertNotesMigrationAndSeedLegacy(db);

    // 模拟旧库启动：只应用被撤销的 notes 迁移
    expect(() => runMigrations(db)).not.toThrow();

    const tables = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('notes','note_versions','note_images','submission_evidence') ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((r) => r.name)).toEqual([
      "note_images",
      "note_versions",
      "notes",
      "submission_evidence",
    ]);

    // 存量数据完好
    expect(
      db.$client.prepare("SELECT count(*) AS n FROM attempts").get(),
    ).toMatchObject({ n: 1 });
    expect(
      db.$client.prepare("SELECT count(*) AS n FROM responses").get(),
    ).toMatchObject({ n: 1 });
    expect(
      db.$client.prepare("SELECT count(*) AS n FROM ink").get(),
    ).toMatchObject({ n: 1 });
    // 新表可直接写入并引用存量 attempt（外键生效）
    db.$client
      .prepare(
        "INSERT INTO notes (id, attempt_id, question_id, question_revision_id, phase, current_revision, current_version_id, server_saved_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        seeded.attemptId,
        seeded.questionId,
        `${seeded.questionId}@3`,
        "scratch",
        0,
        null,
        null,
        new Date().toISOString(),
      );

    // 外键完整性干净；再次迁移幂等
    expect(db.$client.pragma("foreign_key_check")).toHaveLength(0);
    expect(() => runMigrations(db)).not.toThrow();
    db.$client.close();
  });
});
