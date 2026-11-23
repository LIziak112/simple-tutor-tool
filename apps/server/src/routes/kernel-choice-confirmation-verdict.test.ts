import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  attemptResultOkSchema,
  attemptStartOkSchema,
  type MarkRequest,
  markResponseDataSchema,
  teacherAttemptDetailOkSchema,
  teacherInfoOkSchema,
} from "@tutor/contract";
import pino from "pino";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../app.ts";
import { createDbHandle } from "../db/client.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import { nodePeerBindings } from "../test/node-peer.ts";
import { putNoteReceipt } from "../test/note-fixtures.ts";
import { extractSessionToken } from "../test/note-world.ts";
import { submitAttemptRequest } from "../test/submit-revisions.ts";

const first = "m04-p0-q1";
const target = "m04-p0-q2";
const dueAt = "2099-01-01T00:00:00.000Z";
const answer = { kind: "choice", index: 0 };

let handle: ReturnType<typeof createDbHandle>;
let db: ReturnType<typeof createTestDb>;
let dataDir: string;
let app: ReturnType<typeof createApp>;
let world: Awaited<ReturnType<typeof setupAssignment>>;
let assignmentId: string;
let attemptId: string;
let responseId: string;
let studentPath: string;
let teacherPath: string;
let outsider: string;
let evidence: Parameters<typeof submitAttemptRequest>[3];

function call(path: string, cookie: string, method = "GET", body?: object) {
  return app.request(path, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function ok(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json();
}

async function denied(response: Response, status: number, error?: string) {
  const body = await ok(response, status);
  expect(body).toMatchObject({ ok: false, ...(error ? { error } : {}) });
  expect(body).not.toHaveProperty("data");
}

const detail = async () =>
  teacherAttemptDetailOkSchema.parse(
    await ok(await call(teacherPath, world.teacher)),
  ).data;
const student = async () =>
  attemptResultOkSchema.parse(
    await ok(await call(studentPath, world.ownerCookie)),
  ).data;
const mark = (request: MarkRequest, cookie = world.teacher) =>
  call(`/api/teacher/responses/${responseId}/mark`, cookie, "POST", request);
const markOk = async (request: MarkRequest) =>
  z
    .object({ data: markResponseDataSchema })
    .parse(await ok(await mark(request))).data;

function withKernel<T>(read: (kernel: DatabaseSync) => T) {
  using kernel = new DatabaseSync(join(dataDir, "learning-kernel.sqlite"), {
    readOnly: true,
  });
  return read(kernel);
}

const kernelEvents = () =>
  withKernel((kernel) =>
    kernel
      .prepare(
        "SELECT * FROM verdict_events WHERE activity_id=? ORDER BY revision",
      )
      .all(attemptId),
  );

function immutableFacts() {
  const byAttempt = (table: string) =>
    db.$client
      .prepare(`SELECT * FROM ${table} WHERE attempt_id=? ORDER BY rowid`)
      .all(attemptId);
  return {
    binding: byAttempt("kernel_attempt_bindings"),
    ticket: byAttempt("kernel_attempt_confirmations"),
    evidence: byAttempt("submission_evidence"),
    settlements: byAttempt("attempt_settlements"),
    deliveries: byAttempt("kernel_question_deliveries"),
    responses: db.$client
      .prepare(`
      SELECT id, answer_json, answer_revision, auto_correct, final_correct,
             teacher_mark, question_snapshot_json
      FROM responses WHERE attempt_id=? ORDER BY question_id
    `)
      .all(attemptId),
    kernel: withKernel((kernel) => ({
      confirmation: kernel
        .prepare(`
        SELECT s.*, w.selection, e.status, e.target_id FROM submissions s
        JOIN completions c ON c.submission_id=s.id
        JOIN work_versions w ON w.work_id=s.work_id AND w.version=s.work_version
        JOIN evaluation_tasks e ON e.submission_id=s.id WHERE c.activity_id=?
      `)
        .all(attemptId),
      automatic: kernel
        .prepare(`
        SELECT v.* FROM automatic_verdicts v JOIN completions c
        ON c.submission_id=v.submission_id WHERE c.activity_id=? ORDER BY v.question_id
      `)
        .all(attemptId),
    })),
  };
}

beforeEach(async () => {
  dataDir = createTestDir();
  const path = join(dataDir, "tutor.db");
  const seed = createTestDb();
  try {
    writeFileSync(path, seed.$client.serialize());
  } finally {
    seed.$client.close();
  }
  handle = createDbHandle(path);
  db = handle.db;
  app = createApp({
    db,
    dbHandle: handle,
    dataDir,
    kernelAssignmentCreationEnabled: true,
    isProduction: false,
    logger: pino({ enabled: false }),
    publicUrl: "http://localhost:8787",
  });
  world = await setupAssignment(app);
  assignmentId = await assignKernelFixture(app, world, {
    dueAt,
    answerRelease: "on_submit",
  });
  const opened = await postAssignment(app, assignmentId, world.ownerCookie);
  attemptId = attemptStartOkSchema.parse(await ok(opened)).data.id;
  teacherPath = `/api/teacher/attempts/${attemptId}`;
  studentPath = `/api/student/attempts/${attemptId}`;
  for (const [questionId, index] of [
    [first, 1],
    [target, 0],
  ] as const)
    await ok(
      await call(
        `${studentPath}/answers/${questionId}`,
        world.ownerCookie,
        "PUT",
        {
          answer: { kind: "choice", index },
        },
      ),
    );
  const original = await putNoteReceipt(
    app,
    world.ownerCookie,
    attemptId,
    target,
  );
  evidence = [
    { questionId: first, state: "none" },
    {
      questionId: target,
      state: "frozen",
      versionId: original.versionId,
      revision: original.revision,
    },
  ];
  await ok(
    await submitAttemptRequest(app, world.ownerCookie, attemptId, evidence),
  );
  const question = (await detail()).questions.find(
    ({ questionId }) => questionId === target,
  );
  if (!question?.responseId) throw new Error("已交卷的单选缺少批改标识");
  responseId = question.responseId;
  const registration = await app.request(
    "/api/public/teacher/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        loginName: "其他老师",
        password: "other-teacher-8",
      }),
    },
    nodePeerBindings("10.0.0.2"),
  );
  expect(registration.status).toBe(200);
  outsider = `tutor_session=${extractSessionToken(registration)}`;
});

afterEach(() => {
  handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it("原教师在正常入口改判并清除已正式确认的单选，原卷与自动分保持不变", async () => {
  const original = immutableFacts();
  expect(original.binding).toHaveLength(1);
  expect(original.ticket).toHaveLength(1);
  expect(original.evidence).toHaveLength(2);
  expect(original.deliveries).toHaveLength(0);
  expect(original.kernel.confirmation).toHaveLength(1);
  expect(original.kernel.automatic).toHaveLength(2);
  expect(await detail()).toMatchObject({
    attemptId,
    scoreAuto: 50,
    scoreFinal: 50,
  });

  const request = {
    mark: "correct",
    comment: "教师复核后更正",
    baseRevision: 0,
    mutationId: randomUUID(),
  } as const;
  await denied(await mark(request, outsider), 404, "RESPONSE_NOT_FOUND");
  await denied(await mark(request, world.ownerCookie), 401);
  const newTeacher = teacherInfoOkSchema.parse(
    await ok(await call("/api/teacher/me", outsider)),
  ).data.id;
  const setOwner = db.$client.prepare(
    "UPDATE students SET teacher_id=? WHERE id=?",
  );
  setOwner.run(newTeacher, world.studentId);
  try {
    await denied(await mark(request), 404, "RESPONSE_NOT_FOUND");
    await denied(await mark(request, outsider), 404, "RESPONSE_NOT_FOUND");
    expect(kernelEvents()).toEqual([]);
  } finally {
    setOwner.run(TEST_TEACHER_ID, world.studentId);
  }
  const changed = await markOk(request);
  expect(changed).toMatchObject({
    attemptId,
    responseId,
    questionId: target,
    scoreFinal: 100,
    teacherMark: "correct",
    teacherComment: request.comment,
    finalCorrect: true,
    revision: 1,
  });
  expect(changed.eventId).toBeDefined();
  expect(await markOk(request)).toEqual(changed);
  expect(await detail()).toMatchObject({
    attemptId,
    scoreAuto: 50,
    scoreFinal: 100,
  });
  expect((await student()).attempt).toMatchObject({
    id: attemptId,
    scoreAuto: 50,
  });
  expect((await student()).summary.scoreFinal).toBe(100);
  expect(
    (await student()).units
      .flatMap(({ questions }) => questions)
      .find(({ questionId }) => questionId === target),
  ).toMatchObject({
    answer,
    autoCorrect: false,
    finalCorrect: true,
    teacherMark: "correct",
    teacherComment: request.comment,
  });
  await ok(
    await call(
      `/api/teacher/assignments/${assignmentId}`,
      world.teacher,
      "PATCH",
      { answerRelease: "after_due" },
    ),
  );
  const hidden = await student();
  expect(hidden.answersReleased).toBe(false);
  expect(hidden.attempt.scoreAuto).toBeNull();
  expect(hidden.summary.scoreFinal).toBeNull();
  expect(
    hidden.units
      .flatMap(({ questions }) => questions)
      .find(({ questionId }) => questionId === target),
  ).toMatchObject({
    answer,
    answers: null,
    autoCorrect: null,
    finalCorrect: null,
    teacherMark: null,
    teacherComment: null,
    solutionMd: null,
  });
  expect(await detail()).toMatchObject({
    attemptId,
    scoreAuto: 50,
    scoreFinal: 100,
  });
  await ok(
    await call(
      `/api/teacher/assignments/${assignmentId}`,
      world.teacher,
      "PATCH",
      { answerRelease: "on_submit" },
    ),
  );

  const clear = {
    mark: null,
    comment: "回到自动分",
    baseRevision: 1,
    mutationId: randomUUID(),
  };
  await denied(
    await mark({ ...clear, baseRevision: 0 }),
    409,
    "VERDICT_CONFLICT",
  );
  const cleared = await markOk(clear);
  expect(cleared).toMatchObject({
    attemptId,
    responseId,
    questionId: target,
    scoreFinal: 50,
    teacherMark: null,
    teacherComment: clear.comment,
    finalCorrect: false,
    revision: 2,
  });
  expect(await markOk(clear)).toEqual(cleared);
  await denied(
    await mark({ ...clear, comment: null }),
    409,
    "OPERATION_CONFLICT",
  );
  expect(await detail()).toMatchObject({
    attemptId,
    scoreAuto: 50,
    scoreFinal: 50,
  });
  expect((await student()).attempt).toMatchObject({
    id: attemptId,
    scoreAuto: 50,
  });
  expect((await student()).summary.scoreFinal).toBe(50);
  await denied(
    await submitAttemptRequest(app, world.ownerCookie, attemptId, evidence),
    409,
    "ALREADY_SUBMITTED",
  );
  expect(kernelEvents()).toMatchObject([
    {
      id: changed.eventId,
      reviewer_id: TEST_TEACHER_ID,
      operation_id: request.mutationId,
      action: "override",
      revision: 1,
    },
    {
      id: cleared.eventId,
      reviewer_id: TEST_TEACHER_ID,
      operation_id: clear.mutationId,
      action: "withdraw",
      revision: 2,
      withdraw_id: changed.eventId,
    },
  ]);
  expect(immutableFacts()).toEqual(original);
});

it("普通读取只补齐内核已接受的批改，撤权时不启动只落到主库的请求", async () => {
  const request = {
    mark: "correct",
    comment: "等待主库补齐",
    baseRevision: 0,
    mutationId: randomUUID(),
  } as const;
  const receipt = () =>
    db.$client
      .prepare(
        "SELECT result_json FROM kernel_response_marks WHERE operation_id=?",
      )
      .get(request.mutationId);
  {
    using kernel = new DatabaseSync(join(dataDir, "learning-kernel.sqlite"));
    kernel.exec(`
      CREATE TRIGGER interrupt_before_kernel_acceptance BEFORE INSERT ON verdict_events
      BEGIN SELECT RAISE(ABORT, '中断内核接收'); END
    `);
    try {
      await denied(await mark(request), 500);
    } finally {
      kernel.exec("DROP TRIGGER interrupt_before_kernel_acceptance");
    }
  }
  expect(receipt()).toEqual({ result_json: null });
  expect(kernelEvents()).toEqual([]);
  handle.restart();
  expect(receipt()).toEqual({ result_json: null });

  const disable = db.$client.prepare(
    "UPDATE teachers SET disabled_at=? WHERE id=?",
  );
  disable.run(new Date().toISOString(), TEST_TEACHER_ID);
  try {
    await denied(await mark(request), 401);
    await denied(await call(teacherPath, world.teacher), 401);
    expect((await student()).attempt).toMatchObject({
      id: attemptId,
      scoreAuto: 50,
    });
    expect((await student()).summary.scoreFinal).toBe(50);
    expect(receipt()).toEqual({ result_json: null });
    expect(kernelEvents()).toEqual([]);
  } finally {
    disable.run(null, TEST_TEACHER_ID);
  }

  db.$client.exec(`
    CREATE TEMP TRIGGER interrupt_after_kernel_acceptance
    BEFORE UPDATE OF result_json ON kernel_response_marks
    BEGIN SELECT RAISE(ABORT, '中断主库回执'); END
  `);
  try {
    await denied(await mark(request), 500);
  } finally {
    db.$client.exec("DROP TRIGGER interrupt_after_kernel_acceptance");
  }
  expect(receipt()).toEqual({ result_json: null });
  expect(
    db.$client
      .prepare("SELECT teacher_comment FROM responses WHERE id=?")
      .get(responseId),
  ).toEqual({ teacher_comment: null });
  const accepted = kernelEvents();
  handle.restart();
  expect(receipt()).toEqual({ result_json: null });
  expect(accepted).toMatchObject([
    { operation_id: request.mutationId, revision: 1 },
  ]);
  expect((await student()).attempt).toMatchObject({
    id: attemptId,
    scoreAuto: 50,
  });
  expect((await student()).summary.scoreFinal).toBe(100);
  expect(receipt()).toMatchObject({ result_json: expect.any(String) });
  expect(await markOk(request)).toMatchObject({
    revision: 1,
    eventId: accepted[0]?.id,
    teacherComment: request.comment,
    scoreFinal: 100,
  });
  expect(kernelEvents()).toEqual(accepted);
});
