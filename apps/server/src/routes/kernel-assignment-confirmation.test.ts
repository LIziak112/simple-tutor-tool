import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AttemptSubmitRequest,
  attemptResultOkSchema,
  attemptStartOkSchema,
  type SubmitEvidenceDeclaration,
} from "@tutor/contract";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import {
  makeNotePng,
  postNoteImage,
  putNoteReceipt,
} from "../test/note-fixtures.ts";
import { fetchSubmitRevisions } from "../test/submit-revisions.ts";

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
let kernelAssignment: string;
let withheldAssignment: string;

beforeAll(async () => {
  world = await setupAssignment(app);
  kernelAssignment = await assignKernelFixture(app, world);
  withheldAssignment = await assignKernelFixture(app, world, {
    dueAt: "2099-01-01T00:00:00.000Z",
    answerRelease: "after_due",
  });
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

async function open(assignmentId: string, cookie: string) {
  const start = await postAssignment(app, assignmentId, cookie);
  expect(start.status, await start.clone().text()).toBe(200);
  const { id, frozenAt } = attemptStartOkSchema.parse(await start.json()).data;
  const root = `/api/student/attempts/${id}`;
  const revisions = () => fetchSubmitRevisions(app, cookie, id);
  const [first, second] = await revisions();
  if (!first || !second) throw new Error("没有两道冻结题");
  expect([first.questionId, second.questionId]).toEqual([
    "m04-p0-q1",
    "m04-p0-q2",
  ]);
  return {
    id,
    cookie,
    root,
    first,
    second,
    revisions,
    async save(index: number, choice: number, legacy = false) {
      const question = (await revisions())[index];
      if (!question) throw new Error("没有冻结题");
      const answer = { kind: "choice", index: choice };
      const response = await call(
        `${root}/answers/${question.questionId}`,
        cookie,
        "PUT",
        legacy
          ? { answer }
          : {
              answer,
              mutationId: randomUUID(),
              baseRevision: question.expectedAnswerRevision,
              expectedFrozenAt: frozenAt,
              questionRevisionId: question.questionRevisionId,
            },
      );
      expect(response.status, await response.clone().text()).toBe(200);
    },
    async submit(request?: AttemptSubmitRequest, actor = cookie) {
      return call(
        `${root}/submit`,
        actor,
        "POST",
        request ?? { revisions: await revisions() },
      );
    },
  };
}

async function result(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  const body: unknown = await response.json();
  expect(JSON.stringify(body)).not.toMatch(
    /"(scoringKey|keyRef|acceptedChoice|acceptedChoices|evaluation)"\s*:/u,
  );
  return attemptResultOkSchema.parse(body).data;
}

async function denied(response: Response, status: number, error: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ ok: false, error });
  expect(body).not.toHaveProperty("data");
  return body;
}

function evidence(attemptId: string) {
  return db.$client
    .prepare(
      "SELECT question_id, state, version_id FROM submission_evidence WHERE attempt_id=? ORDER BY question_id",
    )
    .all(attemptId);
}

function authorityFacts(attemptId: string, submitted: boolean) {
  const key = db.$client
    .prepare(
      "SELECT operation_id FROM kernel_attempt_confirmations WHERE attempt_id=?",
    )
    .get(attemptId);
  expect(key !== undefined).toBe(submitted);
  expect(
    db.$client
      .prepare(
        "SELECT status, score_auto, score_final FROM attempts WHERE id=?",
      )
      .get(attemptId),
  ).toEqual({
    status: submitted ? "graded" : "draft",
    score_auto: null,
    score_final: null,
  });
  const writes = db.$client
    .prepare(
      "SELECT COUNT(*) AS n FROM responses WHERE attempt_id=? AND (answer_json IS NOT NULL OR answer_revision <> 0 OR change_count <> 0 OR auto_correct IS NOT NULL OR final_correct IS NOT NULL)",
    )
    .get(attemptId);
  expect(writes).toEqual({ n: 0 });
  using kernel = new DatabaseSync(join(dataDir, "learning-kernel.sqlite"), {
    readOnly: true,
  });
  expect(
    kernel
      .prepare(
        "SELECT COUNT(*) AS n FROM submissions s JOIN step_attempts a ON a.id=s.step_attempt_id WHERE a.activity_id=?",
      )
      .get(attemptId),
  ).toEqual({ n: submitted ? 1 : 0 });
  expect(
    kernel
      .prepare("SELECT COUNT(*) AS n FROM completions WHERE activity_id=?")
      .get(attemptId),
  ).toEqual({ n: submitted ? 1 : 0 });
  expect(
    kernel
      .prepare(`SELECT COUNT(*) AS n FROM automatic_verdicts v
      JOIN submissions s ON s.id=v.submission_id JOIN step_attempts a ON a.id=s.step_attempt_id WHERE a.activity_id=?`)
      .get(attemptId),
  ).toEqual({ n: submitted ? 2 : 0 });
}

it("相同 P0 部分作答经正式 POST 交卷，内核与旧卷均按两题计算", async () => {
  const { ownerCookie } = world;
  const legacy = await open(world.assignmentId, ownerCookie);
  await legacy.save(0, 1);
  const expected = await result(await legacy.submit());
  const candidate = await open(kernelAssignment, ownerCookie);
  await candidate.save(0, 1);
  const actual = await result(await candidate.submit());
  expect(expected.attempt.scoreAuto).toBe(50);
  expect(actual.attempt.scoreAuto).toBe(expected.attempt.scoreAuto);
  expect(actual.summary).toEqual(expected.summary);
  expect(
    actual.units[0]?.questions.map(({ answer, autoCorrect, answered }) => ({
      answer,
      autoCorrect,
      answered,
    })),
  ).toEqual(
    expected.units[0]?.questions.map(({ answer, autoCorrect, answered }) => ({
      answer,
      autoCorrect,
      answered,
    })),
  );
  expect(evidence(candidate.id)).toEqual([]);
  authorityFacts(candidate.id, true);
  expect(await result(await call(candidate.root, ownerCookie))).toEqual(actual);
});

it("V1 原稿、冻结行或答案版本失配后还能正常交 V2，精确重发只得一次提交", async () => {
  const { otherCookie, ownerCookie, teacher } = world;
  const work = await open(kernelAssignment, otherCookie);
  await work.save(0, 1, true);
  await work.save(1, 2, true);
  const { questionId } = work.first;
  const v1 = await putNoteReceipt(app, otherCookie, work.id, questionId);
  const v2 = await putNoteReceipt(app, otherCookie, work.id, questionId, 2, {
    baseRevision: v1.revision,
  });
  expect([v1.revision, v2.revision]).toEqual([1, 2]);
  const png = makeNotePng();
  const image = await postNoteImage(
    app,
    "student",
    v2.versionId,
    png,
    otherCookie,
  );
  expect(image.status).toBe(200);
  const imageId = ((await image.json()) as { data: { imageId: string } }).data
    .imageId;
  const docPath = `/api/student/note-versions/${v2.versionId}/document`;
  const imagePath = `/api/student/note-versions/${v2.versionId}/images/${imageId}.png`;
  const doc = await call(docPath, otherCookie);
  expect(doc.status).toBe(200);
  const docBytes = Buffer.from(await doc.arrayBuffer());
  const revisions = await work.revisions();
  const original = (version: typeof v1): SubmitEvidenceDeclaration[] => [
    {
      questionId,
      state: "frozen",
      versionId: version.versionId,
      revision: version.revision,
    },
    { questionId: work.second.questionId, state: "none" },
  ];
  const request = { revisions, evidence: original(v2) };
  await denied(await work.submit(request, ownerCookie), 403, "FORBIDDEN");
  await denied(
    await work.submit({
      ...request,
      revisions: revisions.map((item, index) =>
        index === 0 ? { ...item, questionRevisionId: randomUUID() } : item,
      ),
    }),
    409,
    "QUESTION_REVISION_STALE",
  );
  await denied(
    await work.submit({ revisions, evidence: original(v1) }),
    409,
    "NOTE_EVIDENCE_MISMATCH",
  );
  authorityFacts(work.id, false);
  const conflict = await denied(
    await work.submit({
      ...request,
      revisions: revisions.map((item, index) =>
        index === 0 ? { ...item, expectedAnswerRevision: 0 } : item,
      ),
    }),
    409,
    "ANSWER_REVISION_CONFLICT",
  );
  expect(conflict).toMatchObject({
    _questionId: questionId,
    _current: { revision: 1, draft: { kind: "choice", index: 1 } },
  });
  authorityFacts(work.id, false);
  expect(evidence(work.id)).toEqual([]);
  expect(
    db.$client
      .prepare(
        "SELECT state, pending_version_id FROM attempt_original_reservations WHERE attempt_id=?",
      )
      .all(work.id),
  ).toEqual([{ state: "aborted", pending_version_id: null }]);

  const confirmed = await result(await work.submit(request));
  expect(confirmed.attempt.scoreAuto).toBe(100);
  expect(confirmed.summary).toMatchObject({
    total: 2,
    answered: 2,
    correct: 2,
    autoGradable: 2,
  });
  expect(evidence(work.id)).toEqual([
    { question_id: questionId, state: "frozen", version_id: v2.versionId },
    { question_id: work.second.questionId, state: "none", version_id: null },
  ]);
  expect(await result(await call(work.root, otherCookie))).toEqual(confirmed);
  await denied(await work.submit(request), 409, "ALREADY_SUBMITTED");
  await denied(await call(work.root, ownerCookie), 403, "FORBIDDEN");
  await denied(await call(docPath, ownerCookie), 403, "FORBIDDEN");
  expect(
    Buffer.from(await (await call(docPath, otherCookie)).arrayBuffer()),
  ).toEqual(docBytes);
  expect(
    Buffer.from(await (await call(imagePath, otherCookie)).arrayBuffer()),
  ).toEqual(Buffer.from(png));
  await denied(
    await call(
      `/api/teacher/responses/${work.first.questionRevisionId}/mark`,
      teacher,
      "POST",
      {
        mark: "wrong",
        comment: "不可经旧判分入口写入",
      },
    ),
    503,
    "KERNEL_ATTEMPT_WRITE_UNAVAILABLE",
  );
  authorityFacts(work.id, true);
});

it("截止前只下发学生本人答案，改过的当前修订在公布后给两题汇总", async () => {
  const { ownerCookie, teacher } = world;
  const work = await open(withheldAssignment, ownerCookie);
  await work.save(0, 0);
  await work.save(0, 1);
  await work.save(1, 0);
  const revisions = await work.revisions();
  expect(
    revisions.map(({ expectedAnswerRevision }) => expectedAnswerRevision),
  ).toEqual([2, 1]);
  const hidden = await result(await work.submit({ revisions }));
  expect(hidden.answersReleased).toBe(false);
  expect(hidden.attempt.scoreAuto).toBeNull();
  expect(hidden.summary).toMatchObject({
    total: 2,
    answered: 2,
    correct: 0,
    autoGradable: 0,
    scoreFinal: null,
    pendingCount: null,
  });
  for (const question of hidden.units.flatMap(({ questions }) => questions)) {
    expect(question).toMatchObject({
      answers: null,
      autoCorrect: null,
      finalCorrect: null,
      solutionMd: null,
    });
    expect(question.answer).not.toBeNull();
  }
  expect(JSON.stringify(hidden)).not.toContain("合成详解");
  const read = await result(await call(work.root, ownerCookie));
  expect(read).toEqual({ ...hidden, releaseCheckedAt: read.releaseCheckedAt });
  const edited = await call(
    `/api/teacher/assignments/${withheldAssignment}`,
    teacher,
    "PATCH",
    {
      dueAt: "2000-01-01T00:00:00.000Z",
    },
  );
  expect(edited.status).toBe(200);
  const released = await result(await call(work.root, ownerCookie));
  expect(released.answersReleased).toBe(true);
  expect(released.attempt.scoreAuto).toBe(50);
  expect(released.summary).toMatchObject({
    total: 2,
    answered: 2,
    correct: 1,
    wrong: 1,
    autoGradable: 2,
  });
  authorityFacts(work.id, true);
});

it("两份不同原稿声明争交全空卷，只确认赢家，已有稿的 missing 不冒作 frozen", async () => {
  const work = await open(
    await assignKernelFixture(app, world),
    world.otherCookie,
  );
  await putNoteReceipt(app, work.cookie, work.id, work.first.questionId);
  const revisions = await work.revisions();
  expect(
    revisions.map(({ expectedAnswerRevision }) => expectedAnswerRevision),
  ).toEqual([0, 0]);
  const a = {
    revisions,
    evidence: [
      { questionId: work.first.questionId, state: "missing" },
      { questionId: work.second.questionId, state: "none" },
    ],
  } satisfies AttemptSubmitRequest;
  const b = {
    ...a,
    evidence: [
      { questionId: work.first.questionId, state: "missing" },
      { questionId: work.second.questionId, state: "missing" },
    ],
  } satisfies AttemptSubmitRequest;
  const [first, second] = await Promise.all([work.submit(a), work.submit(b)]);
  expect([first.status, second.status].sort()).toEqual([200, 409]);
  const chosen = first.status === 200 ? a : b;
  const completed = await result(first.status === 200 ? first : second);
  expect(completed.attempt.scoreAuto).toBe(0);
  expect(completed.summary).toMatchObject({
    total: 2,
    answered: 0,
    unanswered: 2,
    autoGradable: 2,
  });
  await denied(first.status === 409 ? first : second, 409, "ALREADY_SUBMITTED");
  expect(evidence(work.id)).toEqual(
    chosen.evidence.map(({ questionId, state }) => ({
      question_id: questionId,
      state,
      version_id: null,
    })),
  );
  authorityFacts(work.id, true);
});
