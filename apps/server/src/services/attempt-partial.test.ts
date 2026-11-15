import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  attemptSettlements,
  attempts,
  responses,
  submissionEvidence,
  teachers,
} from "../db/schema.ts";
import { TEST_TEACHER_ID } from "../db/test-utils.ts";
import { studentPracticeReadEnv } from "../test/student-mcp-practice-fixtures.ts";
import { getAttemptDetail } from "./attempt-detail.ts";
import {
  getStudentSettlement,
  settleStudentAttempt,
} from "./attempt-partial.ts";
import { practiceQuestionFeedbackStateOf } from "./attempt-question-feedback.ts";
import { submitAttempt } from "./attempt-whole-submit.ts";
import {
  attemptWorkflowView,
  requireOwnActiveAttempt,
} from "./practice-workflow-wiring.ts";
import { createQuestionReviewReader } from "./review-access.ts";
import { saveRubricSelf } from "./rubric-review-service.ts";
import { submitSelfReview } from "./self-review-service.ts";

const opened: Awaited<ReturnType<typeof studentPracticeReadEnv>>[] = [];
afterEach(async () => {
  for (const env of opened.splice(0)) {
    await env.client.close();
    env.db.$client.close();
  }
});
async function setup() {
  const env = await studentPracticeReadEnv("class");
  opened.push(env);
  return env;
}
function request(env: Awaited<ReturnType<typeof setup>>, indexes = [0]) {
  return {
    workflowVersion: 1 as const,
    workflowRevision: 0,
    mutationId: randomUUID(),
    questions: indexes.map((index) => ({
      questionId: `q-${index + 1}`,
      questionRevisionId: env.revisions[index] ?? "",
      expectedAnswerRevision: 0,
      evidence: { questionId: `q-${index + 1}`, state: "none" as const },
    })),
  };
}
describe("分批提交事务", () => {
  it("只锁定本批，结果不包含批外题；同键重放不新增", async () => {
    const env = await setup();
    const req = request(env);
    const result = settleStudentAttempt(
      env.db,
      env.studentId,
      env.practiceId,
      req,
    );
    expect(result.settlement).toMatchObject({
      seq: 1,
      kind: "partial",
      questionCount: 1,
    });
    expect(result.questions.map((q) => q.questionId)).toEqual(["q-1"]);
    expect(JSON.stringify(result)).not.toContain('"q-2"');
    const before = env.db.select().from(responses).all();
    expect(
      settleStudentAttempt(env.db, env.studentId, env.practiceId, req),
    ).toEqual(result);
    expect(env.db.select().from(responses).all()).toEqual(before);
    expect(env.db.select().from(attemptSettlements).all()).toHaveLength(1);
    expect(before.find((q) => q.questionId === "q-2")?.submittedAt).toBeNull();
  });
  it("先分批再整卷：首回执与GET一致，旧批号保留且余题立即归入final", async () => {
    const env = await setup();
    settleStudentAttempt(env.db, env.studentId, env.practiceId, request(env));
    const first = env.db
      .select()
      .from(responses)
      .where(eq(responses.id, env.revisions[0] ?? ""))
      .get();
    const receipt = submitAttempt(env.db, env.studentId, env.practiceId);
    expect(
      receipt.units.flatMap((unit) =>
        unit.questions.map((question) => question.settlementSeq),
      ),
    ).toEqual([1, 2]);
    expect(getAttemptDetail(env.db, env.studentId, env.practiceId)).toEqual(
      receipt,
    );
    expect(
      env.db
        .select()
        .from(responses)
        .where(eq(responses.id, env.revisions[0] ?? ""))
        .get(),
    ).toEqual(first);
    expect(env.db.select().from(attemptSettlements).all()).toMatchObject([
      { seq: 1, kind: "partial", questionCount: 1 },
      { seq: 2, kind: "final", questionCount: 1 },
    ]);
  });

  it("任一答案版本冲突整批零写入", async () => {
    const env = await setup();
    const req = request(env, [0, 1]);
    const second = req.questions[1];
    if (!second) throw new Error("缺少第二题夹具");
    second.expectedAnswerRevision = 9;
    const before = env.db.select().from(responses).all();
    expect(() =>
      settleStudentAttempt(env.db, env.studentId, env.practiceId, req),
    ).toThrow();
    expect(env.db.select().from(responses).all()).toEqual(before);
    expect(env.db.select().from(attemptSettlements).all()).toEqual([]);
    expect(env.db.select().from(submissionEvidence).all()).toEqual([]);
  });
  it("最后一批只收尾一次并保留旧批成员", async () => {
    const env = await setup();
    settleStudentAttempt(env.db, env.studentId, env.practiceId, request(env));
    const old = env.db
      .select()
      .from(responses)
      .where(eq(responses.id, env.revisions[0] ?? ""))
      .get();
    const last = settleStudentAttempt(
      env.db,
      env.studentId,
      env.practiceId,
      request(env, [1]),
    );
    expect(last.settlement).toMatchObject({
      kind: "final",
      seq: 2,
      questionCount: 1,
    });
    expect(
      env.db
        .select()
        .from(responses)
        .where(eq(responses.id, env.revisions[0] ?? ""))
        .get(),
    ).toEqual(old);
    expect(
      env.db
        .select()
        .from(attempts)
        .where(eq(attempts.id, env.practiceId))
        .get()?.status,
    ).not.toBe("draft");
    expect(env.db.select().from(attemptSettlements).all()).toHaveLength(2);
  });
  it("学生自选交卷后反馈仍可分批；限时、legacy、lesson拒绝", async () => {
    const env = await setup();
    env.db
      .update(attempts)
      .set({ feedbackMode: "after_attempt" })
      .where(eq(attempts.id, env.practiceId))
      .run();
    expect(
      settleStudentAttempt(env.db, env.studentId, env.practiceId, request(env))
        .settlement.kind,
    ).toBe("partial");
    for (const patch of [
      { practiceWorkflowVersion: null },
      { sourceType: "lesson" as const },
    ]) {
      const other = await setup();
      other.db
        .update(attempts)
        .set(patch)
        .where(eq(attempts.id, other.practiceId))
        .run();
      expect(() =>
        settleStudentAttempt(
          other.db,
          other.studentId,
          other.practiceId,
          request(other),
        ),
      ).toThrow();
      expect(other.db.select().from(attemptSettlements).all()).toEqual([]);
    }
  });
  it("跨账号结果统一拒绝", async () => {
    const env = await setup();
    settleStudentAttempt(env.db, env.studentId, env.practiceId, request(env));
    expect(() =>
      getStudentSettlement(env.db, "other", env.practiceId, 1),
    ).toThrow();
  });
  it("教师收紧后本批秘密隐藏且拒绝新批；同键仍返回受限结果", async () => {
    const env = await setup();
    const req = request(env);
    settleStudentAttempt(env.db, env.studentId, env.practiceId, req);
    env.db
      .update(teachers)
      .set({ practiceFeedbackPolicy: "after_attempt" })
      .where(eq(teachers.id, TEST_TEACHER_ID))
      .run();
    const result = settleStudentAttempt(
      env.db,
      env.studentId,
      env.practiceId,
      req,
    );
    expect(result.answersReleased).toBe(false);
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toMatchObject({
      answers: null,
      solutionMd: null,
      autoCorrect: null,
      finalCorrect: null,
    });
    const before = env.db.select().from(responses).all();
    expect(() =>
      settleStudentAttempt(
        env.db,
        env.studentId,
        env.practiceId,
        request(env, [1]),
      ),
    ).toThrow();
    expect(env.db.select().from(responses).all()).toEqual(before);
  });
  it("限时卷拒绝且同键异内容不会生成另一批", async () => {
    const env = await setup();
    const req = request(env);
    settleStudentAttempt(env.db, env.studentId, env.practiceId, req);
    expect(() =>
      settleStudentAttempt(env.db, env.studentId, env.practiceId, {
        ...req,
        questions: request(env, [1]).questions,
      }),
    ).toThrow();
    const timed = await setup();
    timed.db
      .update(attempts)
      .set({ timeLimitSec: 60 })
      .where(eq(attempts.id, timed.practiceId))
      .run();
    expect(() =>
      settleStudentAttempt(
        timed.db,
        timed.studentId,
        timed.practiceId,
        request(timed),
      ),
    ).toThrow();
    expect(timed.db.select().from(attemptSettlements).all()).toEqual([]);
  });
  it("批外坏快照不能被丢弃并误自动收尾", async () => {
    const env = await setup();
    env.db
      .update(responses)
      .set({ questionSnapshotJson: "{}" })
      .where(eq(responses.id, env.revisions[1] ?? ""))
      .run();
    const before = env.db.select().from(responses).all();
    expect(() =>
      settleStudentAttempt(env.db, env.studentId, env.practiceId, request(env)),
    ).toThrow();
    expect(env.db.select().from(responses).all()).toEqual(before);
    expect(env.db.select().from(attemptSettlements).all()).toEqual([]);
  });
  it("after_attempt只释放真实归批行，同卷缓存不放开未归批行，教师收紧立即生效", async () => {
    const env = await setup();
    env.db
      .update(attempts)
      .set({ feedbackMode: "after_attempt" })
      .where(eq(attempts.id, env.practiceId))
      .run();
    const initial = env.db
      .select()
      .from(responses)
      .where(eq(responses.id, env.revisions[0] ?? ""))
      .get();
    if (!initial?.questionSnapshotJson) throw new Error("缺快照");
    const snapshot: Record<string, unknown> = JSON.parse(
      initial.questionSnapshotJson,
    );
    env.db
      .update(responses)
      .set({
        gradingPolicy: "reference_self",
        questionSnapshotJson: JSON.stringify({
          ...snapshot,
          rubric: { levels: 4, items: [{ id: "r1", title: "评价项" }] },
        }),
      })
      .where(eq(responses.id, initial.id))
      .run();
    settleStudentAttempt(env.db, env.studentId, env.practiceId, request(env));
    expect(() =>
      submitSelfReview(env.db, env.studentId, env.practiceId, "q-1", {
        verdict: "correct",
        baseRevision: 0,
        mutationId: randomUUID(),
      }),
    ).not.toThrow();
    expect(() =>
      saveRubricSelf(env.db, env.studentId, env.practiceId, "q-1", {
        ratings: [{ id: "r1", level: 3 }],
        note: "",
      }),
    ).not.toThrow();
    const attempt = requireOwnActiveAttempt(
      env.db,
      env.studentId,
      env.practiceId,
    );
    const rows = env.db.select().from(responses).all();
    const settled = rows.find((r) => r.questionId === "q-1");
    const other = rows.find((r) => r.questionId === "q-2");
    if (!settled || !other) throw new Error("缺少题目");
    const unassigned = { ...other, submittedAt: settled.submittedAt };
    expect(
      practiceQuestionFeedbackStateOf(env.db, attempt, settled).status,
    ).toBe("released");
    expect(
      practiceQuestionFeedbackStateOf(env.db, attempt, unassigned).status,
    ).toBe("pending_attempt");
    expect(
      attemptWorkflowView(env.db, attempt)?.questionProgress.find(
        (row) => row.questionId === "q-1",
      )?.feedbackReadable,
    ).toBe(true);
    const read = createQuestionReviewReader(env.db, new Date());
    expect(read(attempt, settled)).toBe(true);
    expect(read(attempt, unassigned)).toBe(false);
    const readReverse = createQuestionReviewReader(env.db, new Date());
    expect(readReverse(attempt, unassigned)).toBe(false);
    expect(readReverse(attempt, settled)).toBe(true);
    env.db
      .update(teachers)
      .set({ practiceFeedbackPolicy: "after_attempt" })
      .where(eq(teachers.id, TEST_TEACHER_ID))
      .run();
    expect(
      practiceQuestionFeedbackStateOf(env.db, attempt, settled).status,
    ).not.toBe("released");
    expect(
      createQuestionReviewReader(env.db, new Date())(attempt, settled),
    ).toBe(false);
  });
});
