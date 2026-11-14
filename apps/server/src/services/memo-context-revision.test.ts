import { randomUUID } from "node:crypto";
import {
  learningContextSchema,
  MEMO_OUTBOX_ACCOUNT_HEADER,
  memoSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession } from "../auth/session.ts";
import { responses } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  frozenDraftAttempt,
  snapshotJsonOf,
} from "../test/evidence-fixtures.ts";
import { makeStudent } from "../test/note-fixtures.ts";
import { contextFromMemoAnchor } from "./memo-context.ts";

function fixture(snapshot = snapshotJsonOf({ id: "q1" })) {
  const db = createTestDb();
  const studentId = makeStudent(db);
  const { attemptId, rowIds } = frozenDraftAttempt(db, studentId, [
    { questionId: "q1", snapshotJson: snapshot },
  ]);
  const original = rowIds[0];
  if (original === undefined) throw new Error("缺少真实冻结行");
  const opaque = "opaque-row-ref";
  db.update(responses)
    .set({ id: opaque })
    .where(eq(responses.id, original))
    .run();
  const anchor = {
    kind: "question" as const,
    attemptId,
    questionId: "q1",
    label: "本人冻结题",
  };
  const app = createApp({
    db,
    dataDir: createTestDir(),
    publicUrl: "http://localhost",
    isProduction: false,
    logger: pino({ enabled: false }),
  });
  const cookie = `tutor_student_session=${createStudentSession(db, studentId).token}`;
  return { db, studentId, attemptId, opaque, anchor, app, cookie };
}
it("真实responses TEXT行的opaque引用经canonical投影原样返回", () => {
  const f = fixture();
  const projected = contextFromMemoAnchor(f.db, f.studentId, f.anchor);
  expect(projected?.session?.questionRevisionId).toBe(f.opaque);
  expect(learningContextSchema.parse(projected)).toEqual(projected);
  expect(projected?.session?.attemptId).toBe(f.attemptId);
  expect(projected?.content.questionId).toBe("q1");
});
it("本人opaque canonical来源经真实随笔路由创建/列表往返，出口仍防泄露", async () => {
  const f = fixture();
  const projected = contextFromMemoAnchor(f.db, f.studentId, f.anchor);
  const made = await f.app.request("/api/student/memos", {
    method: "POST",
    headers: {
      cookie: f.cookie,
      [MEMO_OUTBOX_ACCOUNT_HEADER]: f.studentId,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      clientId: randomUUID(),
      text: "隔离夹具",
      context: projected,
    }),
  });
  expect(made.status).toBe(201);
  const body = (await made.json()) as { data: unknown };
  assertNoLeak(body);
  const memo = memoSchema.parse(body.data);
  expect(memo.context?.session?.questionRevisionId).toBe(f.opaque);
  const listed = await f.app.request(
    `/api/student/memos?attemptId=${f.attemptId}`,
    { headers: { cookie: f.cookie } },
  );
  expect(listed.status).toBe(200);
  const list: unknown = await listed.json();
  assertNoLeak(list);
  expect(JSON.stringify(list)).toContain(f.opaque);
});
it("行引用兼容不允许他人作答或缺失题引用投影", () => {
  const f = fixture();
  expect(() =>
    contextFromMemoAnchor(f.db, makeStudent(f.db), f.anchor),
  ).toThrow("随笔来源不存在");
  expect(() =>
    contextFromMemoAnchor(f.db, f.studentId, {
      ...f.anchor,
      questionId: "missing-question",
    }),
  ).toThrow("随笔来源不存在");
});
