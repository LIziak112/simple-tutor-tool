import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { attempts, events, responses } from "../db/schema.ts";
import {
  at,
  closeTimingFixtures,
  timingFixture,
} from "../test/submission-time-fixture.ts";
import { submitPracticeQuestion } from "./attempt-question-submit.ts";
import { submitAttempt } from "./attempt-whole-submit.ts";

afterEach(closeTimingFixtures);

describe.each(["wrong", "lesson"] as const)("%s 逐题焦点用时封存", (source) => {
  it("每次提交封存本题；最后一题只合计封存值，回看不计入", () => {
    const env = timingFixture(source);
    env.event("question_focus", 1, "q1");
    env.event("question_blur", 9, "q1");
    env.submit("q1", 10);
    expect(env.row("q1").activeSec).toBe(8);
    env.event("question_focus", 11, "q1");
    env.event("question_blur", 16, "q1");
    env.event("question_focus", 17, "q2");
    env.event("question_blur", 21, "q2");
    env.submit("q2", 22);
    expect(env.row("q1").activeSec).toBe(8);
    expect(env.row("q2").activeSec).toBe(4);
    expect(env.db.select().from(attempts).get()?.activeSec).toBe(12);
    env.event("question_focus", 30, "q2");
    env.event("question_blur", 90, "q2");
    expect(env.row("q2").activeSec).toBe(4);
    expect(env.db.select().from(attempts).get()?.activeSec).toBe(12);
    expect(
      env.db
        .select()
        .from(events)
        .all()
        .filter((e) => e.type === "submit"),
    ).toHaveLength(1);
  });

  it("无聚焦保留 NULL；有聚焦的真实零秒不变成 NULL", () => {
    const env = timingFixture(source);
    env.submit("q1", 10);
    expect(env.row("q1").activeSec).toBeNull();
    env.event("question_focus", 20, "q2");
    env.event("question_blur", 20, "q2");
    env.submit("q2", 21);
    expect(env.db.select().from(attempts).get()?.activeSec).toBe(0);
    expect(env.row("q2").activeSec).toBe(0);
  });

  it("计时、判分和提交事件共事务，事件写入失败整体回滚", () => {
    const env = timingFixture(source);
    env.event("question_focus", 1, "q1");
    env.event("question_blur", 9, "q1");
    env.db.$client.exec(
      "CREATE TRIGGER fail_submit_event BEFORE INSERT ON events WHEN NEW.type='question_submit' BEGIN SELECT RAISE(ABORT,'测试提交事件失败'); END",
    );
    expect(() => env.submit("q1", 10)).toThrow("测试提交事件失败");
    expect(env.row("q1")).toMatchObject({
      activeSec: null,
      submittedAt: null,
      autoCorrect: null,
    });
    expect(env.db.select().from(attempts).get()).toMatchObject({
      status: "draft",
      activeSec: null,
    });
  });
});

it("部分逐题后整卷：8+4=12，不包含首题5秒回看或未知题聚焦", () => {
  const env = timingFixture();
  env.event("question_focus", 1, "q1");
  env.event("question_blur", 9, "q1");
  env.submit("q1", 10);
  // 兼容已经封存的非空旧账，收尾不能覆盖。
  env.db
    .update(responses)
    .set({ activeSec: 8 })
    .where(eq(responses.id, env.row("q1").id))
    .run();
  env.event("question_focus", 11, "q1");
  env.event("question_blur", 16, "q1");
  env.event("question_focus", 17, "q2");
  env.event("question_blur", 21, "q2");
  env.event("question_focus", 22, "foreign-q");
  env.event("question_blur", 32, "foreign-q");
  submitAttempt(env.db, env.studentId, env.attemptId, at(33));
  expect(env.row("q1").activeSec).toBe(8);
  expect(env.row("q2").activeSec).toBe(4);
  expect(env.db.select().from(attempts).get()?.activeSec).toBe(12);
});

it("重放不会采纳后续回看，失败的版本和证据验证不写时间", () => {
  const env = timingFixture();
  env.event("question_focus", 1, "q1");
  env.event("question_blur", 9, "q1");
  const req = env.practiceRequest("q1");
  expect(() =>
    submitPracticeQuestion(
      env.db,
      env.studentId,
      env.attemptId,
      "q1",
      { ...req, questionRevisionId: randomUUID() },
      at(10),
    ),
  ).toThrow();
  expect(env.row("q1").activeSec).toBeNull();
  expect(() =>
    submitPracticeQuestion(
      env.db,
      env.studentId,
      env.attemptId,
      "q1",
      { ...req, evidence: { questionId: "q2", state: "none" } },
      at(10),
    ),
  ).toThrow();
  expect(env.row("q1").activeSec).toBeNull();
  submitPracticeQuestion(
    env.db,
    env.studentId,
    env.attemptId,
    "q1",
    req,
    at(10),
  );
  env.event("question_focus", 11, "q1");
  env.event("question_blur", 20, "q1");
  submitPracticeQuestion(
    env.db,
    env.studentId,
    env.attemptId,
    "q1",
    req,
    at(21),
  );
  expect(env.row("q1").activeSec).toBe(8);
  expect(
    env.db
      .select()
      .from(events)
      .all()
      .filter((e) => e.type === "question_submit"),
  ).toHaveLength(1);
});

it("两题无事件整卷交卷仍为 NULL，不改草稿计数或判分", () => {
  const env = timingFixture();
  submitAttempt(env.db, env.studentId, env.attemptId, at(10));
  expect(env.db.select().from(attempts).get()?.activeSec).toBeNull();
  expect(env.row("q1")).toMatchObject({
    activeSec: null,
    changeCount: 0,
    autoCorrect: false,
  });
});
