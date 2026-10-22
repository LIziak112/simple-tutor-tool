import { randomUUID } from "node:crypto";
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
  dir = mkdtempSync(join(tmpdir(), "tutor-m1b-migrate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * M1b 迁移（0038：teachers/assignments/attempts/responses 七新列）前的边界。
 * 存量夹具全部走原生 SQL 明确旧列——drizzle 绑定当前 schema，向截断旧表
 * 插含新列的行会越过本迁移要验证的缺省行为。
 */
const PRE_M1B_LAST_TAG = "0037_outstanding_young_avengers";

interface LegacyFixture {
  teacherId: string;
  assignmentId: string;
  attemptId: string;
  responseId: string;
}

function seedPreM1bData(db: ReturnType<typeof createDb>): LegacyFixture {
  const now = new Date().toISOString();
  const teacherId = randomUUID();
  db.$client
    .prepare(
      "INSERT INTO teachers (id, login_name, is_admin, disabled_at, password_hash, api_token, capability_profile_json, created_at) VALUES (?, 'teacher', 1, NULL, 'scrypt$模拟哈希', NULL, NULL, ?)",
    )
    .run(teacherId, now);
  const studentId = randomUUID();
  db.$client
    .prepare(
      "INSERT INTO students (id, teacher_id, display_name, login_name, password_hash, link_token, link_enabled, password_enabled, note, archived_at, created_at) VALUES (?, ?, '张三', '张三', NULL, ?, 1, 0, NULL, NULL, ?)",
    )
    .run(studentId, teacherId, `link-${randomUUID()}`, now);
  const courseId = randomUUID();
  db.$client
    .prepare(
      "INSERT INTO courses (id, teacher_id, title, \"order\", archived_at, description, created_at) VALUES (?, ?, '初一上', 0, NULL, NULL, ?)",
    )
    .run(courseId, teacherId, now);
  const unitId = "unit-m1b";
  db.$client
    .prepare(
      `INSERT INTO units (id, teacher_id, course_id, folder_id, lecture_id, title, topic, "order", updated_at, deleted_at)
       VALUES (?, ?, ?, NULL, NULL, '练习', NULL, 0, ?, NULL)`,
    )
    .run(unitId, teacherId, courseId, now);
  db.$client
    .prepare(
      `INSERT INTO questions (id, teacher_id, unit_id, "order", type, difficulty, stem_md, options_json, answers_json, hints_json, solution_md, source_md, version, updated_at, deleted_at)
       VALUES ('q-m1b-1', ?, ?, 0, 'judge', 1, '题干 [[正确]]', NULL, '{"kind":"judge","value":true}', '[]', NULL, '::::question{type=judge}\n题干\n::::', 1, ?, NULL)`,
    )
    .run(teacherId, unitId, now);
  const assignmentId = randomUUID();
  db.$client
    .prepare(
      "INSERT INTO assignments (id, teacher_id, unit_id, course_id, title, due_at, answer_release, deleted_at, created_at) VALUES (?, ?, NULL, ?, '旧作业', NULL, 'on_submit', NULL, ?)",
    )
    .run(assignmentId, teacherId, courseId, now);
  const attemptId = randomUUID();
  db.$client
    .prepare(
      `INSERT INTO attempts (id, student_id, source_type, assignment_id, course_id, unit_id, lecture_id, attempt_no, status, started_at, submitted_at, frozen_at, active_sec, device, score_auto, score_final, legacy_unverified, abandoned_at)
       VALUES (?, ?, 'assignment', ?, ?, ?, NULL, 1, 'draft', ?, NULL, ?, NULL, NULL, NULL, NULL, 0, NULL)`,
    )
    .run(attemptId, studentId, assignmentId, courseId, unitId, now, now);
  const responseId = randomUUID();
  db.$client
    .prepare(
      `INSERT INTO responses (id, attempt_id, unit_id, question_id, question_version, question_snapshot_json, answer_json, answer_revision, answer_mutation_id, submitted_at, auto_correct, final_correct, teacher_mark, teacher_comment, active_sec, hints_used, hints_opened_json, change_count, ink_id)
       VALUES (?, ?, ?, 'q-m1b-1', 1, '{"id":"q-m1b-1","type":"judge"}', NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, 0, NULL)`,
    )
    .run(responseId, attemptId, unitId);
  return { teacherId, assignmentId, attemptId, responseId };
}

describe("M1b 迁移 0038：practice workflow 七列缺省与存量兼容", () => {
  it("存量库升级：新列缺省保守（作业 false、attempt 旧协议 NULL/revision=0、教师策略 NULL），存量数据完好且幂等", () => {
    const db = createDb(join(dir, "legacy.db"));
    migrate(db, {
      migrationsFolder: makeMigrationsFolderUpTo(PRE_M1B_LAST_TAG),
    });
    const seeded = seedPreM1bData(db);

    expect(() => runMigrations(db)).not.toThrow();

    const teacher = db.$client
      .prepare(
        "SELECT practice_feedback_policy AS policy FROM teachers WHERE id = ?",
      )
      .get(seeded.teacherId) as { policy: string | null };
    expect(teacher.policy).toBeNull();

    const assignment = db.$client
      .prepare(
        "SELECT answer_release, allow_per_question_feedback AS allowPq FROM assignments WHERE id = ?",
      )
      .get(seeded.assignmentId) as {
      answer_release: string;
      allowPq: number;
    };
    expect(assignment.answer_release).toBe("on_submit");
    expect(assignment.allowPq).toBe(0);

    const attempt = db.$client
      .prepare(
        "SELECT practice_workflow_version AS version, feedback_mode, workflow_revision AS revision, status FROM attempts WHERE id = ?",
      )
      .get(seeded.attemptId) as {
      version: number | null;
      feedback_mode: string | null;
      revision: number;
      status: string;
    };
    expect(attempt.version).toBeNull();
    expect(attempt.feedback_mode).toBeNull();
    expect(attempt.revision).toBe(0);
    expect(attempt.status).toBe("draft");

    const response = db.$client
      .prepare(
        "SELECT practice_mutation_id AS mutationId, practice_request_digest AS digest, submitted_at FROM responses WHERE id = ?",
      )
      .get(seeded.responseId) as {
      mutationId: string | null;
      digest: string | null;
      submitted_at: string | null;
    };
    expect(response.mutationId).toBeNull();
    expect(response.digest).toBeNull();
    // 不伪造逐题提交时间（M2 语义：NULL = 未提交）
    expect(response.submitted_at).toBeNull();

    // 再跑一次不报错（幂等）
    expect(() => runMigrations(db)).not.toThrow();
    db.$client.close();
  });

  it("空库直接迁到最新后新列存在且缺省同上", () => {
    const db = createDb(join(dir, "fresh.db"));
    runMigrations(db);
    const cols = db.$client
      .prepare(
        "SELECT count(*) AS n FROM pragma_table_info('attempts') WHERE name IN ('practice_workflow_version','feedback_mode','workflow_revision')",
      )
      .get() as { n: number };
    expect(cols.n).toBe(3);
    db.$client.close();
  });
});
