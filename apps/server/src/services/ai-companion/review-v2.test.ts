import { randomUUID } from "node:crypto";
import { REVIEW_V2_SECTIONS } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import {
  assignments,
  attemptSettlements,
  attempts,
  responses,
  reviewV2Audit,
  reviewV2Runs,
  reviewV2Tasks,
  teachers,
} from "../../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../../db/test-utils.ts";
import {
  insertAttempt,
  insertResponse,
} from "../../test/ai-companion-fixtures.ts";
import { makeStudent } from "../../test/note-fixtures.ts";
import {
  cancelReviewV2Run,
  claimReviewV2Task,
  createReviewV2Run,
  getReviewV2Run,
  submitReviewV2Report,
} from "./review-v2.ts";

const opened: ReturnType<typeof createTestDb>[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.$client.close();
});
const options = { hmacSecret: "review-v2-test-secret-0001" };
function world(count: number) {
  const db = createTestDb();
  opened.push(db);
  db.update(teachers)
    .set({ passwordHash: "scrypt$fixture" })
    .where(eq(teachers.id, TEST_TEACHER_ID))
    .run();
  const studentId = makeStudent(db),
    otherId = makeStudent(db);
  const attemptId = insertAttempt(db, { studentId });
  for (let i = 0; i < count; i++) insertResponse(db, attemptId, `q-${i + 1}`);
  db.update(attempts)
    .set({ status: "submitted", submittedAt: new Date().toISOString() })
    .where(eq(attempts.id, attemptId))
    .run();
  db.update(responses)
    .set({ submittedAt: new Date().toISOString(), answered: true })
    .where(eq(responses.attemptId, attemptId))
    .run();
  return { db, studentId, otherId, attemptId };
}
const request = () => ({
  mutationId: randomUUID(),
  purpose: "分析本次练习",
  profile: "objective" as const,
  scope: { kind: "attempt" as const },
});
function report(questionNo: number) {
  return {
    schemaVersion: 2 as const,
    profile: "objective" as const,
    sections: REVIEW_V2_SECTIONS.objective.map((section) => ({
      ...section,
      markdown: "平台事实与假设分列",
      evidenceQuestionNos: [questionNo],
    })),
    limitations: ["没有笔迹图像"],
  };
}
it("105题原子创建4片和一个阻塞汇总，同键重放不重复", () => {
  const e = world(105),
    input = request();
  const run = createReviewV2Run(e.db, e.studentId, e.attemptId, input, options);
  expect(run.tasks.map((task) => task.questionNos.length)).toEqual([
    30, 30, 30, 15, 105,
  ]);
  expect(run.tasks.at(-1)?.status).toBe("blocked");
  expect(
    createReviewV2Run(e.db, e.studentId, e.attemptId, input, options),
  ).toEqual(run);
  expect(e.db.select().from(reviewV2Tasks).all()).toHaveLength(5);
  expect(() => getReviewV2Run(e.db, e.otherId, run.id, options)).toThrow();
  expect(JSON.stringify(run)).not.toMatch(
    /referenceAnswerMd|solutionMd|leaseToken|snapshotJson/,
  );
});
it("分片先完成才可领汇总；汇总只读报告且越界证据被拒绝", () => {
  const e = world(31),
    run = createReviewV2Run(e.db, e.studentId, e.attemptId, request(), options);
  const summary = run.tasks.at(-1)!;
  expect(() =>
    claimReviewV2Task(e.db, e.studentId, summary.id, options),
  ).toThrow();
  for (const part of run.tasks.slice(0, -1)) {
    const claimed = claimReviewV2Task(e.db, e.studentId, part.id, options);
    expect(() =>
      submitReviewV2Report(
        e.db,
        e.studentId,
        {
          taskId: part.id,
          leaseToken: claimed.leaseToken,
          generation: claimed.generation,
          snapshotVersion: claimed.snapshot.snapshotVersion,
          report: report(999),
        },
        options,
      ),
    ).toThrow();
    const payload = {
      taskId: part.id,
      leaseToken: claimed.leaseToken,
      generation: claimed.generation,
      snapshotVersion: claimed.snapshot.snapshotVersion,
      report: report(part.questionNos[0]!),
    };
    expect(
      submitReviewV2Report(e.db, e.studentId, payload, options).duplicate,
    ).toBe(false);
    expect(
      submitReviewV2Report(e.db, e.studentId, payload, options).duplicate,
    ).toBe(true);
  }
  expect(
    getReviewV2Run(e.db, e.studentId, run.id, options).tasks.at(-1)?.status,
  ).toBe("created");
  const claimed = claimReviewV2Task(e.db, e.studentId, summary.id, options);
  expect(claimed.snapshot.kind).toBe("summary");
  expect(JSON.stringify(claimed.snapshot)).not.toMatch(
    /referenceAnswerMd|solutionMd|stemMd|studentAnswerText/,
  );
  expect(claimed.snapshot).not.toHaveProperty("questions");
});

it("超出统一待处理配额时整张任务图回滚", () => {
  const e = world(301);
  expect(() =>
    createReviewV2Run(e.db, e.studentId, e.attemptId, request(), options),
  ).toThrow(/上限/);
  expect(e.db.select().from(reviewV2Tasks).all()).toHaveLength(0);
  expect(e.db.select().from(reviewV2Runs).all()).toHaveLength(0);
});
it("租约过期与取消后不能写报告，旧代也不能覆盖新代", () => {
  const e = world(1),
    run = createReviewV2Run(e.db, e.studentId, e.attemptId, request(), options),
    task = run.tasks[0];
  if (!task) throw new Error("缺少测试任务");
  const now = new Date("2026-11-14T12:00:00Z");
  const first = claimReviewV2Task(e.db, e.studentId, task.id, {
    ...options,
    now,
  });
  const payload = {
    taskId: task.id,
    leaseToken: first.leaseToken,
    generation: first.generation,
    snapshotVersion: first.snapshot.snapshotVersion,
    report: report(1),
  };
  const later = { ...options, now: new Date(now.getTime() + 11 * 60_000) };
  expect(() => submitReviewV2Report(e.db, e.studentId, payload, later)).toThrow(
    /租约/,
  );
  const second = claimReviewV2Task(e.db, e.studentId, task.id, later);
  expect(second.generation).toBe(first.generation + 1);
  expect(() => submitReviewV2Report(e.db, e.studentId, payload, later)).toThrow(
    /代次/,
  );
  expect(e.db.select().from(reviewV2Tasks).all()[0]?.reportJson).toBeNull();
  expect(
    e.db
      .select()
      .from(reviewV2Audit)
      .all()
      .map((fact) => fact.type),
  ).toEqual(["late_reply", "late_reply"]);
  cancelReviewV2Run(e.db, e.studentId, run.id, later);
  expect(() =>
    submitReviewV2Report(
      e.db,
      e.studentId,
      {
        ...payload,
        leaseToken: second.leaseToken,
        generation: second.generation,
      },
      later,
    ),
  ).toThrow();
  expect(e.db.select().from(reviewV2Audit).all()).toHaveLength(3);
});

it("批次复盘只含本批已提交成员，不能读取批外题", () => {
  const e = world(3);
  e.db
    .update(attempts)
    .set({
      status: "draft",
      sourceType: "wrong",
      assignmentId: null,
      practiceWorkflowVersion: 1,
      feedbackMode: "after_attempt",
    })
    .where(eq(attempts.id, e.attemptId))
    .run();
  const rows = e.db
    .select()
    .from(responses)
    .where(eq(responses.attemptId, e.attemptId))
    .all();
  e.db
    .insert(attemptSettlements)
    .values({
      id: randomUUID(),
      attemptId: e.attemptId,
      seq: 1,
      kind: "partial",
      questionCount: 2,
      createdAt: new Date().toISOString(),
      mutationId: "batch",
      requestDigest: "fixture",
    })
    .run();
  for (const row of rows)
    e.db
      .update(responses)
      .set(
        row.questionId === "q-3" ? { submittedAt: null } : { settlementSeq: 1 },
      )
      .where(eq(responses.id, row.id))
      .run();
  const run = createReviewV2Run(
    e.db,
    e.studentId,
    e.attemptId,
    { ...request(), scope: { kind: "settlement", seq: 1 } },
    options,
  );
  expect(run.questionCount).toBe(2);
  const task = run.tasks[0];
  if (!task) throw new Error("缺少任务");
  const claim = claimReviewV2Task(e.db, e.studentId, task.id, options);
  expect(JSON.stringify(claim.snapshot)).not.toContain("q-3");
  expect(task.questionNos).toHaveLength(2);
});
it("教师收紧公布后读取/领取/回写均拒绝，但本人仍可取消", () => {
  const e = world(1),
    run = createReviewV2Run(e.db, e.studentId, e.attemptId, request(), options);
  const task = run.tasks[0];
  if (!task) throw new Error("缺少任务");
  const claim = claimReviewV2Task(e.db, e.studentId, task.id, options);
  const attempt = e.db
    .select()
    .from(attempts)
    .where(eq(attempts.id, e.attemptId))
    .get();
  if (!attempt?.assignmentId) throw new Error("缺少作业");
  e.db
    .update(assignments)
    .set({ answerRelease: "after_due", dueAt: "2099-01-01T00:00:00Z" })
    .where(eq(assignments.id, attempt.assignmentId))
    .run();
  expect(() => getReviewV2Run(e.db, e.studentId, run.id, options)).toThrow(
    /公布/,
  );
  expect(() => claimReviewV2Task(e.db, e.studentId, task.id, options)).toThrow(
    /公布/,
  );
  expect(() =>
    submitReviewV2Report(
      e.db,
      e.studentId,
      {
        taskId: task.id,
        leaseToken: claim.leaseToken,
        generation: claim.generation,
        snapshotVersion: claim.snapshot.snapshotVersion,
        report: report(1),
      },
      options,
    ),
  ).toThrow(/公布/);
  expect(cancelReviewV2Run(e.db, e.studentId, run.id, options)).toEqual({
    cancelled: true,
  });
  expect(e.db.select().from(reviewV2Tasks).all()[0]?.reportJson).toBeNull();
});
it("无法容纳的单题明确拒绝且不留下部分任务图", () => {
  const e = world(1),
    row = e.db
      .select()
      .from(responses)
      .where(eq(responses.attemptId, e.attemptId))
      .get();
  if (!row?.questionSnapshotJson) throw new Error("缺少快照");
  const q = JSON.parse(row.questionSnapshotJson) as Record<string, unknown>;
  e.db
    .update(responses)
    .set({
      questionSnapshotJson: JSON.stringify({
        ...q,
        stemMd: "题".repeat(100000),
      }),
    })
    .where(eq(responses.id, row.id))
    .run();
  expect(() =>
    createReviewV2Run(e.db, e.studentId, e.attemptId, request(), options),
  ).toThrow(/单片/);
  expect(e.db.select().from(reviewV2Runs).all()).toHaveLength(0);
});
it("数据库也保护已交付报告与迟到事实，不允许直接覆盖或删除", () => {
  const e = world(1),
    run = createReviewV2Run(e.db, e.studentId, e.attemptId, request(), options),
    task = run.tasks[0];
  if (!task) throw new Error("缺少任务");
  const claimed = claimReviewV2Task(e.db, e.studentId, task.id, options);
  const payload = {
    taskId: task.id,
    leaseToken: claimed.leaseToken,
    generation: claimed.generation,
    snapshotVersion: claimed.snapshot.snapshotVersion,
    report: report(1),
  };
  submitReviewV2Report(e.db, e.studentId, payload, options);
  expect(() =>
    submitReviewV2Report(
      e.db,
      e.studentId,
      { ...payload, generation: claimed.generation + 1 },
      options,
    ),
  ).toThrow();
  expect(() =>
    e.db.$client
      .prepare("UPDATE ai_review_v2_tasks SET report_json='{}' WHERE id=?")
      .run(task.id),
  ).toThrow(/immutable/);
  expect(() =>
    e.db.$client
      .prepare("DELETE FROM ai_review_v2_audit WHERE task_id=?")
      .run(task.id),
  ).toThrow(/append_only/);
});
