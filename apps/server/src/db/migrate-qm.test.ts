import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialPublicSchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freezeAttemptContextSnapshots } from "../services/material-repository.ts";
import { createDb } from "./client.ts";
import { resolveMigrationsFolder, runMigrations } from "./migrate.ts";
import {
  attemptContextSnapshots,
  ink,
  materials,
  responses,
} from "./schema.ts";
import { makeMigrationsFolderUpTo } from "./test-utils.ts";

/**
 * QM 专题迁移（0046 材料五表 + responses 自评列、0041 last_activity_at）——
 * 2026-10-25 二轮 v2 同步对齐：v2 链 0040_bizarre~0045 为正主（自评列族/
 * 复盘三表/错题重练范围/answered〔0044〕/student_flag〔0045〕），QM 五表
 * 迁移由 0044_true_groot 重排生成 0046（db:generate）。
 * 的存量升级与身份稳定测试（QM-18 细项 2）：
 * - 空库 / 旧库（0039 边界结构，原生 SQL 种 0039-era 存量行）/ 含进行中草稿
 *   与笔迹的库 / 新旧内容混合库四类边界；
 * - 升级后存量数据完好（题目 id、已交卷答案/判定、进行中草稿原样）、新列
 *   缺省保守（grading_policy NULL、self_review_revision 0、last_activity_at
 *   NULL——判分/投影行为与升级前一致，见 attempt-context.ts 旧行 NULL 语义）；
 * - 重复迁移不改身份：迁移账本幂等（二次跑不重复记账），题目 id 与
 *   (attemptId, kind, sourceId, sourceVersion) 快照身份稳定，
 *   freezeAttemptContextSnapshots 同键重冻零插入。
 *
 * 存量夹具走原生 SQL（drizzle 绑定当前 schema，向 0040 前旧表插含新列的行
 * 会绕过本迁移要验证的缺省行为——同 migrate-practice-workflow.test.ts 口径）；
 * ink 表列集自 0032 后未变，升级后用 drizzle 直插验证「含笔迹库」往返。
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tutor-qm-migrate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** QM 五表起点之前的边界（0046 建 attempt_context_snapshots 等） */
const PRE_QM_TABLES_TAG = "0039_mean_doorman";
/** 0041（attempts.last_activity_at，v2 链）之前的边界 */
const PRE_LAST_ACTIVITY_TAG = "0040_bizarre_fabian_cortez";

function countJournalEntries(): number {
  const journal = JSON.parse(
    readFileSync(
      join(resolveMigrationsFolder(), "meta", "_journal.json"),
      "utf8",
    ),
  ) as { entries: unknown[] };
  return journal.entries.length;
}

function ledgerRows(db: ReturnType<typeof createDb>): unknown[] {
  return db.$client
    .prepare("SELECT * FROM __drizzle_migrations ORDER BY id")
    .all();
}

interface LegacyFixture {
  teacherId: string;
  studentId: string;
  unitId: string;
  questionId: string;
  attemptId: string;
  responseId: string;
}

/**
 * 0039-era 存量行：教师/学生/课程/单元/题（judge 带答案）、一份**已交卷**
 * attempt+response（判过的答案——「修订前的已交卷答案/判定保持原样」的迁移侧
 * 断言对象）+ 一份**进行中草稿** attempt+response（未提交行）。
 */
function seedLegacyData(
  db: ReturnType<typeof createDb>,
  options: { draft: boolean },
): LegacyFixture {
  const now = "2026-09-01T00:00:00.000Z";
  const teacherId = randomUUID();
  db.$client
    .prepare(
      `INSERT INTO teachers (id, login_name, is_admin, disabled_at, password_hash, api_token, capability_profile_json, practice_feedback_policy, created_at)
       VALUES (?, 'qmteacher', 1, NULL, NULL, NULL, NULL, NULL, ?)`,
    )
    .run(teacherId, now);
  const studentId = randomUUID();
  db.$client
    .prepare(
      `INSERT INTO students (id, teacher_id, display_name, login_name, password_hash, link_token, link_enabled, password_enabled, note, archived_at, created_at)
       VALUES (?, ?, 'QM学生', 'qmstu', NULL, ?, 1, 0, NULL, NULL, ?)`,
    )
    .run(studentId, teacherId, `link-${randomUUID()}`, now);
  const courseId = randomUUID();
  db.$client
    .prepare(
      `INSERT INTO courses (id, teacher_id, title, "order", archived_at, description, created_at)
       VALUES (?, ?, 'QM课程', 0, NULL, NULL, ?)`,
    )
    .run(courseId, teacherId, now);
  const unitId = "qm-migrate-unit";
  db.$client
    .prepare(
      `INSERT INTO units (id, teacher_id, course_id, folder_id, lecture_id, title, topic, "order", updated_at, deleted_at)
       VALUES (?, ?, ?, NULL, NULL, 'QM练习', NULL, 0, ?, NULL)`,
    )
    .run(unitId, teacherId, courseId, now);
  const questionId = "qm-migrate-unit-1";
  db.$client
    .prepare(
      `INSERT INTO questions (id, teacher_id, unit_id, "order", type, difficulty, stem_md, options_json, answers_json, hints_json, solution_md, source_md, version, updated_at, deleted_at)
       VALUES (?, ?, ?, 0, 'judge', 1, 'QM 题干 [[正确]]', NULL, '{"kind":"judge","value":true}', '[]', NULL, '::::question{type=judge}\nQM 题干\n::::', 1, ?, NULL)`,
    )
    .run(questionId, teacherId, unitId, now);

  const attemptId = randomUUID();
  const responseId = randomUUID();
  if (options.draft) {
    // 进行中草稿：未提交行，answer 已写（草稿续写对象）
    db.$client
      .prepare(
        `INSERT INTO attempts (id, student_id, source_type, assignment_id, course_id, unit_id, lecture_id, attempt_no, status, started_at, submitted_at, frozen_at, active_sec, device, score_auto, score_final, legacy_unverified, abandoned_at)
         VALUES (?, ?, 'course', NULL, ?, ?, NULL, 2, 'draft', ?, NULL, ?, NULL, NULL, NULL, NULL, 0, NULL)`,
      )
      .run(attemptId, studentId, courseId, unitId, now, now);
    db.$client
      .prepare(
        `INSERT INTO responses (id, attempt_id, unit_id, question_id, question_version, question_snapshot_json, answer_json, answer_revision, answer_mutation_id, submitted_at, auto_correct, final_correct, teacher_mark, teacher_comment, active_sec, hints_used, hints_opened_json, change_count, ink_id)
         VALUES (?, ?, ?, ?, 1, '{"id":"qm-migrate-unit-1","type":"judge"}', '{"kind":"judge","value":false}', 2, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, 1, NULL)`,
      )
      .run(responseId, attemptId, unitId, questionId, randomUUID());
  } else {
    // 已交卷已判：答案错、auto_correct=0、final_correct=0（升级不得重判/漂移）
    db.$client
      .prepare(
        `INSERT INTO attempts (id, student_id, source_type, assignment_id, course_id, unit_id, lecture_id, attempt_no, status, started_at, submitted_at, frozen_at, active_sec, device, score_auto, score_final, legacy_unverified, abandoned_at)
         VALUES (?, ?, 'course', NULL, ?, ?, NULL, 1, 'graded', ?, ?, ?, NULL, NULL, 0, 0, 0, NULL)`,
      )
      .run(attemptId, studentId, courseId, unitId, now, now, now);
    db.$client
      .prepare(
        `INSERT INTO responses (id, attempt_id, unit_id, question_id, question_version, question_snapshot_json, answer_json, answer_revision, answer_mutation_id, submitted_at, auto_correct, final_correct, teacher_mark, teacher_comment, active_sec, hints_used, hints_opened_json, change_count, ink_id)
         VALUES (?, ?, ?, ?, 1, '{"id":"qm-migrate-unit-1","type":"judge"}', '{"kind":"judge","value":false}', 1, NULL, ?, 0, 0, NULL, NULL, 30, 0, NULL, 0, NULL)`,
      )
      .run(responseId, attemptId, unitId, questionId, now);
  }
  return { teacherId, studentId, unitId, questionId, attemptId, responseId };
}

describe("QM 迁移 0040/0041：空库、旧库、草稿笔迹库与混合库升级", () => {
  it("空库（全新文件库）迁移后五表存在、账本与 journal 一致、二次跑幂等", () => {
    const db = createDb(join(dir, "fresh.db"));
    runMigrations(db);
    const tables = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('materials', 'question_groups', 'question_group_members', 'material_refs', 'attempt_context_snapshots')",
      )
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(5);
    const columns = db.$client
      .prepare("PRAGMA table_info('responses')")
      .all() as Array<{ name: string }>;
    for (const name of [
      "grading_policy",
      "self_review_verdict",
      "self_review_at",
      "self_review_revision",
      "self_review_mutation_id",
    ]) {
      expect(columns.some((column) => column.name === name)).toBe(true);
    }
    expect(
      (
        db.$client.prepare("PRAGMA table_info('attempts')").all() as Array<{
          name: string;
        }>
      ).some((column) => column.name === "last_activity_at"),
    ).toBe(true);

    const before = ledgerRows(db);
    runMigrations(db);
    expect(ledgerRows(db)).toEqual(before);
    expect(before).toHaveLength(countJournalEntries());
    db.$client.close();
  });

  it("旧库（0040 前结构）升级：已交卷答案/判定原样、新列缺省保守、账本幂等", () => {
    const db = createDb(join(dir, "legacy.db"));
    migrate(db, {
      migrationsFolder: makeMigrationsFolderUpTo(PRE_QM_TABLES_TAG),
    });
    const seeded = seedLegacyData(db, { draft: false });

    expect(() => runMigrations(db)).not.toThrow();

    // 存量行完好：题目 id/答案/判定不漂移（修订前的已交卷答案/判定保持原样）
    const row = db.$client
      .prepare(
        "SELECT question_id AS qid, answer_json AS answer, auto_correct AS auto, final_correct AS final, grading_policy AS policy, self_review_revision AS srRev, self_review_verdict AS verdict FROM responses WHERE id = ?",
      )
      .get(seeded.responseId) as {
      qid: string;
      answer: string;
      auto: number;
      final: number;
      policy: string | null;
      srRev: number;
      verdict: string | null;
    };
    expect(row.qid).toBe(seeded.questionId);
    expect(JSON.parse(row.answer)).toEqual({ kind: "judge", value: false });
    expect(row.auto).toBe(0);
    expect(row.final).toBe(0);
    // 新列缺省保守：旧行 NULL/0——判分与投影行为与升级前一致（旧行 NULL 语义）
    expect(row.policy).toBeNull();
    expect(row.verdict).toBeNull();
    expect(row.srRev).toBe(0);
    expect(
      (
        db.$client
          .prepare("SELECT last_activity_at AS at FROM attempts WHERE id = ?")
          .get(seeded.attemptId) as { at: string | null }
      ).at,
    ).toBeNull();

    const before = ledgerRows(db);
    runMigrations(db);
    expect(ledgerRows(db)).toEqual(before);
    expect(before).toHaveLength(countJournalEntries());
    db.$client.close();
  });

  it("含进行中草稿与笔迹的库升级：草稿行/笔迹行原样、升级后续写字段可用", () => {
    const db = createDb(join(dir, "draft.db"));
    migrate(db, {
      migrationsFolder: makeMigrationsFolderUpTo(PRE_QM_TABLES_TAG),
    });
    const seeded = seedLegacyData(db, { draft: true });
    // 0039-era 无 QM 表；ink 列集自 0032 未变——升 0040 后经 drizzle 补一行
    // 真实笔迹（strokes/png 路径为 DATA_DIR 相对形态，测试只验证行身份）
    runMigrations(db);
    const inkId = randomUUID();
    db.insert(ink)
      .values({
        id: inkId,
        attemptId: seeded.attemptId,
        questionId: seeded.questionId,
        revision: 1,
        mutationId: randomUUID(),
        bodyHash: null,
        strokesPath: `blobs/ink/${seeded.attemptId}/q-1-v1-${inkId}.json.gz`,
        pngPath: `blobs/ink/${seeded.attemptId}/q-1-v1-${inkId}.png`,
        width: 1000,
        height: 800,
        strokeCount: 3,
        updatedAt: "2026-09-01T00:01:00.000Z",
      })
      .run();
    // 「再次启动」：重复迁移不动草稿行与笔迹行
    const draftBefore = db.$client
      .prepare(
        "SELECT answer_json, answer_revision FROM responses WHERE id = ?",
      )
      .get(seeded.responseId);
    runMigrations(db);
    expect(
      db.$client
        .prepare(
          "SELECT answer_json, answer_revision FROM responses WHERE id = ?",
        )
        .get(seeded.responseId),
    ).toEqual(draftBefore);
    const inkRow = db
      .select({ id: ink.id, revision: ink.revision })
      .from(ink)
      .where(eq(ink.attemptId, seeded.attemptId))
      .get();
    expect(inkRow).toMatchObject({ id: inkId, revision: 1 });
    db.$client.close();
  });

  it("新旧内容混合库：升级后写 QM 数据 → 重复迁移身份稳定（题目 id / 快照身份 / 重冻零插入）", () => {
    const db = createDb(join(dir, "mixed.db"));
    migrate(db, {
      migrationsFolder: makeMigrationsFolderUpTo(PRE_LAST_ACTIVITY_TAG),
    });
    const seeded = seedLegacyData(db, { draft: false });
    runMigrations(db); // 只剩 0041

    // 新内容：材料 + 行级自评列（drizzle 当前 schema 写入）
    db.insert(materials)
      .values({
        id: "qm-mat-1",
        teacherId: seeded.teacherId,
        unitId: seeded.unitId,
        title: "混合库材料",
        sourceMd: '::::material{id="qm-mat-1"}\n::::',
        contentMd: "材料正文 {{s-1}}。",
        anchorsJson: "[]",
        slotsJson: '[{"id":"s-1","slotKind":"text","order":0}]',
        mediaPathsJson: "[]",
        order: 0,
        version: 1,
        updatedAt: "2026-09-02T00:00:00.000Z",
        deletedAt: null,
      })
      .run();
    db.update(responses)
      .set({
        gradingPolicy: "reference_self",
        selfReviewVerdict: "wrong",
        selfReviewAt: "2026-09-02T00:00:00.000Z",
        selfReviewRevision: 1,
        selfReviewMutationId: randomUUID(),
      })
      .where(eq(responses.id, seeded.responseId))
      .run();
    const inserted = freezeAttemptContextSnapshots(
      db,
      seeded.attemptId,
      [
        {
          kind: "material",
          sourceId: "qm-mat-1",
          sourceVersion: 1,
          snapshot: materialPublicSchema.parse({
            id: "qm-mat-1",
            title: "混合库材料",
            contentMd: "材料正文 {{s-1}}。",
            slots: [{ id: "s-1", slotKind: "text" as const, order: 0 }],
          }),
        },
      ],
      "2026-09-02T00:00:00.000Z",
    );
    expect(inserted).toBe(1);

    // 身份快照：题目 id、快照身份五元组（含冻结时间）、行级自评
    const questionIdsBefore = db.$client
      .prepare("SELECT id FROM questions ORDER BY id")
      .all();
    const snapshotsBefore = db
      .select({
        attemptId: attemptContextSnapshots.attemptId,
        kind: attemptContextSnapshots.kind,
        sourceId: attemptContextSnapshots.sourceId,
        sourceVersion: attemptContextSnapshots.sourceVersion,
        frozenAt: attemptContextSnapshots.frozenAt,
        snapshotJson: attemptContextSnapshots.snapshotJson,
      })
      .from(attemptContextSnapshots)
      .all();
    const selfReviewBefore = db.$client
      .prepare(
        "SELECT grading_policy, self_review_verdict, self_review_revision FROM responses WHERE id = ?",
      )
      .get(seeded.responseId);
    const ledgerBefore = ledgerRows(db);

    runMigrations(db);
    runMigrations(db);

    expect(ledgerRows(db)).toEqual(ledgerBefore);
    expect(
      db.$client.prepare("SELECT id FROM questions ORDER BY id").all(),
    ).toEqual(questionIdsBefore);
    expect(
      db
        .select({
          attemptId: attemptContextSnapshots.attemptId,
          kind: attemptContextSnapshots.kind,
          sourceId: attemptContextSnapshots.sourceId,
          sourceVersion: attemptContextSnapshots.sourceVersion,
          frozenAt: attemptContextSnapshots.frozenAt,
          snapshotJson: attemptContextSnapshots.snapshotJson,
        })
        .from(attemptContextSnapshots)
        .all(),
    ).toEqual(snapshotsBefore);
    expect(
      db.$client
        .prepare(
          "SELECT grading_policy, self_review_verdict, self_review_revision FROM responses WHERE id = ?",
        )
        .get(seeded.responseId),
    ).toEqual(selfReviewBefore);

    // 同键重冻零插入：(attempt, kind, sourceId, sourceVersion) 唯一去重
    const reFrozen = freezeAttemptContextSnapshots(
      db,
      seeded.attemptId,
      [
        {
          kind: "material",
          sourceId: "qm-mat-1",
          sourceVersion: 1,
          snapshot: materialPublicSchema.parse({
            id: "qm-mat-1",
            title: "混合库材料",
            contentMd: "材料正文 {{s-1}}。",
            slots: [{ id: "s-1", slotKind: "text" as const, order: 0 }],
          }),
        },
      ],
      "2026-09-03T00:00:00.000Z",
    );
    expect(reFrozen).toBe(0);
    db.$client.close();
  });
});
