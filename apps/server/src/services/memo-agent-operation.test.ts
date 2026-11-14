import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { attempts, units } from "../db/schema";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils";
import { frozenDraftAttempt, snapshotJsonOf } from "../test/evidence-fixtures";
import { makeStudent } from "../test/note-fixtures";
import { createAgentMemo } from "./memo-service";

it.each([false, true])(
  "事务前竞争写入：相同=%s 的操作必须执行同一摘要检查",
  (same) => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const operationId = randomUUID();
    let winnerId: string | undefined;
    const spy = vi.spyOn(db, "transaction");
    spy.mockImplementationOnce(((
      ...args: Parameters<typeof db.transaction>
    ) => {
      spy.mockRestore();
      winnerId = createAgentMemo(db, studentId, {
        operationId,
        text: "winner",
      }).id;
      return db.transaction(...args);
    }) as typeof db.transaction);
    if (same)
      expect(
        createAgentMemo(db, studentId, { operationId, text: "winner" }).id,
      ).toBe(winnerId);
    else
      expect(() =>
        createAgentMemo(db, studentId, { operationId, text: "loser" }),
      ).toThrow("幂等键已用于另一条随笔");
  },
);
it("摘要保留原始时间语义：等价时区重试成功，变化/省略/未来收口不同请求冲突", () => {
  const db = createTestDb();
  const studentId = makeStudent(db);
  const operationId = randomUUID();
  const first = createAgentMemo(db, studentId, {
    operationId,
    text: "时间",
    recordedAt: "2026-01-01T00:00:00Z",
  });
  expect(
    createAgentMemo(db, studentId, {
      operationId,
      text: "时间",
      recordedAt: "2026-01-01T08:00:00+08:00",
    }).id,
  ).toBe(first.id);
  for (const recordedAt of [undefined, "2026-02-01T00:00:00Z"])
    expect(() =>
      createAgentMemo(db, studentId, { operationId, text: "时间", recordedAt }),
    ).toThrow("幂等键已用于另一条随笔");
  const futureId = randomUUID();
  const now = new Date("2026-01-01T00:00:00Z");
  createAgentMemo(
    db,
    studentId,
    { operationId: futureId, text: "未来", recordedAt: "2099-01-01T00:00:00Z" },
    now,
  );
  expect(() =>
    createAgentMemo(
      db,
      studentId,
      {
        operationId: futureId,
        text: "未来",
        recordedAt: "2099-02-01T00:00:00Z",
      },
      now,
    ),
  ).toThrow("幂等键已用于另一条随笔");
});
it("显式来源说明与省略自动说明分别进入摘要，不因自动标题变化影响重试", () => {
  const db = createTestDb();
  const studentId = makeStudent(db);
  const { attemptId } = frozenDraftAttempt(db, studentId, [
    { questionId: "q1", snapshotJson: snapshotJsonOf({ id: "q1" }) },
  ]);
  const anchor = {
    kind: "question" as const,
    attemptId,
    questionId: "q1",
    label: "原说明",
  };
  const operationId = randomUUID();
  createAgentMemo(db, studentId, { operationId, text: "来源", anchor });
  expect(() =>
    createAgentMemo(db, studentId, {
      operationId,
      text: "来源",
      anchor: { ...anchor, label: "新说明" },
    }),
  ).toThrow("幂等键已用于另一条随笔");
  const unitId = "auto-label-unit";
  db.insert(units)
    .values({
      id: unitId,
      teacherId: TEST_TEACHER_ID,
      title: "旧自动标题",
      order: 0,
      updatedAt: "2026-01-01T00:00:00Z",
    })
    .run();
  db.update(attempts).set({ unitId }).where(eq(attempts.id, attemptId)).run();
  const autoId = randomUUID();
  const auto = { kind: "question" as const, attemptId, questionId: "q1" };
  const first = createAgentMemo(db, studentId, {
    operationId: autoId,
    text: "自动",
    anchor: auto,
  });
  db.update(units)
    .set({ title: "新自动标题" })
    .where(eq(units.id, unitId))
    .run();
  expect(
    createAgentMemo(db, studentId, {
      operationId: autoId,
      text: "自动",
      anchor: auto,
    }).id,
  ).toBe(first.id);
  expect(() =>
    createAgentMemo(db, studentId, {
      operationId: autoId,
      text: "自动",
      anchor: {
        ...auto,
        label: first.anchor.kind === "none" ? "来源" : first.anchor.label,
      },
    }),
  ).toThrow("幂等键已用于另一条随笔");
});
