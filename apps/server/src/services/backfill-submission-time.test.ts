import { attemptEventBatchRequestSchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { attempts, events, responses } from "../db/schema.ts";
import {
  at,
  closeTimingFixtures,
  timingFixture,
} from "../test/submission-time-fixture.ts";
import { submitAttempt } from "./attempt-whole-submit.ts";
import { backfillSubmissionTime } from "./backfill-submission-time.ts";
import { appendAttemptEvents } from "./event-service.ts";

afterEach(closeTimingFixtures);

function oldCompleted() {
  const env = timingFixture();
  env.event("question_focus", 1, "q1");
  env.event("question_blur", 9, "q1");
  env.submit("q1", 10);
  env.event("question_focus", 11, "q1");
  env.event("question_blur", 16, "q1");
  env.event("question_focus", 17, "q2");
  env.event("question_blur", 21, "q2");
  env.submit("q2", 22);
  env.event("question_focus", 23, "q2");
  env.event("question_blur", 90, "q2");
  env.db
    .update(responses)
    .set({ activeSec: null })
    .where(eq(responses.attemptId, env.attemptId))
    .run();
  env.db
    .update(attempts)
    .set({ activeSec: null })
    .where(eq(attempts.id, env.attemptId))
    .run();
  return env;
}

it("dry-run 不写；按每题成功边界回放，副本 apply 得到8+4而非回看时间；重复零写入", () => {
  const env = oldCompleted();
  const originalEvents = env.db.select().from(events).all();
  expect(backfillSubmissionTime(env.db.$client)).toMatchObject({
    plannedRows: 2,
    writtenRows: 0,
    plannedAttempts: 1,
    writtenAttempts: 0,
  });
  expect(env.row("q1").activeSec).toBeNull();
  const applied = backfillSubmissionTime(env.db.$client, { apply: true });
  expect(applied).toMatchObject({ writtenRows: 2, writtenAttempts: 1 });
  expect(env.row("q1").activeSec).toBe(8);
  expect(env.row("q2").activeSec).toBe(4);
  expect(env.db.select().from(attempts).get()?.activeSec).toBe(12);
  expect(env.db.select().from(events).all()).toEqual(originalEvents);
  expect(backfillSubmissionTime(env.db.$client, { apply: true })).toMatchObject(
    { writtenRows: 0, writtenAttempts: 0 },
  );
});

it("无合法提交时间的行留空；可信整卷顺序可排除同毫秒迟到事件", () => {
  const env = oldCompleted();
  env.db
    .update(responses)
    .set({ submittedAt: "invalid" })
    .where(eq(responses.id, env.row("q1").id))
    .run();
  env.event("question_focus", 17, "q2");
  env.event("question_blur", 100, "q2");
  env.db
    .update(events)
    .set({ serverTs: at(22) })
    .where(eq(events.questionId, "q2"))
    .run();
  const report = backfillSubmissionTime(env.db.$client, { apply: true });
  expect(env.row("q1").activeSec).toBeNull();
  expect(env.row("q2").activeSec).toBe(4);
  expect(report.skipped.missingBoundary).toBe(1);
  expect(env.db.select().from(attempts).get()?.activeSec).toBeNull();
});

it("已有非空时间与进行中卷合计保留；未提交行不补", () => {
  const env = timingFixture("lesson");
  env.event("question_focus", 1, "q1");
  env.event("question_blur", 1, "q1");
  env.submit("q1", 2);
  env.db
    .update(responses)
    .set({ activeSec: null })
    .where(eq(responses.id, env.row("q1").id))
    .run();
  env.event("question_focus", 3, "q2");
  env.event("question_blur", 8, "q2");
  expect(backfillSubmissionTime(env.db.$client, { apply: true })).toMatchObject(
    { writtenRows: 1, writtenAttempts: 0 },
  );
  expect(env.row("q1").activeSec).toBe(0);
  expect(env.row("q2").activeSec).toBeNull();
  expect(env.db.select().from(attempts).get()?.activeSec).toBeNull();
  env.db
    .update(responses)
    .set({ activeSec: 99 })
    .where(eq(responses.id, env.row("q1").id))
    .run();
  backfillSubmissionTime(env.db.$client, { apply: true });
  expect(env.row("q1").activeSec).toBe(99);
});

it("整卷收尾中没有题级标记的行可用受理边界；无聚焦仍为NULL；不改已有卷总计", () => {
  const env = timingFixture();
  env.event("question_focus", 1, "q1");
  env.event("question_blur", 5, "q1");
  submitAttempt(env.db, env.studentId, env.attemptId, at(10));
  env.db
    .update(responses)
    .set({ activeSec: null })
    .where(eq(responses.attemptId, env.attemptId))
    .run();
  env.db
    .update(attempts)
    .set({ activeSec: 88 })
    .where(eq(attempts.id, env.attemptId))
    .run();
  const report = backfillSubmissionTime(env.db.$client, { apply: true });
  expect(env.row("q1").activeSec).toBe(4);
  expect(env.row("q2").activeSec).toBeNull();
  expect(report.skipped.noFocusEvidence).toBe(1);
  expect(env.db.select().from(attempts).get()?.activeSec).toBe(88);
});

it("无可信顺序证据的同毫秒浏览器事件有歧义，保留NULL；作废卷不处理", () => {
  const env = oldCompleted();
  env.db
    .update(events)
    .set({ serverTs: at(10) })
    .where(eq(events.questionId, "q1"))
    .run();
  const report = backfillSubmissionTime(env.db.$client, { apply: true });
  expect(report.skipped.ambiguousBoundary).toBe(1);
  expect(env.row("q1").activeSec).toBeNull();
  expect(env.db.select().from(attempts).get()?.activeSec).toBeNull();
  env.db
    .update(attempts)
    .set({ abandonedAt: at(100) })
    .where(eq(attempts.id, env.attemptId))
    .run();
  expect(
    backfillSubmissionTime(env.db.$client, { apply: true }).candidateRows,
  ).toBe(0);
});

it("公共事件可伪造无viewId的question_submit，不能借此闭合焦点或伪造confirmed边界", () => {
  const env = timingFixture();
  env.event("question_focus", 1, "q1");
  env.event("answer_change", 3, "q1");
  env.submit("q1", 10);
  env.event("question_focus", 11, "q2");
  env.event("question_blur", 15, "q2");
  env.submit("q2", 16);
  env.db
    .update(responses)
    .set({ activeSec: null })
    .where(eq(responses.attemptId, env.attemptId))
    .run();
  env.db
    .update(attempts)
    .set({ activeSec: null })
    .where(eq(attempts.id, env.attemptId))
    .run();
  const batch = attemptEventBatchRequestSchema.parse({
    events: [
      {
        type: "question_submit",
        questionId: "q1",
        clientTs: Date.parse(at(10)),
        serverTs: at(4),
        confirmed: true,
      },
      { type: "submit", clientTs: Date.parse(at(10)), confirmed: true },
    ],
  });
  expect(batch.events[0]).not.toHaveProperty("serverTs");
  expect(batch.events[1]).not.toHaveProperty("confirmed");
  appendAttemptEvents(env.db, env.studentId, env.attemptId, batch.events);
  const report = backfillSubmissionTime(env.db.$client, { apply: true });
  expect(report.skipped.openFocusInterval).toBe(1);
  expect(env.row("q1").activeSec).toBeNull();
  expect(env.row("q2").activeSec).toBe(4);
  expect(env.db.select().from(attempts).get()?.activeSec).toBeNull();
});

it("旧question_submit标记的时钟漂移不参与计时边界", () => {
  const env = oldCompleted();
  for (const marker of env.db
    .select()
    .from(events)
    .all()
    .filter((e) => e.type === "question_submit")) {
    const clientTs = marker.clientTs + 1;
    env.db
      .update(events)
      .set({
        clientTs,
        serverTs: new Date(Date.parse(marker.serverTs) + 2).toISOString(),
        payloadJson: JSON.stringify({
          type: "question_submit",
          questionId: marker.questionId,
          clientTs,
        }),
      })
      .where(eq(events.id, marker.id))
      .run();
  }
  expect(backfillSubmissionTime(env.db.$client, { apply: true })).toMatchObject(
    { writtenRows: 2, writtenAttempts: 1 },
  );
  expect(env.row("q1").activeSec).toBe(8);
  expect(env.row("q2").activeSec).toBe(4);
});
