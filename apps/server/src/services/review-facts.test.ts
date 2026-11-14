import { randomUUID } from "node:crypto";
import { studentReviewFact, teacherReviewFact } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { responses } from "../db/schema.ts";
import { TEST_TEACHER_ID } from "../db/test-utils.ts";
import { studentPracticeReadEnv } from "../test/student-mcp-practice-fixtures.ts";
import { settleStudentAttempt } from "./attempt-partial.ts";
import { getAttemptDetail } from "./attempt-service.ts";
import { createTextMemo } from "./memo-service.ts";
import { getTeacherAttemptDetail } from "./teacher-attempt-service.ts";

const opened: Awaited<ReturnType<typeof studentPracticeReadEnv>>[] = [];
afterEach(async () => {
  for (const e of opened.splice(0)) {
    await e.client.close();
    e.db.$client.close();
  }
});
it("同一真实结果在学生/教师的判定、用时、量表一致，未公布事实不泄露判定", async () => {
  const e = await studentPracticeReadEnv("class");
  opened.push(e);
  for (let i = 0; i < 2; i++)
    settleStudentAttempt(e.db, e.studentId, e.practiceId, {
      workflowVersion: 1,
      workflowRevision: 0,
      mutationId: randomUUID(),
      questions: [
        {
          questionId: `q-${i + 1}`,
          questionRevisionId: e.revisions[i]!,
          expectedAnswerRevision: 0,
          evidence: { questionId: `q-${i + 1}`, state: "none" },
        },
      ],
    });
  const row = e.db
    .select()
    .from(responses)
    .where(eq(responses.id, e.revisions[0]!))
    .get()!;
  const snapshot = JSON.parse(row.questionSnapshotJson!);
  e.db
    .update(responses)
    .set({
      activeSec: 37,
      gradingPolicy: "reference_self",
      autoCorrect: null,
      finalCorrect: null,
      selfReviewVerdict: "correct",
      selfReviewAt: new Date().toISOString(),
      questionSnapshotJson: JSON.stringify({
        ...snapshot,
        rubric: { levels: 4, items: [{ id: "r1", title: "结构" }] },
      }),
      rubricSelfJson: JSON.stringify({
        source: "self",
        ratings: [{ id: "r1", level: 3 }],
        note: "依据",
        at: new Date().toISOString(),
      }),
    })
    .where(eq(responses.id, row.id))
    .run();
  const memo = createTextMemo(e.db, {
    studentId: e.studentId,
    clientId: randomUUID(),
    text: "私有随笔正文",
    anchor: {
      kind: "question",
      attemptId: e.practiceId,
      questionId: "q-1",
      label: "本题",
    },
  }).memo;
  const result = getAttemptDetail(e.db, e.studentId, e.practiceId);
  if (!("summary" in result)) throw new Error("未得到结果");
  const unit = result.units[0]!;
  const question = unit.questions.find((q) => q.questionId === "q-1")!;
  const teacher = getTeacherAttemptDetail(e.db, TEST_TEACHER_ID, e.practiceId);
  const t = teacher.questions.find((q) => q.questionId === "q-1")!;
  const a = studentReviewFact(question, unit, true, result.activity);
  const b = teacherReviewFact(t, true);
  expect(a).toMatchObject({
    verdict: true,
    judgmentSource: "self",
    activeSec: 37,
    settlementSeq: 1,
  });
  expect({
    verdict: a.verdict,
    activeSec: a.activeSec,
    rubric: a.rubricReview,
  }).toEqual({
    verdict: b.verdict,
    activeSec: b.activeSec,
    rubric: b.rubricReview,
  });
  expect(studentReviewFact(question, unit, false)).toMatchObject({
    verdict: null,
    judgmentSource: null,
    rubricReview: null,
    gradingPolicy: null,
    retrainable: false,
  });
  expect(question.memoSequences).toEqual([memo.seq]);
  expect(JSON.stringify(result)).not.toContain("私有随笔正文");
  expect(t.memoSequences).toBeNull();
});
