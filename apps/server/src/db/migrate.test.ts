import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client.ts";
import { resolveMigrationsFolder, runMigrations } from "./migrate.ts";
import {
  assignments,
  courses,
  ink,
  questions,
  students,
  units,
} from "./schema";
import { makeMigrationsFolderUpTo } from "./test-utils.ts";

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
  /** T6R.2 前最后一个迁移的 tag（0021 创建题目草稿四表） */
  const PRE_T6R2_LAST_TAG = "0020_chubby_silver_fox";

  /** 四表存在断言（空库/存量库两用例共用） */
  function expectNoteTablesExist(db: ReturnType<typeof createDb>): void {
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
  }

  /**
   * 在 T6R.2 之前的存量库上插入业务数据（attempts/responses/ink 等）。
   * 库本身由 makeMigrationsFolderUpTo(PRE_T6R2_LAST_TAG) 的截断迁移目录建出
   * （backfill.test.ts 既有惯例：journal 天然只到边界）。**attempts 行用原生
   * SQL 插入**——drizzle 绑定当前 schema，T6R.3 起含 frozen_at 等截断旧表
   * 没有的列；ink 等未改列的表继续走 drizzle。
   */
  function seedLegacyData(db: ReturnType<typeof createDb>): {
    attemptId: string;
    questionId: string;
  } {
    // 存量夹具：教师 → 学生 → 课程 → 单元 → 题目 → 作业 → attempt → response → ink。
    // units/questions 虽无外键依赖（0021 纯 CREATE 不触旧表），保留完整业务链
    // 是为了让「带真实形态数据的库」更贴近存量库（边界库夹具，非断言消费）
    const now = new Date().toISOString();
    const teacherId = randomUUID();
    // 教师行走原生 SQL（同 attempts 的既有惯例）：drizzle 绑定当前 schema，
    // 边界库的 teachers 表还没有后续迁移新增的列（T7.7 capability_profile_json）
    db.$client
      .prepare(
        "INSERT INTO teachers (id, login_name, is_admin, disabled_at, password_hash, api_token, created_at) VALUES (?, 'teacher', 1, NULL, 'scrypt$模拟哈希', NULL, ?)",
      )
      .run(teacherId, now);
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
    // T6R.3：attempts/responses 用原生 SQL（截断旧库没有 frozen_at/
    // legacy_unverified（attempts）与 unit_id（responses）等后续迁移列）
    db.$client
      .prepare(
        `INSERT INTO attempts (id, student_id, source_type, assignment_id, course_id, unit_id, attempt_no, status, started_at, submitted_at, active_sec, device, score_auto, score_final)
         VALUES (?, ?, 'assignment', ?, ?, ?, 1, 'draft', ?, NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(attemptId, studentId, assignmentId, courseId, unitId, now);
    db.$client
      .prepare(
        `INSERT INTO responses (id, attempt_id, question_id, question_version, question_snapshot_json, answer_json, auto_correct, final_correct, teacher_mark, teacher_comment, active_sec, hints_used, hints_opened_json, change_count, ink_id)
         VALUES (?, ?, ?, 3, '{"id":"练习四-1","type":"judge"}', '{"kind":"judge","value":true}', NULL, NULL, NULL, NULL, NULL, 0, NULL, 2, NULL)`,
      )
      .run(randomUUID(), attemptId, questionId);
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
    expectNoteTablesExist(db);
    const rows = db.$client
      .prepare("SELECT count(*) AS n FROM __drizzle_migrations")
      .get() as { n: number };
    expect(rows.n).toBe(countJournalEntries());
    db.$client.close();
  });

  it("带存量 attempts/responses/ink 的库上迁移成功：存量数据完好、外键干净、幂等", () => {
    const db = createDb(join(dir, "legacy.db"));
    // 截断迁移目录建出 T6R.2 前的旧结构（真实 0000–0020 迁移链）
    migrate(db, {
      migrationsFolder: makeMigrationsFolderUpTo(PRE_T6R2_LAST_TAG),
    });
    const seeded = seedLegacyData(db);

    // 模拟旧库启动：补应用 0021（题目草稿四表）
    expect(() => runMigrations(db)).not.toThrow();

    expectNoteTablesExist(db);

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
    // T6R.3（0022）：存量 attempts 行补冻结列默认值——未冻结、非 legacy
    // （升级前已交卷的行沿用交卷快照；进行中行由服务层懒冻结，见 attempt-service）
    const attemptRow = db.$client
      .prepare("SELECT frozen_at, legacy_unverified FROM attempts WHERE id = ?")
      .get(seeded.attemptId) as {
      frozen_at: string | null;
      legacy_unverified: number;
    };
    expect(attemptRow.frozen_at).toBeNull();
    expect(attemptRow.legacy_unverified).toBe(0);
    // T6R.3（0023）：存量 responses 行的冻结单元归属列补 NULL（升级遗留，
    // 读路径按域内 join 兜底分组）
    const responseRow = db.$client
      .prepare("SELECT unit_id FROM responses WHERE attempt_id = ?")
      .get(seeded.attemptId) as { unit_id: string | null };
    expect(responseRow.unit_id).toBeNull();
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

describe("T6R.15 迁移：notes 封存与反思列（空库与存量库兼容）", () => {
  /** T6R.15 前最后一个迁移 tag（0025） */
  const PRE_T6R15_LAST_TAG = "0025_secret_shiva";
  /** 本次新增的 notes 三列（订正检查点封存 + 两段反思文本） */
  const NEW_COLUMNS = [
    "sealed_at",
    "reflection_stuck_at",
    "reflection_error_cause",
  ] as const;

  function noteColumnNames(db: ReturnType<typeof createDb>): string[] {
    return (
      db.$client.prepare("PRAGMA table_info(notes)").all() as Array<{
        name: string;
      }>
    ).map((col) => col.name);
  }

  /**
   * 在 0025 边界库上种入一条 notes 行（含归属链 teachers→students→attempts，
   * 原生 SQL 直插——与 T6R.2 用例同口径贴近存量升级形态；wrong 来源的
   * attempt 三外键全可空，夹具最小）。
   */
  function seedNotesRow(db: ReturnType<typeof createDb>): string {
    const now = new Date().toISOString();
    const teacherId = randomUUID();
    db.$client
      .prepare(
        "INSERT INTO teachers (id, login_name, is_admin, created_at) VALUES (?, 'teacher15', 1, ?)",
      )
      .run(teacherId, now);
    const studentId = randomUUID();
    db.$client
      .prepare(
        "INSERT INTO students (id, teacher_id, display_name, login_name, link_token, created_at) VALUES (?, ?, '李四', '李四', ?, ?)",
      )
      .run(studentId, teacherId, `link-${randomUUID()}`, now);
    const attemptId = randomUUID();
    db.$client
      .prepare(
        "INSERT INTO attempts (id, student_id, source_type, attempt_no, status, started_at) VALUES (?, ?, 'wrong', 1, 'submitted', ?)",
      )
      .run(attemptId, studentId, now);
    const noteId = randomUUID();
    db.$client
      .prepare(
        "INSERT INTO notes (id, attempt_id, question_id, question_revision_id, phase, current_revision, current_version_id, server_saved_at, updated_at) VALUES (?, ?, 'q-15', 'qrev-15', 'scratch', 0, NULL, NULL, ?)",
      )
      .run(noteId, attemptId, now);
    return noteId;
  }

  it("空库（全新文件库）迁移后 notes 含三新列，迁移记录与 journal 一致", () => {
    const db = createDb(join(dir, "fresh15.db"));
    runMigrations(db);
    const names = noteColumnNames(db);
    for (const col of NEW_COLUMNS) {
      expect(names, `notes 应含新列 ${col}`).toContain(col);
    }
    const rows = db.$client
      .prepare("SELECT count(*) AS n FROM __drizzle_migrations")
      .get() as { n: number };
    expect(rows.n).toBe(countJournalEntries());
    db.$client.close();
  });

  it("带 notes 存量行的库迁移：存量行完好、三新列为 NULL、可写入封存形态、幂等", () => {
    const db = createDb(join(dir, "legacy15.db"));
    // 截断迁移目录建出 T6R.15 前的旧结构（真实 0000–0025 迁移链）
    migrate(db, {
      migrationsFolder: makeMigrationsFolderUpTo(PRE_T6R15_LAST_TAG),
    });
    const noteId = seedNotesRow(db);
    // 锁定边界：0025 的 notes 确实没有三新列（升级路径真实存在）
    const before = noteColumnNames(db);
    for (const col of NEW_COLUMNS) {
      expect(before).not.toContain(col);
    }

    // 模拟旧库启动：补应用 T6R.15 迁移
    expect(() => runMigrations(db)).not.toThrow();

    // 存量行完好，三新列补 NULL
    const row = db.$client
      .prepare("SELECT * FROM notes WHERE id = ?")
      .get(noteId) as Record<string, unknown>;
    expect(row.question_id).toBe("q-15");
    expect(row.phase).toBe("scratch");
    for (const col of NEW_COLUMNS) {
      expect(row[col]).toBeNull();
    }
    // 新列可写（订正封存形态落列）
    db.$client
      .prepare(
        "UPDATE notes SET sealed_at = ?, reflection_stuck_at = ?, reflection_error_cause = ? WHERE id = ?",
      )
      .run("2026-10-07T01:00:00.000Z", "卡点", "错因", noteId);
    const updated = db.$client
      .prepare(
        "SELECT sealed_at, reflection_stuck_at, reflection_error_cause FROM notes WHERE id = ?",
      )
      .get(noteId) as Record<string, string | null>;
    expect(updated.sealed_at).toBe("2026-10-07T01:00:00.000Z");
    expect(updated.reflection_stuck_at).toBe("卡点");
    expect(updated.reflection_error_cause).toBe("错因");
    // 外键完整性干净；再次迁移幂等
    expect(db.$client.pragma("foreign_key_check")).toHaveLength(0);
    expect(() => runMigrations(db)).not.toThrow();
    db.$client.close();
  });
});
