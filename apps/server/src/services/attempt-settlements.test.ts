import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { attempts, responses } from "../db/schema.ts";
import { TEST_TEACHER_ID } from "../db/test-utils.ts";
import {
  at,
  closeTimingFixtures,
  timingFixture,
} from "../test/submission-time-fixture.ts";
import { saveDraftAnswer } from "./attempt-answer.ts";
import { autoFinishPerQuestionAttempt } from "./attempt-auto-finish.ts";
import { submitPracticeQuestion } from "./attempt-question-submit.ts";
import { submitAttempt } from "./attempt-whole-submit.ts";
import { markResponse } from "./mark-response.ts";

afterEach(closeTimingFixtures);
const settlements = (env: ReturnType<typeof timingFixture>) =>
  env.db.$client
    .prepare(
      "SELECT seq,kind,created_at,question_count,active_sec FROM attempt_settlements WHERE attempt_id=? ORDER BY seq",
    )
    .all(env.attemptId);
const members = (env: ReturnType<typeof timingFixture>) =>
  env.db.$client
    .prepare(
      "SELECT settlement_seq FROM responses WHERE attempt_id=? ORDER BY rowid",
    )
    .pluck()
    .all(env.attemptId);

it("行提交锁早于结算归属；教师批改改变判定但不改结算事实", () => {
  const env = timingFixture();
  env.submit("q1", 10);
  expect(env.row("q1").settlementSeq).toBeNull();
  expect(() =>
    saveDraftAnswer(env.db, env.studentId, env.attemptId, "q1", {
      kind: "judge",
      value: true,
    }),
  ).toThrow("已经提交过");
  env.submit("q2", 20);
  const fact = settlements(env);
  markResponse(env.db, TEST_TEACHER_ID, env.row("q1").id, {
    mark: "correct",
    comment: null,
  });
  expect(env.row("q1").finalCorrect).toBe(true);
  expect(settlements(env)).toEqual(fact);
  expect(members(env)).toEqual([1, 1]);
});

it("已有结算覆盖全部行时，final为零成员终结标记且不重复归属", () => {
  const env = timingFixture();
  env.db.$client
    .prepare(
      "INSERT INTO attempt_settlements(id,attempt_id,seq,kind,created_at,question_count,active_sec,mutation_id,request_digest) VALUES(?,?,1,'partial',?,2,0,'fixture-partial','digest')",
    )
    .run(randomUUID(), env.attemptId, at(10));
  env.db
    .update(responses)
    .set({
      submittedAt: at(10),
      settlementSeq: 1,
      activeSec: 0,
      autoCorrect: false,
      finalCorrect: false,
    })
    .run();
  const receipt = submitAttempt(env.db, env.studentId, env.attemptId, at(20));
  expect(
    receipt.units.flatMap((unit) =>
      unit.questions.map((question) => question.settlementSeq),
    ),
  ).toEqual([1, 1]);
  expect(settlements(env)).toMatchObject([
    { kind: "partial", question_count: 2 },
    { seq: 2, kind: "final", question_count: 0, active_sec: null },
  ]);
  expect(members(env)).toEqual([1, 1]);
});

describe.each(["wrong", "lesson"] as const)("%s final 成员与行锁", (source) => {
  it("全逐题提交的剩余未提交题为0，但final仍收纳全部未结算行", () => {
    const env = timingFixture(source);
    env.event("question_focus", 1, "q1");
    env.event("question_blur", 9, "q1");
    env.submit("q1", 10);
    expect(settlements(env)).toHaveLength(0);
    expect(members(env)).toEqual([null, null]);
    env.submit("q2", 20);
    expect(settlements(env)).toEqual([
      {
        seq: 1,
        kind: "final",
        created_at: at(20),
        question_count: 2,
        active_sec: 8,
      },
    ]);
    expect(members(env)).toEqual([1, 1]);
    expect(() =>
      submitAttempt(env.db, env.studentId, env.attemptId, at(30)),
    ).toThrow("已经交过卷");
    env.db.transaction((tx) =>
      autoFinishPerQuestionAttempt(tx, env.attemptId, at(31)),
    );
    expect(settlements(env)).toHaveLength(1);
  });
  it("部分逐题后整卷，保留判定、证据和封存时间", () => {
    const env = timingFixture(source);
    env.submit("q1", 10);
    env.db
      .update(responses)
      .set({ teacherMark: "correct", finalCorrect: true, activeSec: 0 })
      .where(eq(responses.id, env.row("q1").id))
      .run();
    const before = env.row("q1");
    submitAttempt(env.db, env.studentId, env.attemptId, at(20));
    expect(env.row("q1")).toEqual({ ...before, settlementSeq: 1 });
    expect(settlements(env)).toMatchObject([
      { question_count: 2, active_sec: 0 },
    ]);
  });
  it("final写入失败，最后一题和收尾状态/事件均回滚", () => {
    const env = timingFixture(source);
    env.submit("q1", 10);
    env.db.$client.exec(
      "CREATE TRIGGER fail_final BEFORE INSERT ON attempt_settlements BEGIN SELECT RAISE(ABORT,'测试结算失败'); END",
    );
    expect(() => env.submit("q2", 20)).toThrow("测试结算失败");
    expect(env.row("q2").submittedAt).toBeNull();
    expect(env.db.select().from(attempts).get()?.status).toBe("draft");
    expect(
      env.db.$client
        .prepare("SELECT count(*) FROM events WHERE type='question_submit'")
        .pluck()
        .get(),
    ).toBe(1);
    expect(members(env)).toEqual([null, null]);
  });
});

it("零题卷与坏快照占位：成员覆盖全部responses，不改变判分范围", () => {
  const empty = timingFixture();
  empty.db.delete(responses).run();
  submitAttempt(empty.db, empty.studentId, empty.attemptId, at(10), {
    revisions: [],
  });
  expect(settlements(empty)).toMatchObject([
    { question_count: 0, active_sec: null },
  ]);
  const bad = timingFixture();
  bad.db
    .update(responses)
    .set({ questionSnapshotJson: null })
    .where(eq(responses.id, bad.row("q2").id))
    .run();
  const result = submitAttempt(bad.db, bad.studentId, bad.attemptId, at(10));
  expect(result.summary.total).toBe(1);
  expect(settlements(bad)).toMatchObject([{ question_count: 2 }]);
  expect(members(bad)).toEqual([1, 1]);
});

it("旧协议保留行submittedAt为空；final成员并非提交锁", () => {
  const env = timingFixture();
  env.db
    .update(attempts)
    .set({ practiceWorkflowVersion: null, feedbackMode: null })
    .run();
  submitAttempt(env.db, env.studentId, env.attemptId, at(10));
  expect(env.row("q1").submittedAt).toBeNull();
  expect(members(env)).toEqual([1, 1]);
});

it("普通逐题末题同键重放不重复结算，异摘要和异键仍冲突", () => {
  const env = timingFixture();
  env.submit("q1", 10);
  const req = env.practiceRequest("q2");
  const submit = (request = req) =>
    submitPracticeQuestion(
      env.db,
      env.studentId,
      env.attemptId,
      "q2",
      request,
      at(20),
    );
  submit();
  submit();
  expect(settlements(env)).toHaveLength(1);
  expect(() => submit({ ...req, expectedAnswerRevision: 1 })).toThrow(
    "请求内容不一致",
  );
  expect(() => submit({ ...req, submissionMutationId: randomUUID() })).toThrow(
    "已经提交过",
  );
});

it("成员写入失败整体回滚，版本校验失败不写任何结算", () => {
  const env = timingFixture();
  expect(() =>
    submitAttempt(env.db, env.studentId, env.attemptId, at(10), {
      revisions: [],
    }),
  ).toThrow();
  expect(settlements(env)).toEqual([]);
  env.db.$client.exec(
    "CREATE TRIGGER fail_member BEFORE UPDATE OF settlement_seq ON responses BEGIN SELECT RAISE(ABORT,'测试成员失败'); END",
  );
  expect(() =>
    submitAttempt(env.db, env.studentId, env.attemptId, at(10)),
  ).toThrow("测试成员失败");
  expect(settlements(env)).toEqual([]);
  expect(members(env)).toEqual([null, null]);
  expect(env.row("q1").autoCorrect).toBeNull();
  expect(env.db.select().from(attempts).get()?.status).toBe("draft");
});
