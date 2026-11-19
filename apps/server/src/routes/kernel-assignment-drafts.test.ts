import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import {
  ATTEMPT_SNAPSHOT_PROOF_HEADER,
  ATTEMPT_TIME_UP_GRACE_SEC,
  type AttemptStartData,
  attemptDraftOkSchema,
  attemptStartOkSchema,
  studentRecordsOkSchema,
} from "@tutor/contract";
import pino from "pino";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { withKernelRuntime } from "../services/kernel-assignment-runtime.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  assignKernelFixture,
  setupAssignment,
  verifyInactiveOwnerCookies,
} from "../test/m04-p1/product-fixture.ts";

import { putNoteReceipt } from "../test/note-fixtures.ts";

const db = createTestDb();
const dataDir = createTestDir();
const app = createApp({
  db,
  dataDir,
  kernelAssignmentCreationEnabled: true,
  isProduction: false,
  logger: pino({ enabled: false }),
  publicUrl: "http://localhost:8787",
});

let world: Awaited<ReturnType<typeof setupAssignment>>;
let assignmentId: string;
let startedAt: number;

beforeAll(async () => {
  world = await setupAssignment(app);
  assignmentId = await assignKernelFixture(app, world);
  startedAt = Date.now();
});

afterEach(() => vi.useRealTimers());
afterAll(() => {
  db.$client.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function at(elapsed: number) {
  vi.setSystemTime(startedAt + elapsed);
  return new Date().toISOString();
}

async function open(cookie: string, timeLimitMinutes?: number) {
  const response = await app.request(
    `/api/student/assignments/${assignmentId}/attempt`,
    {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        [ATTEMPT_SNAPSHOT_PROOF_HEADER]: "1",
      },
      body: JSON.stringify({
        workflowVersion: 1,
        feedbackMode: "after_attempt",
        timeLimitMinutes,
      }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return attemptStartOkSchema.parse(await response.json()).data;
}

function requestDetail(id: string, cookie: string, etag?: string) {
  return app.request(`/api/student/attempts/${id}`, {
    headers: {
      cookie,
      ...(etag === undefined ? {} : { "if-none-match": etag }),
    },
  });
}

async function details(id: string, cookie: string, etag?: string) {
  const response = await requestDetail(id, cookie, etag);
  expect(response.status, await response.clone().text()).toBe(200);
  const body: unknown = await response.json();
  assertNoLeak(body, {
    forbid: ["acceptedChoice", "acceptedChoices", "scoringKey", "keyRef"],
  });
  expect(JSON.stringify(body)).not.toContain("合成详解");
  return attemptDraftOkSchema.parse(body).data;
}

async function records(cookie: string) {
  const response = await app.request("/api/student/records", {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  return studentRecordsOkSchema.parse(await response.json()).data;
}

function draftRequests(
  { id, frozenAt }: Pick<AttemptStartData, "id" | "frozenAt">,
  cookie: string,
  question: { id: string; questionRevisionId: string },
) {
  return {
    operation: (baseRevision: number, index: number) => ({
      answer: { kind: "choice", index },
      baseRevision,
      mutationId: randomUUID(),
      questionRevisionId: question.questionRevisionId,
      expectedFrozenAt: frozenAt,
    }),
    async put(body: object, actor = cookie, questionId = question.id) {
      const response = await app.request(
        `/api/student/attempts/${id}/answers/${questionId}`,
        {
          method: "PUT",
          headers: { cookie: actor, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data: unknown = await response.json();
      assertNoLeak(data);
      return { status: response.status, data };
    },
  };
}

function saved(questionId: string, revision: number) {
  return {
    status: 200,
    data: { ok: true, data: { questionId, revision, changeCount: revision } },
  };
}

function conflict(revision: number, index: number) {
  return {
    status: 409,
    data: {
      ok: false,
      error: "ANSWER_REVISION_CONFLICT",
      _current: { revision, draft: { kind: "choice", index } },
    },
  };
}

function verifyHostAnswersUnwritten(id: string) {
  expect(
    db.$client
      .prepare(
        "SELECT answer_json, answer_revision, answer_mutation_id, change_count, auto_correct, final_correct FROM responses WHERE attempt_id=? ORDER BY question_id",
      )
      .all(id),
  ).toEqual(
    Array.from({ length: 2 }, () => ({
      answer_json: null,
      answer_revision: 0,
      answer_mutation_id: null,
      change_count: 0,
      auto_correct: null,
      final_correct: null,
    })),
  );
  expect(
    db.$client
      .prepare(
        "SELECT status, score_auto, score_final FROM attempts WHERE id=?",
      )
      .get(id),
  ).toEqual({
    status: "draft",
    score_auto: null,
    score_final: null,
  });
}

it("正常 PUT 和 GET 使用内核当前稿，旧盲写与冻结证明按原契约处理", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
  const { ownerCookie, otherCookie, studentId } = world;
  const attempt = await open(ownerCookie);
  expect(attempt.phase).toBe("opened");
  const before = await details(attempt.id, ownerCookie);
  const [first, second] = before.units.flatMap(({ questions }) => questions);
  if (!first || !second) throw new Error("没有 P0 两道冻结题");
  expect(before.drafts).toEqual({});
  expect(before.draftRevisions).toEqual({ [first.id]: 0, [second.id]: 0 });
  expect((await records(ownerCookie)).total).toBe(0);
  const emptyTag = (await requestDetail(attempt.id, ownerCookie)).headers.get(
    "etag",
  );
  expect(emptyTag).not.toBeNull();
  const unchanged = await requestDetail(
    attempt.id,
    ownerCookie,
    emptyTag ?? "",
  );
  expect(unchanged.status).toBe(304);
  expect(unchanged.headers.get("etag")).toBe(emptyTag);
  expect(await unchanged.text()).toBe("");

  const firstDraft = draftRequests(attempt, ownerCookie, first);
  const a = firstDraft.operation(0, 0);
  const firstChangedAt = at(1000);
  expect(await firstDraft.put(a)).toEqual(saved(first.id, 1));
  let read = await details(attempt.id, ownerCookie, emptyTag ?? "");
  const aTag = (await requestDetail(attempt.id, ownerCookie)).headers.get(
    "etag",
  );
  expect(aTag).not.toBe(emptyTag);
  expect(
    (await requestDetail(attempt.id, ownerCookie, aTag ?? "")).status,
  ).toBe(304);
  expect(read.attempt).toMatchObject({
    phase: "active",
    activatedAt: firstChangedAt,
  });
  expect(read.drafts).toEqual({ [first.id]: { kind: "choice", index: 0 } });
  expect(read.draftRevisions).toEqual({ [first.id]: 1, [second.id]: 0 });
  expect(await records(ownerCookie)).toMatchObject({
    total: 1,
    records: [{ attemptId: attempt.id, lastActivityAt: firstChangedAt }],
  });

  at(2000);
  expect(await firstDraft.put({ ...a, baseRevision: 1 })).toEqual(
    saved(first.id, 1),
  );
  expect((await records(ownerCookie)).records[0]?.lastActivityAt).toBe(
    firstChangedAt,
  );
  const b = firstDraft.operation(1, 1);
  const middleChangedAt = at(3000);
  expect(await firstDraft.put(b)).toEqual(saved(first.id, 2));
  const afterB = await requestDetail(attempt.id, ownerCookie, aTag ?? "");
  expect(afterB.status).toBe(200);
  expect(afterB.headers.get("etag")).not.toBe(aTag);
  expect(
    attemptDraftOkSchema.parse(await afterB.json()).data.draftRevisions?.[
      first.id
    ],
  ).toBe(2);
  at(4000);
  expect(await firstDraft.put(a)).toMatchObject(conflict(2, 1));
  expect((await records(ownerCookie)).records[0]?.lastActivityAt).toBe(
    middleChangedAt,
  );
  at(5000);
  expect(await firstDraft.put(firstDraft.operation(2, 0))).toEqual(
    saved(first.id, 3),
  );
  at(6000);
  expect(await firstDraft.put(a)).toEqual(saved(first.id, 3));
  withKernelRuntime(db, dataDir, false, (runtime) => {
    const principal = { role: "student", id: studentId } as const;
    const activity = runtime.read(principal, attempt.id);
    if (!("stepAttemptId" in activity)) throw new Error("内核活动未绑定");
    expect(
      runtime.saveChoiceDraft(principal, attempt.id, {
        protocolVersion: 1,
        stepAttemptId: activity.stepAttemptId,
        slotId: "answers",
        questionId: first.id,
        questionVersion: 1,
        operationId: a.mutationId,
        baseRevision: a.baseRevision,
        choice: "0",
      }),
    ).toMatchObject({ choice: "0", revision: 1, changeCount: 1 });
  });

  const secondDraft = draftRequests(attempt, ownerCookie, second);
  const blind = { answer: { kind: "choice", index: 1 } };
  const lastChangedAt = at(7000);
  expect(await secondDraft.put(blind)).toEqual(saved(second.id, 1));
  at(8000);
  expect(await secondDraft.put(blind)).toEqual(saved(second.id, 2));
  const takeover = secondDraft.operation(2, 1);
  expect(await secondDraft.put(takeover)).toEqual(saved(second.id, 2));
  expect(await secondDraft.put(blind)).toMatchObject(conflict(2, 1));
  expect((await records(ownerCookie)).records[0]?.lastActivityAt).toBe(
    lastChangedAt,
  );
  at(8100);
  expect(await secondDraft.put(secondDraft.operation(2, 0))).toEqual(
    saved(second.id, 3),
  );
  at(8200);
  expect(
    await secondDraft.put({
      ...takeover,
      baseRevision: 3,
      answer: { kind: "choice", index: 2 },
    }),
  ).toEqual(saved(second.id, 4));
  expect(await secondDraft.put(a)).toMatchObject({
    status: 409,
    data: { error: "QUESTION_REVISION_STALE" },
  });
  expect(
    await firstDraft.put({
      ...a,
      expectedFrozenAt: new Date(startedAt - 1000).toISOString(),
    }),
  ).toMatchObject({
    status: 409,
    data: { error: "ATTEMPT_SNAPSHOT_CHANGED" },
  });
  const foreign = await firstDraft.put(a, otherCookie);
  expect(foreign).toMatchObject({ status: 403, data: { error: "FORBIDDEN" } });
  expect(foreign.data).not.toHaveProperty("_current");
  const foreignGet = await requestDetail(attempt.id, otherCookie, aTag ?? "");
  expect(foreignGet.status).toBe(403);
  expect(await foreignGet.json()).not.toHaveProperty("data");

  // 实际触笔走宿主草稿正文入口，旧稿重放不得覆盖更晚的活动时刻。
  const laterHostActivity = at(9000);
  await putNoteReceipt(app, ownerCookie, attempt.id, first.id);
  expect(await firstDraft.put(a)).toEqual(saved(first.id, 3));
  expect((await records(ownerCookie)).records[0]?.lastActivityAt).toBe(
    laterHostActivity,
  );

  const beforeRename = (
    await requestDetail(attempt.id, ownerCookie)
  ).headers.get("etag");
  const rename = await app.request(`/api/teacher/assignments/${assignmentId}`, {
    method: "PATCH",
    headers: { cookie: world.teacher, "content-type": "application/json" },
    body: JSON.stringify({ title: "已修改的作业标题" }),
  });
  expect(rename.status).toBe(200);
  const afterRename = await requestDetail(
    attempt.id,
    ownerCookie,
    beforeRename ?? "",
  );
  expect(afterRename.status).toBe(200);
  const activeTag = afterRename.headers.get("etag");
  expect(activeTag).not.toBe(beforeRename);
  expect(attemptDraftOkSchema.parse(await afterRename.json()).data.title).toBe(
    "已修改的作业标题",
  );

  const removed = await app.request(
    `/api/teacher/assignments/${assignmentId}`,
    {
      method: "PATCH",
      headers: { cookie: world.teacher, "content-type": "application/json" },
      body: JSON.stringify({
        removeStudentIds: [world.studentId],
        confirmStarted: true,
      }),
    },
  );
  expect(removed.status, await removed.clone().text()).toBe(200);
  expect(
    (
      await app.request(`/api/student/assignments/${assignmentId}/attempt`, {
        method: "POST",
        headers: { cookie: ownerCookie },
      })
    ).status,
  ).toBe(403);
  expect(await firstDraft.put(a)).toEqual(saved(first.id, 3));
  read = await details(attempt.id, ownerCookie);
  expect(read.attempt.activatedAt).toBe(firstChangedAt);
  expect(
    read.units
      .flatMap(({ questions }) => questions)
      .map(({ questionRevisionId }) => questionRevisionId),
  ).toEqual([first.questionRevisionId, second.questionRevisionId]);
  expect(read.drafts).toEqual({
    [first.id]: { kind: "choice", index: 0 },
    [second.id]: { kind: "choice", index: 2 },
  });
  expect(read.draftRevisions).toEqual({ [first.id]: 3, [second.id]: 4 });
  await verifyInactiveOwnerCookies(app, world, async (cookie) => {
    const inactiveWrite = await firstDraft.put(a, cookie);
    expect(inactiveWrite.status).toBe(401);
    expect(inactiveWrite.data).not.toHaveProperty("_current");
    const inactiveRead = await requestDetail(
      attempt.id,
      cookie,
      activeTag ?? "",
    );
    expect(inactiveRead.status).toBe(401);
    expect(await inactiveRead.json()).not.toHaveProperty("data");
  });
  verifyHostAnswersUnwritten(attempt.id);
});

it("超宽限只能重放最近操作，内核完成后普通保存优先拒绝", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(10_000);
  const { otherCookie, otherStudentId } = world;
  const attempt = await open(otherCookie, 90);
  const timedDetail = await requestDetail(attempt.id, otherCookie, "*");
  expect(timedDetail.status).toBe(200);
  expect(timedDetail.headers.get("etag")).toBeNull();
  const { units } = await details(attempt.id, otherCookie);
  const [first, second] = units.flatMap(({ questions }) => questions);
  if (!first || !second || !attempt.deadlineAt)
    throw new Error("限时卷缺少冻结题或截止");
  const { put, operation } = draftRequests(attempt, otherCookie, first);
  const a = operation(0, 0);
  const c = operation(2, 0);
  expect(await put(a)).toEqual(saved(first.id, 1));
  expect(await put(operation(1, 1))).toEqual(saved(first.id, 2));
  vi.setSystemTime(Date.parse(attempt.deadlineAt) + 1000);
  expect((await details(attempt.id, otherCookie)).timing?.phase).toBe("grace");
  expect(await put(c)).toEqual(saved(first.id, 3));
  expect(await put(a)).toEqual(saved(first.id, 3));
  vi.setSystemTime(
    Date.parse(attempt.deadlineAt) + (ATTEMPT_TIME_UP_GRACE_SEC + 1) * 1000,
  );
  expect((await details(attempt.id, otherCookie)).timing?.phase).toBe("locked");
  for (const request of [c, operation(3, 0), { answer: a.answer }]) {
    expect(await put(request)).toMatchObject({
      status: 409,
      data: { error: "ATTEMPT_TIME_UP" },
    });
  }
  expect(await put(a)).toEqual(saved(first.id, 3));
  expect(
    await put({ ...a, answer: { kind: "choice", index: 1 } }),
  ).toMatchObject(conflict(3, 0));

  // 直接准备真实内核完成事实。此单只验普通 PUT，产品 POST 交卷另验。
  withKernelRuntime(db, dataDir, false, (runtime) => {
    const principal = { role: "student", id: otherStudentId } as const;
    const activity = runtime.read(principal, attempt.id);
    if (!("stepAttemptId" in activity)) throw new Error("内核活动未绑定");
    runtime.confirmChoices(principal, attempt.id, {
      protocolVersion: 1,
      stepAttemptId: activity.stepAttemptId,
      slotId: "answers",
      operationId: "test-completion",
      questions: [first, second].map((question, index) => ({
        questionId: question.id,
        questionVersion: question.questionVersion ?? 1,
        revision: index === 0 ? 3 : 0,
        original: { state: "uncollected" },
      })),
    });
  });
  expect(await put(a)).toMatchObject({
    status: 409,
    data: { error: "ALREADY_SUBMITTED" },
  });
  verifyHostAnswersUnwritten(attempt.id);
});
