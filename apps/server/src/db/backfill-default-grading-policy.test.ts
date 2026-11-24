import type { Question } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  frozenDraftAttempt,
  snapshotJsonOf,
} from "../test/evidence-fixtures.ts";
import { makeStudent } from "../test/note-fixtures.ts";
import { backfillDefaultGradingPolicy } from "./backfill-default-grading-policy.ts";
import type { Db } from "./client.ts";
import { attempts, dataMigrations, responses, teachers } from "./schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "./test-utils.ts";

/**
 * 空判分策略回填（TASK-f9439bfd，定案 A）：空/非法策略行按快照回落默认策略，
 * 非 auto 行清掉旧语义 autoCorrect、finalCorrect 按教师判定重算，已收尾卷经
 * 交卷同口径重算 status / scoreFinal / scoreAuto；无快照行保持空值；幂等。
 */

const KEY = "default_grading_policy_v1";
const AT = "2026-10-02T00:00:00.000Z";

const solveWithRef = (id: string) =>
  snapshotJsonOf({
    id,
    type: "solve",
    answers: { kind: "final", answer: "1" },
  });
const solveNoRef = (id: string) => snapshotJsonOf({ id, type: "solve" });
const fillWithRef = (id: string) =>
  snapshotJsonOf({ id, answers: { kind: "fill", blanks: [["1"]] } });
const judge = (id: string) =>
  snapshotJsonOf({
    id,
    type: "judge",
    answers: { kind: "judge", value: true },
  } as Partial<Question> & { id: string });

type RowPatch = Partial<typeof responses.$inferInsert>;

/** 造一份旧语义已收尾卷：逐行写入策略与判分事实，卷级写旧口径结果 */
function legacyAttempt(
  db: Db,
  studentId: string,
  rows: ReadonlyArray<{
    questionId: string;
    snapshotJson: string | null;
    patch: RowPatch;
  }>,
  attempt: Partial<typeof attempts.$inferInsert> = {},
): { attemptId: string; rowIds: Map<string, string> } {
  const { attemptId, rowIds } = frozenDraftAttempt(db, studentId, rows);
  rows.forEach((row, index) => {
    db.update(responses)
      .set(row.patch)
      .where(eq(responses.id, rowIds[index] as string))
      .run();
  });
  db.update(attempts)
    .set({ frozenAt: AT, ...attempt })
    .where(eq(attempts.id, attemptId))
    .run();
  return {
    attemptId,
    rowIds: new Map(rows.map((row, i) => [row.questionId, rowIds[i] ?? ""])),
  };
}

function resetMarker(db: Db): void {
  db.delete(dataMigrations).where(eq(dataMigrations.key, KEY)).run();
}

const rowOf = (db: Db, id: string) =>
  db.select().from(responses).where(eq(responses.id, id)).get();
const attemptOf = (db: Db, id: string) =>
  db.select().from(attempts).where(eq(attempts.id, id)).get();

describe("backfillDefaultGradingPolicy", () => {
  it("每种空策略来源都回落默认策略：旧自动判定作废、教师判定保留、卷级重算", () => {
    const db = createTestDb();
    resetMarker(db);
    const studentId = makeStudent(db);
    const finalized = { status: "graded", submittedAt: AT } as const;
    const { attemptId, rowIds } = legacyAttempt(
      db,
      studentId,
      [
        // 旧 final 等价比较判对的 solve → reference_self，判定作废
        {
          questionId: "solve-auto",
          snapshotJson: solveWithRef("solve-auto"),
          patch: { gradingPolicy: null, autoCorrect: true, finalCorrect: true },
        },
        // 教师已判的 solve：判定保留
        {
          questionId: "solve-teacher",
          snapshotJson: solveWithRef("solve-teacher"),
          patch: {
            gradingPolicy: null,
            autoCorrect: true,
            teacherMark: "wrong",
            finalCorrect: false,
          },
        },
        // 旧 fill 恒 null → reference_self
        {
          questionId: "fill",
          snapshotJson: fillWithRef("fill"),
          patch: { gradingPolicy: null },
        },
        // 客观题 → auto，旧判定原样保留
        {
          questionId: "judge",
          snapshotJson: judge("judge"),
          patch: {
            gradingPolicy: null,
            autoCorrect: false,
            finalCorrect: false,
          },
        },
        // 非法值 + 快照无参考 → manual_only（判定作废，回教师待批）
        {
          questionId: "invalid",
          snapshotJson: solveNoRef("invalid"),
          patch: {
            gradingPolicy: "legacy" as never,
            autoCorrect: true,
            finalCorrect: true,
          },
        },
        // 无可用快照（幽灵行）：无从推导，保持空值且不计分
        {
          questionId: "ghost",
          snapshotJson: null,
          patch: { gradingPolicy: null, autoCorrect: true, finalCorrect: true },
        },
      ],
      { ...finalized, scoreAuto: 75, scoreFinal: 60 },
    );
    const id = (q: string) => rowIds.get(q) ?? "";

    backfillDefaultGradingPolicy(db, new Date(AT));

    expect(rowOf(db, id("solve-auto"))).toMatchObject({
      gradingPolicy: "reference_self",
      autoCorrect: null,
      finalCorrect: null,
    });
    expect(rowOf(db, id("solve-teacher"))).toMatchObject({
      gradingPolicy: "reference_self",
      autoCorrect: null,
      teacherMark: "wrong",
      finalCorrect: false,
    });
    expect(rowOf(db, id("fill"))).toMatchObject({
      gradingPolicy: "reference_self",
      autoCorrect: null,
      finalCorrect: null,
    });
    expect(rowOf(db, id("judge"))).toMatchObject({
      gradingPolicy: "auto",
      autoCorrect: false,
      finalCorrect: false,
    });
    expect(rowOf(db, id("invalid"))).toMatchObject({
      gradingPolicy: "manual_only",
      autoCorrect: null,
      finalCorrect: null,
    });
    expect(rowOf(db, id("ghost"))).toMatchObject({
      gradingPolicy: null,
      autoCorrect: true,
    });
    // manual_only 行待教师批 → submitted；scoreAuto 只剩 judge（错）→ 0
    expect(attemptOf(db, attemptId)).toMatchObject({
      status: "submitted",
      scoreFinal: null,
      scoreAuto: 0,
    });
    expect(
      db.select().from(dataMigrations).where(eq(dataMigrations.key, KEY)).get()
        ?.appliedAt,
    ).toBe(AT);
  });

  it("全卷无教师待批 → graded，待自评行计分母不计分子", () => {
    const db = createTestDb();
    resetMarker(db);
    const studentId = makeStudent(db);
    const { attemptId } = legacyAttempt(
      db,
      studentId,
      [
        {
          questionId: "solve",
          snapshotJson: solveWithRef("solve"),
          patch: { gradingPolicy: null, autoCorrect: true, finalCorrect: true },
        },
        {
          questionId: "judge",
          snapshotJson: judge("judge"),
          patch: { gradingPolicy: null, autoCorrect: true, finalCorrect: true },
        },
      ],
      { status: "graded", submittedAt: AT, scoreAuto: 100, scoreFinal: 100 },
    );
    backfillDefaultGradingPolicy(db, new Date(AT));
    expect(attemptOf(db, attemptId)).toMatchObject({
      status: "graded",
      scoreFinal: 50,
      scoreAuto: 100,
    });
  });

  it("教师关闭自评：有参考题回落 manual_only（与开卷冻结同规则），卷回到 submitted", () => {
    const db = createTestDb();
    resetMarker(db);
    db.update(teachers)
      .set({ studentSelfReviewEnabled: false })
      .where(eq(teachers.id, TEST_TEACHER_ID))
      .run();
    const studentId = makeStudent(db);
    const { attemptId, rowIds } = legacyAttempt(
      db,
      studentId,
      [
        {
          questionId: "solve",
          snapshotJson: solveWithRef("solve"),
          patch: { gradingPolicy: null, autoCorrect: true, finalCorrect: true },
        },
      ],
      { status: "graded", submittedAt: AT, scoreAuto: 100, scoreFinal: 100 },
    );
    backfillDefaultGradingPolicy(db, new Date(AT));
    expect(rowOf(db, rowIds.get("solve") ?? "")).toMatchObject({
      gradingPolicy: "manual_only",
      autoCorrect: null,
      finalCorrect: null,
    });
    expect(attemptOf(db, attemptId)).toMatchObject({
      status: "submitted",
      scoreFinal: null,
      scoreAuto: null,
    });
  });

  it("进行中草稿：只补策略，不动卷级状态", () => {
    const db = createTestDb();
    resetMarker(db);
    const studentId = makeStudent(db);
    const { attemptId, rowIds } = legacyAttempt(db, studentId, [
      {
        questionId: "fill",
        snapshotJson: fillWithRef("fill"),
        patch: { gradingPolicy: null },
      },
    ]);
    backfillDefaultGradingPolicy(db, new Date(AT));
    expect(rowOf(db, rowIds.get("fill") ?? "")?.gradingPolicy).toBe(
      "reference_self",
    );
    expect(attemptOf(db, attemptId)).toMatchObject({
      status: "draft",
      scoreFinal: null,
      scoreAuto: null,
    });
  });

  it("幂等：完成标记在场即跳过，重复执行不再改动任何行", () => {
    const db = createTestDb();
    resetMarker(db);
    const studentId = makeStudent(db);
    const { rowIds } = legacyAttempt(db, studentId, [
      {
        questionId: "solve",
        snapshotJson: solveWithRef("solve"),
        patch: { gradingPolicy: null, autoCorrect: true, finalCorrect: true },
      },
    ]);
    backfillDefaultGradingPolicy(db, new Date(AT));
    const id = rowIds.get("solve") ?? "";
    const once = rowOf(db, id);
    backfillDefaultGradingPolicy(db, new Date("2026-11-01T00:00:00.000Z"));
    expect(rowOf(db, id)).toEqual(once);
    expect(
      db.select().from(dataMigrations).where(eq(dataMigrations.key, KEY)).all(),
    ).toEqual([{ key: KEY, appliedAt: AT }]);
  });
});
