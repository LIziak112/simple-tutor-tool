import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client.ts";
import { resolveMigrationsFolder, runMigrations } from "./migrate.ts";
import { createTestDb, makeMigrationsFolderUpTo } from "./test-utils.ts";

/**
 * QM-03（tt-05b）迁移测试：材料/组/引用索引/冻结快照五表 + responses/questions
 * 新增可空列。边界 = 0039（本单前最后一个迁移）；升级路径与既有形态断言沿用
 * migrate.test.ts 惯例（截断迁移目录建旧库 + 原生 SQL 种存量行——responses/
 * questions 的当前 Drizzle 模型已含新列，旧库直插会失败）。
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tutor-qm03-migrate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** QM-03 前最后一个迁移 tag（0039：units 加 practice_defaults_json） */
const PRE_QM03_LAST_TAG = "0039_mean_doorman";

/** 本单新增五表（存在性断言与升级检查共用） */
const QM03_TABLES = [
  "attempt_context_snapshots",
  "material_refs",
  "materials",
  "question_group_members",
  "question_groups",
] as const;

function expectQm03TablesExist(db: ReturnType<typeof createDb>): void {
  const tables = db.$client
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${QM03_TABLES.map(() => "?").join(",")}) ORDER BY name`,
    )
    .all(...QM03_TABLES) as Array<{ name: string }>;
  expect(tables.map((r) => r.name)).toEqual([...QM03_TABLES]);
}

/** 期望的迁移条数：直接读迁移目录的 journal（后续任务追加迁移不需要回来改这里） */
function countJournalEntries(): number {
  const journal = JSON.parse(
    readFileSync(
      join(resolveMigrationsFolder(), "meta", "_journal.json"),
      "utf8",
    ),
  ) as { entries: unknown[] };
  return journal.entries.length;
}

/**
 * 在 0039 边界库上种入存量业务数据（教师 → 学生 → 单元 → 题目 → attempt →
 * response）。原生 SQL 直插（responses/questions 当前模型已含 0040 新列，
 * Drizzle 绑定新列的插入在旧库上失败——T6R.2/SAI-05 同款惯例）。
 */
function seedPreQm03Data(db: ReturnType<typeof createDb>): {
  teacherId: string;
  studentId: string;
  unitId: string;
  questionId: string;
  attemptId: string;
  responseId: string;
} {
  const now = new Date().toISOString();
  const teacherId = randomUUID();
  db.$client
    .prepare(
      "INSERT INTO teachers (id, login_name, is_admin, disabled_at, password_hash, api_token, created_at) VALUES (?, 'teacher-qm03', 1, NULL, NULL, NULL, ?)",
    )
    .run(teacherId, now);
  const studentId = randomUUID();
  db.$client
    .prepare(
      "INSERT INTO students (id, teacher_id, display_name, login_name, password_hash, link_token, link_enabled, password_enabled, note, archived_at, created_at) VALUES (?, ?, '张三', '张三', NULL, ?, 1, 0, NULL, NULL, ?)",
    )
    .run(studentId, teacherId, `link-${randomUUID()}`, now);
  const unitId = "unit-qm03-资料分析";
  db.$client
    .prepare(
      `INSERT INTO units (id, teacher_id, course_id, folder_id, lecture_id, title, topic, "order", updated_at, deleted_at)
       VALUES (?, ?, NULL, NULL, NULL, '资料分析', NULL, 0, ?, NULL)`,
    )
    .run(unitId, teacherId, now);
  const questionId = "资料分析-1";
  db.$client
    .prepare(
      `INSERT INTO questions (id, teacher_id, unit_id, "order", type, difficulty, stem_md, options_json, answers_json, hints_json, solution_md, source_md, version, updated_at, deleted_at)
       VALUES (?, ?, ?, 0, 'judge', 1, '题干 [[正确]]', NULL, '{"kind":"judge","value":true}', '[]', NULL, '::::question{type=judge difficulty=1}\n题干 [[正确]]\n::::', 2, ?, NULL)`,
    )
    .run(questionId, teacherId, unitId, now);
  // wrong 来源 attempt：三归属外键全可空，夹具最小
  const attemptId = randomUUID();
  db.$client
    .prepare(
      `INSERT INTO attempts (id, student_id, source_type, attempt_no, status, started_at, frozen_at, legacy_unverified)
       VALUES (?, ?, 'wrong', 1, 'submitted', ?, ?, 0)`,
    )
    .run(attemptId, studentId, now, now);
  const responseId = randomUUID();
  db.$client
    .prepare(
      `INSERT INTO responses (id, attempt_id, question_id, question_version, question_snapshot_json, answer_json, auto_correct, final_correct, teacher_mark, teacher_comment, active_sec, hints_used, change_count, ink_id)
       VALUES (?, ?, ?, 2, '{"id":"资料分析-1","type":"judge"}', '{"kind":"judge","value":true}', true, true, NULL, NULL, NULL, 0, 1, NULL)`,
    )
    .run(responseId, attemptId, questionId);
  return {
    teacherId,
    studentId,
    unitId,
    questionId,
    attemptId,
    responseId,
  };
}

describe("QM-03 迁移：材料/组/引用索引/冻结快照五表（空库与存量库）", () => {
  it("空库（全新文件库）迁移后五表存在且迁移记录与 journal 一致", () => {
    const db = createDb(join(dir, "fresh-qm03.db"));
    runMigrations(db);
    expectQm03TablesExist(db);
    const rows = db.$client
      .prepare("SELECT count(*) AS n FROM __drizzle_migrations")
      .get() as { n: number };
    expect(rows.n).toBe(countJournalEntries());
    db.$client.close();
  });

  it("内存库（createTestDb 走全部迁移 + 回填）同样五表存在", () => {
    const db = createTestDb();
    expectQm03TablesExist(db);
    db.$client.close();
  });

  it("带存量数据的库升级：五表建出、responses/questions 新列补默认、存量行完好、新列可写、幂等且外键干净", () => {
    const db = createDb(join(dir, "legacy-qm03.db"));
    // 截断迁移目录建出 QM-03 前的旧结构（真实 0000–0039 迁移链）
    migrate(db, {
      migrationsFolder: makeMigrationsFolderUpTo(PRE_QM03_LAST_TAG),
    });
    const seeded = seedPreQm03Data(db);
    // 锁定边界：旧库确实没有五表（升级路径真实存在）
    const before = db.$client
      .prepare(
        `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${QM03_TABLES.map(() => "?").join(",")})`,
      )
      .get(...QM03_TABLES) as { n: number };
    expect(before.n).toBe(0);

    // 模拟旧库启动：补应用 QM-03 迁移（重复启动第二次亦不抛错）
    expect(() => runMigrations(db)).not.toThrow();
    expectQm03TablesExist(db);

    // 存量 responses 行完好，新列补默认（§5.6：旧行 gradingPolicy=NULL 旧语义；
    // §5.5：从未自评的行天然处于暂不判断——verdict NULL、revision 0）
    const responseRow = db.$client
      .prepare(
        `SELECT question_id, question_version, auto_correct, final_correct, change_count,
                grading_policy, self_review_verdict, self_review_at, self_review_revision, self_review_mutation_id
         FROM responses WHERE id = ?`,
      )
      .get(seeded.responseId) as Record<string, unknown>;
    expect(responseRow.question_id).toBe(seeded.questionId);
    expect(responseRow.question_version).toBe(2);
    expect(responseRow.auto_correct).toBe(1);
    expect(responseRow.final_correct).toBe(1);
    expect(responseRow.change_count).toBe(1);
    expect(responseRow.grading_policy).toBeNull();
    expect(responseRow.self_review_verdict).toBeNull();
    expect(responseRow.self_review_at).toBeNull();
    expect(responseRow.self_review_revision).toBe(0);
    expect(responseRow.self_review_mutation_id).toBeNull();

    // 存量 questions 行完好，新列 material_refs_json 补 NULL（旧题目无 ::ref）
    const questionRow = db.$client
      .prepare(
        "SELECT type, version, material_refs_json FROM questions WHERE id = ? AND teacher_id = ?",
      )
      .get(seeded.questionId, seeded.teacherId) as Record<string, unknown>;
    expect(questionRow.type).toBe("judge");
    expect(questionRow.version).toBe(2);
    expect(questionRow.material_refs_json).toBeNull();

    // 新列可写：开卷冻结行策略与自评记录形态落列读回（写入方在 QM-06/TT-09）
    db.$client
      .prepare(
        "UPDATE responses SET grading_policy = 'reference_self', self_review_verdict = 'correct', self_review_at = ?, self_review_revision = 1, self_review_mutation_id = ? WHERE id = ?",
      )
      .run(
        "2026-10-24T08:00:00.000Z",
        "11111111-1111-4111-8111-111111111111",
        seeded.responseId,
      );
    const updated = db.$client
      .prepare(
        "SELECT grading_policy, self_review_verdict, self_review_at, self_review_revision, self_review_mutation_id FROM responses WHERE id = ?",
      )
      .get(seeded.responseId) as Record<string, unknown>;
    expect(updated.grading_policy).toBe("reference_self");
    expect(updated.self_review_verdict).toBe("correct");
    expect(updated.self_review_at).toBe("2026-10-24T08:00:00.000Z");
    expect(updated.self_review_revision).toBe(1);
    expect(updated.self_review_mutation_id).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    db.$client
      .prepare(
        "UPDATE questions SET material_refs_json = ? WHERE id = ? AND teacher_id = ?",
      )
      .run(
        '[{"material":"mat-u-1"}]',
        seeded.questionId,
        seeded.teacherId,
      );
    const updatedQuestion = db.$client
      .prepare(
        "SELECT material_refs_json FROM questions WHERE id = ? AND teacher_id = ?",
      )
      .get(seeded.questionId, seeded.teacherId) as {
      material_refs_json: string;
    };
    expect(updatedQuestion.material_refs_json).toBe('[{"material":"mat-u-1"}]');

    // gradingPolicy 值域不含第四值（新列形态按契约三值写；DB 层不加 CHECK——
    // responses 既有列 teacherMark 同口径，值域由写入方契约把关）

    // 外键完整性干净；再次迁移幂等
    expect(db.$client.pragma("foreign_key_check")).toHaveLength(0);
    expect(() => runMigrations(db)).not.toThrow();
    db.$client.close();
  });

  it("新表可写且外键生效：冻结快照引用存量 attempt（materials/groups 主体行为在仓储测试覆盖）", () => {
    const db = createDb(join(dir, "fresh-snap.db"));
    runMigrations(db);
    const now = new Date().toISOString();
    const studentId = randomUUID();
    db.$client
      .prepare(
        "INSERT INTO students (id, teacher_id, display_name, login_name, password_hash, link_token, link_enabled, password_enabled, note, archived_at, created_at) VALUES (?, NULL, '李四', '李四', NULL, ?, 1, 0, NULL, NULL, ?)",
      )
      .run(studentId, `link-${randomUUID()}`, now);
    const attemptId = randomUUID();
    db.$client
      .prepare(
        "INSERT INTO attempts (id, student_id, source_type, attempt_no, status, started_at) VALUES (?, ?, 'wrong', 1, 'submitted', ?)",
      )
      .run(attemptId, studentId, now);
    db.$client
      .prepare(
        `INSERT INTO attempt_context_snapshots (id, attempt_id, kind, source_id, source_version, snapshot_json, frozen_at)
         VALUES (?, ?, 'material', 'mat-u-1', 1, '{"id":"mat-u-1","contentMd":"正文"}', ?)`,
      )
      .run(randomUUID(), attemptId, now);
    expect(
      db.$client
        .prepare("SELECT count(*) AS n FROM attempt_context_snapshots")
        .get(),
    ).toMatchObject({ n: 1 });
    // 孤儿 attemptId 被外键拒绝
    expect(() =>
      db.$client
        .prepare(
          `INSERT INTO attempt_context_snapshots (id, attempt_id, kind, source_id, source_version, snapshot_json, frozen_at)
           VALUES (?, ?, 'group', 'grp-u-1', 1, '{"id":"grp-u-1"}', ?)`,
        )
        .run(randomUUID(), randomUUID(), now),
    ).toThrow();
    db.$client.close();
  });

  it("新表列类型只含 text/integer（笔迹正文不进数据库——契约即投影，无 blob 列）", () => {
    const db = createTestDb();
    for (const table of QM03_TABLES) {
      const cols = db.$client
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ type: string }>;
      expect(
        cols.map((c) => c.type.toLowerCase()),
        `${table} 列类型应为 text/integer`,
      ).toEqual(expect.arrayContaining([]));
      for (const col of cols) {
        expect(["text", "integer"]).toContain(col.type.toLowerCase());
      }
    }
    db.$client.close();
  });
});
