import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { attempts, responses } from "../db/schema";
import { createTestDb } from "../db/test-utils";
import { frozenDraftAttempt, snapshotJsonOf } from "../test/evidence-fixtures";
import { memoSourceFixture } from "../test/memo-source-fixtures";
import { makeStudent } from "../test/note-fixtures";
import { createTextMemo } from "./memo-service";
import { memoSourceTarget } from "./memo-source-target";

it("本人冻结题可回链且解析纯读，作废后安全降级、不自动开卷", () => {
  const db = createTestDb();
  const studentId = makeStudent(db);
  const { attemptId } = frozenDraftAttempt(db, studentId, [
    { questionId: "q1", snapshotJson: snapshotJsonOf({ id: "q1" }) },
  ]);
  const memo = createTextMemo(db, {
    studentId,
    clientId: randomUUID(),
    text: "来源",
    anchor: { kind: "question", attemptId, questionId: "q1", label: "原题" },
  }).memo;
  const digest = () =>
    createHash("sha256").update(db.$client.serialize()).digest("hex");
  const before = digest();
  expect(memoSourceTarget(db, studentId, memo.id)).toEqual({
    kind: "attempt",
    attemptId,
    questionId: "q1",
    replaced: false,
  });
  expect(digest()).toBe(before);
  db.update(attempts)
    .set({ abandonedAt: new Date().toISOString() })
    .where(eq(attempts.id, attemptId))
    .run();
  expect(memoSourceTarget(db, studentId, memo.id)).toEqual({
    kind: "unavailable",
  });
  expect(() => memoSourceTarget(db, makeStudent(db), memo.id)).toThrow();
});

it("跨单元assignment的冻结response可回题，同题不同学生/课程/单元不能替代", () => {
  const f = memoSourceFixture();
  f.makeAttempt(f.otherId);
  f.makeAttempt(f.studentId, f.otherCourseId);
  f.makeAttempt(f.studentId, f.courseId, f.otherUnitId);
  expect(memoSourceTarget(f.db, f.studentId, f.memo.id)).toEqual({
    kind: "unit",
    courseId: f.courseId,
    unitId: f.unitId,
  });
  const expected = f.makeAttempt();
  expect(memoSourceTarget(f.db, f.studentId, f.memo.id)).toEqual({
    kind: "attempt",
    attemptId: expected,
    questionId: "q1",
    replaced: true,
  });
});
it("旧单单元卷冻结行unitId为空时仅按明确卷级单元回退", () => {
  const f = memoSourceFixture();
  const candidate = f.makeAttempt();
  f.db
    .update(responses)
    .set({ unitId: null })
    .where(eq(responses.attemptId, candidate))
    .run();
  f.db
    .update(attempts)
    .set({ unitId: f.unitId })
    .where(eq(attempts.id, candidate))
    .run();
  expect(memoSourceTarget(f.db, f.studentId, f.memo.id)).toEqual({
    kind: "attempt",
    attemptId: candidate,
    questionId: "q1",
    replaced: true,
  });
});
