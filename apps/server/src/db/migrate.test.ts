import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sqliteAiPolicyConfigSource } from "../services/ai-companion/ai-policy-config-source.ts";
import { createDb } from "./client.ts";
import { resolveMigrationsFolder, runMigrations } from "./migrate.ts";
import {
  aiPolicyOverrides,
  aiTeacherSettings,
  courses,
  questions,
  students,
} from "./schema";
import { createTestDb, makeMigrationsFolderUpTo } from "./test-utils.ts";

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
    // 单元行同走原生 SQL（T7.8，同 teachers/attempts 惯例）：边界库的 units 表
    // 还没有 0029 新增的 teaching_pack_json 列
    db.$client
      .prepare(
        `INSERT INTO units (id, teacher_id, course_id, folder_id, lecture_id, title, topic, "order", updated_at, deleted_at)
         VALUES (?, ?, NULL, NULL, NULL, '练习四', NULL, 0, ?, NULL)`,
      )
      .run(unitId, teacherId, now);
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
    // assignments 同走原生 SQL（M1b 0038 前的旧库没有 allow_per_question_feedback
    // 列，Drizzle 表模型会给带默认值的新列显式赋值导致旧库插入失败）
    db.$client
      .prepare(
        `INSERT INTO assignments (id, teacher_id, unit_id, course_id, title, due_at, answer_release, deleted_at, created_at)
         VALUES (?, ?, NULL, ?, '练习四', NULL, 'on_submit', NULL, ?)`,
      )
      .run(assignmentId, teacherId, courseId, now);
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
    // 旧结构夹具必须按旧列写入，不能使用升级后的 Drizzle 表模型。
    db.$client
      .prepare(
        "INSERT INTO ink (id, attempt_id, question_id, strokes_path, png_path, width, height, stroke_count, updated_at) VALUES (?, ?, ?, ?, ?, 1000, 800, 5, ?)",
      )
      .run(
        randomUUID(),
        attemptId,
        questionId,
        `blobs/ink/${attemptId}/${encodeURIComponent(questionId)}.json.gz`,
        `blobs/ink/${attemptId}/${encodeURIComponent(questionId)}.png`,
        now,
      );
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
    expect(
      db.$client
        .prepare("SELECT revision, mutation_id, body_hash FROM ink")
        .get(),
    ).toEqual({ revision: 1, mutation_id: null, body_hash: null });
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

describe("SAI-05 迁移：学生端 AI 伴学九表（空库、存量库与临时数据目录往返）", () => {
  /** SAI-05 前最后一个迁移 tag（0035） */
  const PRE_SAI05_LAST_TAG = "0035_aspiring_logan";

  /** 九表名（存在性断言与升级检查共用） */
  const AI_TABLES = [
    "ai_connections",
    "ai_facts",
    "ai_messages",
    "ai_policy_overrides",
    "ai_quick_buttons",
    "ai_share_tickets",
    "ai_task_materials",
    "ai_tasks",
    "ai_teacher_settings",
  ] as const;

  function expectAiTablesExist(db: ReturnType<typeof createDb>): void {
    const tables = db.$client
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${AI_TABLES.map(() => "?").join(",")}) ORDER BY name`,
      )
      .all(...AI_TABLES) as Array<{ name: string }>;
    expect(tables.map((r) => r.name)).toEqual([...AI_TABLES]);
  }

  /**
   * 在 0035 边界库上种入存量业务数据（教师→学生→作业→attempt→response）。
   * 边界即当前库形态（仅缺 ai_* 九表），全部走 drizzle 当前表模型即可——
   * 不像 T6R.2 边界那样需要原生 SQL（那儿的边界库缺 frozen_at 等后续列）。
   */
  function seedPreAiData(db: ReturnType<typeof createDb>): {
    teacherId: string;
    studentId: string;
    assignmentId: string;
    attemptId: string;
    responseId: string;
  } {
    const now = new Date().toISOString();
    const teacherId = randomUUID();
    // teachers 走原生 SQL（M1b 0038 前的边界库没有 practice_feedback_policy
    // 列，Drizzle 当前表模型会带上该列导致旧库插入失败）
    db.$client
      .prepare(
        `INSERT INTO teachers (id, login_name, is_admin, disabled_at, password_hash, api_token, created_at)
         VALUES (?, 'teacher-ai', 0, NULL, NULL, NULL, ?)`,
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
    const assignmentId = randomUUID();
    // assignments 同走原生 SQL（M1b 0038 前的边界库没有
    // allow_per_question_feedback 列）
    db.$client
      .prepare(
        `INSERT INTO assignments (id, teacher_id, unit_id, course_id, title, due_at, answer_release, deleted_at, created_at)
         VALUES (?, ?, NULL, NULL, '练习四', NULL, 'on_submit', NULL, ?)`,
      )
      .run(assignmentId, teacherId, now);
    const attemptId = randomUUID();
    // attempts 同走原生 SQL（M1b 0038 前的边界库没有
    // practice_workflow_version/feedback_mode/workflow_revision 三列）
    db.$client
      .prepare(
        `INSERT INTO attempts (id, student_id, source_type, assignment_id, course_id, unit_id, lecture_id, attempt_no, status, started_at, submitted_at, frozen_at, legacy_unverified)
         VALUES (?, ?, 'assignment', ?, NULL, NULL, NULL, 1, 'draft', ?, NULL, ?, 0)`,
      )
      .run(attemptId, studentId, assignmentId, now, now);
    const responseId = randomUUID();
    // responses 同走原生 SQL（M1b 0038 前的边界库没有
    // practice_mutation_id/practice_request_digest 两列）
    db.$client
      .prepare(
        `INSERT INTO responses (id, attempt_id, question_id, question_snapshot_json)
         VALUES (?, ?, '练习四-1', '{"id":"练习四-1"}')`,
      )
      .run(responseId, attemptId);
    return { teacherId, studentId, assignmentId, attemptId, responseId };
  }

  it("空库（全新文件库）迁移后九表存在且迁移记录与 journal 一致", () => {
    const db = createDb(join(dir, "fresh-ai.db"));
    runMigrations(db);
    expectAiTablesExist(db);
    const rows = db.$client
      .prepare("SELECT count(*) AS n FROM __drizzle_migrations")
      .get() as { n: number };
    expect(rows.n).toBe(countJournalEntries());
    db.$client.close();
  });

  it("内存库同样可迁移到九表形态（createTestDb 走全部迁移 + 回填）", () => {
    const db = createTestDb();
    expectAiTablesExist(db);
    db.$client.close();
  });

  it("带存量数据的库升级：旧作答仍可读取、教师无 ai_teacher_settings 行（继承语义不写成显式开放）、幂等且外键干净", () => {
    const db = createDb(join(dir, "legacy-ai.db"));
    // 截断迁移目录建出 SAI-05 前的旧结构（真实 0000–0035 迁移链）
    migrate(db, {
      migrationsFolder: makeMigrationsFolderUpTo(PRE_SAI05_LAST_TAG),
    });
    const seeded = seedPreAiData(db);
    // 锁定边界：旧库确实没有 ai_* 表（升级路径真实存在）
    const before = db.$client
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'ai_%'",
      )
      .get() as { n: number };
    expect(before.n).toBe(0);

    // 模拟旧库启动：补应用 SAI-05 迁移
    expect(() => runMigrations(db)).not.toThrow();
    expectAiTablesExist(db);

    // 旧作答仍可按原样读取（升级不丢不改）
    const attemptRow = db.$client
      .prepare("SELECT student_id, status FROM attempts WHERE id = ?")
      .get(seeded.attemptId) as Record<string, string>;
    expect(attemptRow.student_id).toBe(seeded.studentId);
    expect(attemptRow.status).toBe("draft");
    const responseRow = db.$client
      .prepare("SELECT question_id FROM responses WHERE id = ?")
      .get(seeded.responseId) as { question_id: string };
    expect(responseRow.question_id).toBe("练习四-1");

    // 无配置旧账号：迁移不为存量教师回填 ai_teacher_settings 行（无行 = 继承 =
    // 默认 open_study；不统一写成显式开放导致继承语义消失）
    const settingsRows = db.$client
      .prepare("SELECT count(*) AS n FROM ai_teacher_settings")
      .get() as { n: number };
    expect(settingsRows.n).toBe(0);
    // sqlite 读取层口径与迁移一致：无行 → 默认开放、覆盖无行 → 继承
    expect(
      sqliteAiPolicyConfigSource.teacherDefaultMode(db, seeded.teacherId),
    ).toBe("open_study");
    expect(
      sqliteAiPolicyConfigSource.studentOverrideMode(db, seeded.studentId),
    ).toBe("inherit");
    expect(
      sqliteAiPolicyConfigSource.assignmentOverrideMode(
        db,
        seeded.assignmentId,
      ),
    ).toBe("inherit");

    // 外键完整性干净；再次迁移幂等（重复启动不重复建表/丢数据）
    expect(db.$client.pragma("foreign_key_check")).toHaveLength(0);
    expect(() => runMigrations(db)).not.toThrow();
    db.$client.close();
  });

  it("临时数据目录完整升级往返：旧库升级→写 AI 配置→关闭重开→新配置与旧作答均仍可读取", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tutor-sai05-upgrade-"));
    try {
      const dbPath = join(dataDir, "tutor.db");
      // 第一段：0035 旧库 + 存量数据
      const legacy = createDb(dbPath);
      migrate(legacy, {
        migrationsFolder: makeMigrationsFolderUpTo(PRE_SAI05_LAST_TAG),
      });
      const seeded = seedPreAiData(legacy);
      legacy.$client.close();

      // 第二段：升级启动（runMigrations + 写入 AI 配置后正常退出）
      const upgraded = createDb(dbPath);
      runMigrations(upgraded);
      upgraded
        .insert(aiTeacherSettings)
        .values({
          teacherId: seeded.teacherId,
          defaultMode: "guided_only",
          promptsOpen: null,
          promptsGuided: null,
          promptsReview: null,
          updatedAt: new Date().toISOString(),
        })
        .run();
      upgraded
        .insert(aiPolicyOverrides)
        .values({
          subjectType: "student",
          subjectId: seeded.studentId,
          mode: "post_submit_only",
          updatedAt: new Date().toISOString(),
        })
        .run();
      upgraded.$client.close();

      // 第三段：再次启动（重复启动幂等）——旧作答与新配置都在
      const reopened = createDb(dbPath);
      runMigrations(reopened);
      expectAiTablesExist(reopened);
      const rows = reopened.$client
        .prepare("SELECT count(*) AS n FROM __drizzle_migrations")
        .get() as { n: number };
      expect(rows.n).toBe(countJournalEntries());
      const attemptStill = reopened.$client
        .prepare("SELECT count(*) AS n FROM attempts WHERE id = ?")
        .get(seeded.attemptId) as { n: number };
      expect(attemptStill.n).toBe(1);
      // 旧配置仍可读取（升级后写入的 AI 配置在重启后原样保留）
      expect(
        sqliteAiPolicyConfigSource.teacherDefaultMode(
          reopened,
          seeded.teacherId,
        ),
      ).toBe("guided_only");
      expect(
        sqliteAiPolicyConfigSource.studentOverrideMode(
          reopened,
          seeded.studentId,
        ),
      ).toBe("post_submit_only");
      reopened.$client.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
