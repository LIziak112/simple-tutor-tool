import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { responses, students } from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { frozenDraftAttempt } from "../test/evidence-fixtures.ts";
import {
  effectiveVerdictOfRow,
  effectiveVerdictSourceSql,
  effectiveVerdictValueSql,
} from "./response-verdict.ts";

it("SQLite 分页筛选与 TypeScript 有效判定共享相同边界向量", () => {
  const db = createTestDb();
  const studentId = "self-review-vector";
  db.insert(students)
    .values({
      id: studentId,
      teacherId: TEST_TEACHER_ID,
      displayName: "自评测试",
      loginName: "self-review-vector",
      linkToken: "self-review-vector-link",
      createdAt: "2026-10-01T00:00:00.000Z",
    })
    .run();
  const at = "2026-10-01T00:00:00.000Z";
  const vectors = [
    {
      teacherMark: "correct",
      selfReviewVerdict: "wrong",
      selfReviewAt: at,
      autoCorrect: false,
    },
    {
      teacherMark: "wrong",
      selfReviewVerdict: "correct",
      selfReviewAt: at,
      autoCorrect: true,
    },
    {
      teacherMark: null,
      selfReviewVerdict: "correct",
      selfReviewAt: at,
      autoCorrect: false,
    },
    {
      teacherMark: null,
      selfReviewVerdict: "wrong",
      selfReviewAt: at,
      autoCorrect: true,
    },
    {
      teacherMark: null,
      selfReviewVerdict: null,
      selfReviewAt: null,
      autoCorrect: false,
    },
    {
      teacherMark: null,
      selfReviewVerdict: null,
      selfReviewAt: null,
      autoCorrect: true,
    },
    {
      teacherMark: null,
      selfReviewVerdict: null,
      selfReviewAt: null,
      autoCorrect: null,
    },
    {
      teacherMark: null,
      selfReviewVerdict: "wrong",
      selfReviewAt: null,
      autoCorrect: true,
    },
    {
      teacherMark: null,
      selfReviewVerdict: "wrong",
      selfReviewAt: "",
      autoCorrect: true,
    },
  ] as const;
  const { attemptId } = frozenDraftAttempt(
    db,
    studentId,
    vectors.map((_, index) => ({
      questionId: String(index),
      snapshotJson: null,
    })),
  );
  for (const [index, vector] of vectors.entries()) {
    db.update(responses)
      .set(vector)
      .where(eq(responses.questionId, String(index)))
      .run();
  }
  const rows = db
    .select({
      teacherMark: responses.teacherMark,
      selfReviewVerdict: responses.selfReviewVerdict,
      selfReviewAt: responses.selfReviewAt,
      selfReviewRevision: responses.selfReviewRevision,
      autoCorrect: responses.autoCorrect,
      source: effectiveVerdictSourceSql,
      value: effectiveVerdictValueSql,
    })
    .from(responses)
    .where(eq(responses.attemptId, attemptId))
    .all();
  expect(rows).toHaveLength(vectors.length);
  for (const row of rows) {
    const verdict = effectiveVerdictOfRow(row);
    expect(row.source).toBe(verdict?.source ?? null);
    expect(row.value).toBe(verdict === null ? null : Number(verdict.value));
  }
});
