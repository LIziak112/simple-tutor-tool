import { afterEach, expect, it, vi } from "vitest";
import {
  attemptEventReceipts,
  attemptTimeSpans,
  responseTimeLedger,
} from "../db/attempt-time-schema";
import {
  closeTimingFixtures,
  timingFixture,
} from "../test/submission-time-fixture";
import { attemptTimeEstimateOf } from "./attempt-time-estimate";
import { attemptTimeOf, timeProjectionsOf } from "./attempt-time-projection";
import { appendAttemptEvents, recordHintOpenEvent } from "./event-service";

afterEach(closeTimingFixtures);
it.each(["wrong", "lesson"] as const)(
  "%s 真实提交封存，迟到回看不改账，未知不伪零",
  (source) => {
    const e = timingFixture(source);
    const first = e.db.select().from(attemptEventReceipts).all();
    expect(first).toEqual([]);
    const row = e.row("q1");
    const student = e.db.$client
      .prepare("select student_id id from attempts")
      .get() as { id: string };
    appendAttemptEvents(
      e.db,
      student.id,
      row.attemptId,
      [
        { type: "question_focus", questionId: "q1", clientTs: 1000 },
        { type: "question_blur", questionId: "q1", clientTs: 11000 },
      ],
      "v1",
    );
    e.submit("q1", 12);
    const before = e.db.select().from(responseTimeLedger).all();
    expect(before[0]).toMatchObject({
      activeSec: 10,
      observedSec: 0,
      state: "available",
    });
    appendAttemptEvents(
      e.db,
      student.id,
      row.attemptId,
      [
        { type: "question_focus", questionId: "q1", clientTs: 12000 },
        { type: "question_blur", questionId: "q1", clientTs: 99000 },
      ],
      "v1",
    );
    e.submit("q2", 100);
    expect(e.db.select().from(responseTimeLedger).all()[0]).toEqual(before[0]);
    expect(attemptTimeOf(e.db, row.attemptId)).toMatchObject({
      activeSec: null,
      knownActiveSec: 10,
      unknownCount: 1,
    });
    expect(
      timeProjectionsOf(e.db, [row.attemptId]).responseTime.get(e.row("q2").id),
    ).toMatchObject({
      value: { state: "unknown", reason: "no_client_evidence" },
    });
    expect(() =>
      e.db.update(responseTimeLedger).set({ activeSec: 99 }).run(),
    ).toThrow(/immutable/);
    expect(() => e.db.delete(attemptTimeSpans).run()).toThrow(/immutable/);
  },
);
it("重复delivery不新增receipt，异常事务零封存", () => {
  const e = timingFixture();
  const row = e.row("q1");
  const student = e.db.$client
    .prepare("select student_id id from attempts")
    .get() as { id: string };
  const batch = [
    { type: "question_focus" as const, questionId: "q1", clientTs: 1000 },
  ];
  const delivery = { ownerId: student.id, eventIds: ["test-event-1"] };
  appendAttemptEvents(e.db, student.id, row.attemptId, batch, "v", delivery);
  appendAttemptEvents(e.db, student.id, row.attemptId, batch, "v", delivery);
  expect(e.db.select().from(attemptEventReceipts).all()).toHaveLength(1);
  expect(() =>
    e.db.transaction(() => {
      e.submit("q1", 10);
      throw Error("rollback");
    }),
  ).toThrow("rollback");
  expect(e.db.select().from(responseTimeLedger).all()).toHaveLength(0);
  expect(e.db.select().from(attemptEventReceipts).all()).toHaveLength(1);
});
it("已知多端冲突先占排除，后批只分配剩余区间", () => {
  const e = timingFixture();
  const q = e.row("q1");
  const student = e.db.$client
    .prepare("select student_id id from attempts")
    .get() as { id: string };
  appendAttemptEvents(
    e.db,
    student.id,
    q.attemptId,
    [
      { type: "question_focus", questionId: "q1", clientTs: 1000 },
      { type: "question_blur", questionId: "q1", clientTs: 11000 },
    ],
    "a",
  );
  appendAttemptEvents(
    e.db,
    student.id,
    q.attemptId,
    [
      { type: "question_focus", questionId: "q2", clientTs: 6000 },
      { type: "answer_change", questionId: "q2", clientTs: 7000 },
      { type: "question_blur", questionId: "q2", clientTs: 16000 },
    ],
    "b",
  );
  e.submit("q1", 17);
  e.submit("q2", 18);
  const rows = e.db.select().from(responseTimeLedger).all();
  expect(rows.map((r) => r.activeSec)).toEqual([5, 5]);
  expect(attemptTimeOf(e.db, q.attemptId)).toMatchObject({
    activeSec: 10,
    unknownCount: 0,
  });
  expect(
    e.db
      .select()
      .from(attemptTimeSpans)
      .all()
      .map((r) => [r.kind, r.start, r.end]),
  ).toEqual([
    ["active", 1000, 6000],
    ["unattributed", 6000, 11000],
    ["active", 11000, 16000],
  ]);
});
it("另一端迟到不能收回旧题，首封存优先", () => {
  const e = timingFixture();
  const q = e.row("q1");
  const student = e.db.$client
    .prepare("select student_id id from attempts")
    .get() as { id: string };
  appendAttemptEvents(
    e.db,
    student.id,
    q.attemptId,
    [
      { type: "question_focus", questionId: "q1", clientTs: 1000 },
      { type: "question_blur", questionId: "q1", clientTs: 11000 },
    ],
    "a",
  );
  e.submit("q1", 12);
  appendAttemptEvents(
    e.db,
    student.id,
    q.attemptId,
    [
      { type: "question_focus", questionId: "q2", clientTs: 6000 },
      { type: "answer_change", questionId: "q2", clientTs: 7000 },
      { type: "question_blur", questionId: "q2", clientTs: 16000 },
    ],
    "b",
  );
  e.submit("q2", 18);
  expect(
    e.db
      .select()
      .from(responseTimeLedger)
      .all()
      .map((r) => r.activeSec),
  ).toEqual([10, 5]);
  expect(attemptTimeOf(e.db, q.attemptId)).toMatchObject({ activeSec: 15 });
});

it("真实服务端提示追认先前episode，之后重进同题的提交不吞提示动作", () => {
  const e = timingFixture();
  appendAttemptEvents(
    e.db,
    e.studentId,
    e.attemptId,
    [{ type: "question_focus", questionId: "q1", clientTs: 1000 }],
    "a",
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(999999);
  try {
    recordHintOpenEvent(e.db, e.studentId, e.attemptId, "q1", 0);
  } finally {
    clock.mockRestore();
  }
  appendAttemptEvents(
    e.db,
    e.studentId,
    e.attemptId,
    [
      { type: "question_blur", questionId: "q1", clientTs: 5000 },
      { type: "question_focus", questionId: "q1", clientTs: 6000 },
      { type: "question_blur", questionId: "q1", clientTs: 10000 },
    ],
    "a",
  );
  expect(attemptTimeEstimateOf(e.db, e.attemptId)?.activeSecTotal).toBe(4);
  e.submit("q1", 12);
  expect(e.db.select().from(responseTimeLedger).get()).toMatchObject({
    activeSec: 8,
    observedSec: 0,
    actions: 2,
  });
});
it("大域批量投影去重分块，所有查询与单卷结果一致", () => {
  const e = timingFixture();
  e.submit("q1", 10);
  e.submit("q2", 11);
  const ids = [
    ...Array.from({ length: 33000 }, (_, i) => `missing-${i}`),
    e.attemptId,
    e.attemptId,
  ];
  const actual = timeProjectionsOf(e.db, ids),
    expected = timeProjectionsOf(e.db, [e.attemptId]);
  expect(actual.aggregate(e.attemptId)).toEqual(
    expected.aggregate(e.attemptId),
  );
  expect([...actual.responseTime]).toEqual([...expected.responseTime]);
  expect(actual.members).toEqual(expected.members);
});
