import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  attemptResultOkSchema,
  attemptStartOkSchema,
  teacherAttemptDetailOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { responses } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import {
  assignFixture,
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import { nodePeerBindings } from "../test/node-peer.ts";
import { putNoteReceipt } from "../test/note-fixtures.ts";
import { extractSessionToken } from "../test/note-world.ts";
import { submitAttemptRequest } from "../test/submit-revisions.ts";

const db = createTestDb();
const dataDir = createTestDir();
const kernelPath = join(dataDir, "learning-kernel.sqlite");
const app = createApp({
  db,
  dataDir,
  kernelAssignmentCreationEnabled: true,
  isProduction: false,
  logger: pino({ enabled: false }),
  publicUrl: "http://localhost:8787",
});
const dueAt = "2099-01-01T00:00:00.000Z";
const first = "m04-p0-q1";
const second = "m04-p0-q2";
let world: Awaited<ReturnType<typeof setupAssignment>>;
let kernelAssignment: string;
let legacyGradingAssignment: string;
let outsider: string;

beforeAll(async () => {
  world = await setupAssignment(app, dueAt);
  kernelAssignment = await assignKernelFixture(app, world, {
    dueAt,
    answerRelease: "after_due",
  });
  legacyGradingAssignment = await assignFixture(
    app,
    world.teacher,
    world.unitId,
    world.studentId,
    dueAt,
  );
  const registration = await app.request(
    "/api/public/teacher/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        loginName: "合成他师",
        password: "other-teacher-8",
      }),
    },
    nodePeerBindings("10.0.0.2"),
  );
  expect(registration.status).toBe(200);
  outsider = `tutor_session=${extractSessionToken(registration)}`;
});

afterAll(() => {
  db.$client.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function call(path: string, cookie: string, method = "GET", body?: object) {
  return app.request(path, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const teacherPath = (id: string) => `/api/teacher/attempts/${id}`;
const studentPath = (id: string) => `/api/student/attempts/${id}`;
const choice = (index: number) => ({ kind: "choice", index });

async function open(assignmentId: string, cookie: string) {
  const opened = await postAssignment(app, assignmentId, cookie);
  expect(opened.status, await opened.clone().text()).toBe(200);
  return attemptStartOkSchema.parse(await opened.json()).data.id;
}

async function save(
  id: string,
  cookie: string,
  questionId: string,
  index: number,
) {
  const response = await call(
    `${studentPath(id)}/answers/${questionId}`,
    cookie,
    "PUT",
    { answer: choice(index) },
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

async function teacherDetail(id: string) {
  const response = await call(teacherPath(id), world.teacher);
  expect(response.status, await response.clone().text()).toBe(200);
  return teacherAttemptDetailOkSchema.parse(await response.json()).data;
}

async function denied(response: Response, status: number, error?: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ ok: false, ...(error ? { error } : {}) });
  expect(body).not.toHaveProperty("data");
}

function teacherFacts({
  questions,
  status,
  scoreAuto,
  scoreFinal,
  resultCounts,
  correctCount,
  wrongCount,
  notDoneCount,
  pendingCount,
  selfReviewPendingCount,
}: Awaited<ReturnType<typeof teacherDetail>>) {
  return {
    status,
    scoreAuto,
    scoreFinal,
    resultCounts,
    correctCount,
    wrongCount,
    notDoneCount,
    pendingCount,
    selfReviewPendingCount,
    questions: questions.map(
      ({
        questionId,
        stemMd,
        options,
        answers,
        solutionMd,
        answer,
        answered,
        autoCorrect,
        finalCorrect,
        changeCount,
      }) => ({
        questionId,
        stemMd,
        options,
        answers,
        solutionMd,
        answer,
        answered,
        autoCorrect,
        finalCorrect,
        changeCount,
      }),
    ),
  };
}

it("教师在进行中看当前选项和有效变更，逐题判定仍未放行", async () => {
  const { ownerCookie, otherCookie } = world;
  const legacy = await open(world.assignmentId, ownerCookie);
  const candidate = await open(kernelAssignment, otherCookie);
  await save(legacy, ownerCookie, first, 1);
  await save(candidate, otherCookie, first, 1);
  const expected = teacherFacts(await teacherDetail(legacy));
  expect(expected).toMatchObject({
    status: "draft",
    scoreAuto: null,
    scoreFinal: null,
    resultCounts: null,
    questions: [
      {
        questionId: first,
        answer: choice(1),
        changeCount: 1,
        answered: false,
        autoCorrect: null,
        finalCorrect: null,
      },
      { questionId: second, answer: null, changeCount: 0, answered: false },
    ],
  });
  expect(teacherFacts(await teacherDetail(candidate))).toEqual(expected);
  await denied(
    await call(studentPath(candidate), ownerCookie),
    403,
    "FORBIDDEN",
  );

  const offlinePath = `${kernelPath}.offline`;
  renameSync(kernelPath, offlinePath);
  try {
    await denied(
      await call(teacherPath(candidate), world.teacher),
      503,
      "KERNEL_ATTEMPT_UNAVAILABLE",
    );
    await denied(
      await call(teacherPath(candidate), outsider),
      404,
      "ATTEMPT_NOT_FOUND",
    );
  } finally {
    renameSync(offlinePath, kernelPath);
  }
});

it("教师首读补全已确认卷，公布前后均保留同一冻结事实和原稿", async () => {
  const { ownerCookie, otherCookie } = world;
  const legacy = await open(legacyGradingAssignment, ownerCookie);
  const candidate = await open(kernelAssignment, ownerCookie);
  for (const id of [legacy, candidate]) {
    await save(id, ownerCookie, first, 0);
    await save(id, ownerCookie, first, 1);
    await save(id, ownerCookie, second, 0);
  }
  const v1 = await putNoteReceipt(app, ownerCookie, candidate, first);
  const v2 = await putNoteReceipt(app, ownerCookie, candidate, first, 2, {
    baseRevision: v1.revision,
  });
  const evidence = [
    {
      questionId: first,
      state: "frozen",
      versionId: v2.versionId,
      revision: v2.revision,
    },
    { questionId: second, state: "none" },
  ] as const;
  const normal = await submitAttemptRequest(app, ownerCookie, legacy);
  expect(normal.status, await normal.clone().text()).toBe(200);
  const expected = teacherFacts(await teacherDetail(legacy));
  expect(expected).toMatchObject({
    status: "graded",
    scoreAuto: 50,
    scoreFinal: 50,
    correctCount: 1,
    wrongCount: 1,
    notDoneCount: 0,
    pendingCount: 0,
    selfReviewPendingCount: 0,
    resultCounts: { correctCount: 1, totalCount: 2, pendingCount: 0 },
    questions: [
      {
        questionId: first,
        answer: choice(1),
        changeCount: 2,
        answered: true,
        autoCorrect: true,
        finalCorrect: true,
      },
      {
        questionId: second,
        answer: choice(0),
        changeCount: 1,
        answered: true,
        autoCorrect: false,
        finalCorrect: false,
      },
    ],
  });

  const host = () =>
    db.$client
      .prepare(
        "SELECT status, submitted_at, score_auto, score_final FROM attempts WHERE id = ?",
      )
      .get(candidate);
  const submitted = () =>
    db.$client
      .prepare(
        "SELECT version_id FROM submission_evidence WHERE attempt_id = ? AND question_id = ?",
      )
      .get(candidate, first);
  const frozenRows = () =>
    db
      .select()
      .from(responses)
      .where(eq(responses.attemptId, candidate))
      .orderBy(responses.questionId)
      .all();
  const frozen = frozenRows();
  db.$client.exec(`
    CREATE TRIGGER interrupt_teacher_result BEFORE UPDATE OF status ON attempts
    WHEN NEW.id = '${candidate}' AND NEW.status = 'graded'
    BEGIN SELECT RAISE(ABORT, 'M04 confirmation projection interruption'); END
  `);
  try {
    await denied(
      await submitAttemptRequest(app, ownerCookie, candidate, evidence),
      500,
    );
  } finally {
    db.$client.exec("DROP TRIGGER interrupt_teacher_result");
  }
  expect(host()).toMatchObject({ status: "draft", submitted_at: null });
  expect(submitted()).toBeUndefined();
  using kernel = new DatabaseSync(kernelPath, { readOnly: true });
  const verdicts = () =>
    kernel
      .prepare(`
    SELECT v.* FROM automatic_verdicts v JOIN submissions s ON s.id = v.submission_id
    JOIN step_attempts a ON a.id = s.step_attempt_id WHERE a.activity_id = ? ORDER BY v.question_id
  `)
      .all(candidate);
  const confirmed = verdicts();
  expect(confirmed).toHaveLength(2);

  await denied(
    await call(teacherPath(candidate), outsider),
    404,
    "ATTEMPT_NOT_FOUND",
  );
  await denied(
    await call(studentPath(candidate), otherCookie),
    403,
    "FORBIDDEN",
  );
  await denied(await call(teacherPath(candidate), otherCookie), 401);
  expect(host()).toMatchObject({ status: "draft", submitted_at: null });

  const recovered = await teacherDetail(candidate);
  expect(teacherFacts(recovered)).toEqual(expected);
  expect(recovered.questions.map(({ responseId }) => responseId)).toEqual(
    frozen.map(({ id }) => id),
  );
  expect(host()).toMatchObject({
    status: "graded",
    submitted_at: recovered.submittedAt,
    score_auto: null,
    score_final: null,
  });
  expect(submitted()).toEqual({ version_id: v2.versionId });
  const studentOriginal = await call(
    `/api/student/note-versions/${v2.versionId}/document`,
    ownerCookie,
  );
  expect(studentOriginal.status).toBe(200);
  const teacherOriginalPath = `/api/teacher/note-versions/${v2.versionId}/document`;
  const teacherOriginal = await call(teacherOriginalPath, world.teacher);
  expect(teacherOriginal.status).toBe(200);
  expect(await teacherOriginal.text()).toBe(await studentOriginal.text());
  expect((await call(teacherOriginalPath, outsider)).status).toBe(404);

  expect(frozenRows()).toEqual(frozen);
  expect(verdicts()).toEqual(confirmed);

  const student = await call(studentPath(candidate), ownerCookie);
  expect(student.status).toBe(200);
  const hidden = attemptResultOkSchema.parse(await student.json()).data;
  expect(hidden.answersReleased).toBe(false);
  expect(hidden.attempt.scoreAuto).toBeNull();
  for (const question of hidden.units.flatMap(({ questions }) => questions)) {
    expect(question).toMatchObject({
      answers: null,
      autoCorrect: null,
      finalCorrect: null,
      solutionMd: null,
    });
  }

  const release = await call(
    `/api/teacher/assignments/${kernelAssignment}`,
    world.teacher,
    "PATCH",
    {
      dueAt: "2000-01-01T00:00:00.000Z",
    },
  );
  expect(release.status).toBe(200);
  expect(teacherFacts(await teacherDetail(candidate))).toEqual(expected);
  expect(verdicts()).toEqual(confirmed);

  const logout = await call("/api/teacher/logout", world.teacher, "POST");
  expect(logout.status).toBe(200);
  await denied(await call(teacherPath(candidate), world.teacher), 401);
});
