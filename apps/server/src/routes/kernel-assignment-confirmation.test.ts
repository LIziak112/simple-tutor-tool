import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AttemptSubmitRequest,
  attemptResultOkSchema,
  attemptStartOkSchema,
  type SubmitEvidenceDeclaration,
  teacherAttemptDetailOkSchema,
} from "@tutor/contract";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import {
  assignFixture,
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import {
  callToolJson,
  connectMcpClientViaApp,
} from "../test/mcp-test-utils.ts";
import {
  makeNotePng,
  postNoteImage,
  putNoteForm,
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
      "SELECT COUNT(*) AS n FROM responses WHERE attempt_id=? AND (answer_json IS NOT NULL OR answer_revision <> 0 OR answer_mutation_id IS NOT NULL OR auto_correct IS NOT NULL OR final_correct IS NOT NULL)",
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

it("内核已确认而宿主仍是草稿时拒绝新原稿，只重发已保存的同一版本回执", async () => {
  const work = await open(
    await assignKernelFixture(app, world),
    world.ownerCookie,
  );
  const questionId = work.first.questionId;
  const mutationId = randomUUID();
  const original = await putNoteReceipt(
    app,
    work.cookie,
    work.id,
    questionId,
    1,
    {
      mutationId,
    },
  );
  const request = {
    revisions: await work.revisions(),
    evidence: [
      {
        questionId,
        state: "frozen",
        versionId: original.versionId,
        revision: 1,
      },
      { questionId: work.second.questionId, state: "none" },
    ],
  } satisfies AttemptSubmitRequest;
  db.$client.exec(`
    CREATE TRIGGER interrupt_before_note_guard_projection BEFORE UPDATE OF status ON attempts
    WHEN NEW.status = 'graded'
    BEGIN SELECT RAISE(ABORT, 'interrupted original guard projection'); END
  `);
  try {
    expect((await work.submit(request)).status).toBe(500);
  } finally {
    db.$client.exec("DROP TRIGGER interrupt_before_note_guard_projection");
  }

  expect(
    db.$client.prepare("SELECT status FROM attempts WHERE id=?").get(work.id),
  ).toEqual({ status: "draft" });
  const save = (
    strokes: number,
    options: { baseRevision: number; mutationId?: string },
  ) =>
    app.request(`${work.root}/notes/${questionId}`, {
      method: "PUT",
      headers: { cookie: work.cookie },
      body: putNoteForm(strokes, options),
    });
  await denied(await save(2, { baseRevision: 1 }), 409, "ALREADY_SUBMITTED");
  const replay = await save(1, { baseRevision: 0, mutationId });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ ok: true, data: original });
  expect(
    db.$client
      .prepare("SELECT revision FROM note_versions WHERE note_id=?")
      .all(original.noteId),
  ).toEqual([{ revision: 1 }]);
  await result(await call(work.root, work.cookie));
  expect(evidence(work.id)).toContainEqual({
    question_id: questionId,
    state: "frozen",
    version_id: original.versionId,
  });
});

const epoch = 1_769_000_000_000;
function event(type: string, second: number, questionId: string) {
  return { type, clientTs: epoch + second * 1000, questionId };
}

async function sendActivity(
  work: { root: string; cookie: string },
  events: ReturnType<typeof event>[],
) {
  const response = await call(`${work.root}/events`, work.cookie, "POST", {
    events,
    viewId: "m05-p04",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    data: { accepted: events.length },
  });
}

async function teacherActivity(attemptId: string) {
  const response = await call(
    `/api/teacher/attempts/${attemptId}`,
    world.teacher,
  );
  expect(response.status).toBe(200);
  const { activeSec, scoreFinal, questions } =
    teacherAttemptDetailOkSchema.parse(await response.json()).data;
  return {
    activeSec,
    scoreFinal,
    rows: questions.map((row) => [row.activeSec, row.changeCount]),
  };
}

function storedActivity(attemptId: string) {
  return {
    rows: db.$client
      .prepare(
        `SELECT r.active_sec, r.change_count, l.active_sec AS sealed_sec, l.state, l.reason
        FROM responses r LEFT JOIN response_time_ledger l ON l.response_id=r.id
        WHERE r.attempt_id=? ORDER BY r.question_id`,
      )
      .all(attemptId),
    seals: db.$client
      .prepare(
        "SELECT COUNT(*) n FROM attempt_event_receipts WHERE attempt_id=? AND kind='seal'",
      )
      .get(attemptId),
    profile: db.$client
      .prepare("SELECT version FROM attempt_time_profiles WHERE attempt_id=?")
      .get(attemptId),
  };
}

async function teacherTool() {
  const response = await call("/api/teacher/api-token", world.teacher, "POST");
  expect(response.status).toBe(200);
  const { data } = (await response.json()) as { data: { token: string } };
  return connectMcpClientViaApp(app, "/mcp", data.token, "m05-p04-activity");
}

it("正式整卷封存逐题焦点、协议 1 活动水位及 max 改答计数，迟到事件仍可接收", async () => {
  const candidateAssignment = await assignKernelFixture(app, world);
  const legacyAssignment = await assignFixture(
    app,
    world.teacher,
    world.unitId,
    world.studentId,
  );
  for (const assignment of [legacyAssignment, candidateAssignment]) {
    const work = await open(assignment, world.ownerCookie);
    const q1 = work.first.questionId;
    const q2 = work.second.questionId;
    await sendActivity(work, [
      event("question_focus", 0, q1),
      event("answer_change", 2, q1),
      event("answer_change", 4, q1),
      event("question_blur", 8, q1),
      event("question_focus", 10, q2),
      event("answer_change", 11, q2),
      event("question_blur", 15, q2),
    ]);
    await work.save(0, 1);
    const request = { revisions: await work.revisions() };
    const submitted = await result(await work.submit(request));
    expect.soft(submitted.time).toMatchObject({
      metric: "question_activity_sealed",
      version: 1,
      activeSec: 13,
      knownCount: 2,
      unknownCount: 0,
    });
    const expected = {
      activeSec: 13,
      scoreFinal: 50,
      rows: [
        [8, 2],
        [5, 1],
      ],
    };
    expect.soft(await teacherActivity(work.id)).toEqual(expected);
    const atSubmission = storedActivity(work.id);
    expect.soft(atSubmission).toEqual({
      profile: { version: 1 },
      seals: { n: 1 },
      rows: [
        {
          active_sec: 8,
          change_count: 2,
          sealed_sec: 8,
          state: "available",
          reason: null,
        },
        {
          active_sec: 5,
          change_count: 1,
          sealed_sec: 5,
          state: "available",
          reason: null,
        },
      ],
    });
    await sendActivity(work, [
      event("question_focus", 16, q2),
      event("answer_change", 17, q2),
      event("question_blur", 20, q2),
    ]);
    expect.soft(await teacherActivity(work.id)).toEqual(expected);
    expect(storedActivity(work.id)).toEqual(atSubmission);
    await denied(await work.submit(request), 409, "ALREADY_SUBMITTED");
    if (assignment === candidateAssignment) authorityFacts(work.id, true);
  }
});

it("正式交卷按学生实际保存计数，教师代改只推进答案修订，缺证的时间保持未知", async () => {
  const work = await open(
    await assignKernelFixture(app, world),
    world.ownerCookie,
  );
  const teacher = await teacherTool();
  try {
    const edit = (questionId: string, expectedAnswerRevision: number) =>
      callToolJson(teacher, "update_response_answer", {
        attemptId: work.id,
        questionId,
        expectedAnswerRevision,
        answer: { kind: "choice", index: 1 },
        reason: "合成教师代改",
      });
    expect((await edit(work.first.questionId, 0)).isError).toBe(false);
    await work.save(1, 1);
    await work.save(1, 0);
    expect((await edit(work.second.questionId, 2)).isError).toBe(false);
    await sendActivity(work, [
      event("answer_change", 4, work.second.questionId),
    ]);

    const submitted = await result(await work.submit());
    expect.soft(submitted.time).toMatchObject({
      metric: "question_activity_sealed",
      knownCount: 1,
      unknownCount: 1,
      knownActiveSec: 0,
      activeSec: null,
    });
    const response = await callToolJson(teacher, "query_student_responses", {
      studentId: world.studentId,
      attemptIds: [work.id],
    });
    expect(response.isError).toBe(false);
    const rows = response.data.responses as { questionId: string }[];
    expect
      .soft(rows.toSorted((a, b) => a.questionId.localeCompare(b.questionId)))
      .toMatchObject([
        {
          questionId: work.first.questionId,
          answerRevision: 1,
          changeCount: 0,
          activeSec: null,
        },
        {
          questionId: work.second.questionId,
          answerRevision: 3,
          changeCount: 2,
          activeSec: null,
        },
      ]);
    expect.soft(storedActivity(work.id)).toMatchObject({
      seals: { n: 1 },
      rows: [
        {
          active_sec: null,
          change_count: 0,
          sealed_sec: null,
          state: "unknown",
          reason: "no_client_evidence",
        },
        {
          active_sec: null,
          change_count: 2,
          sealed_sec: 0,
          state: "available",
          reason: null,
        },
      ],
    });
    authorityFacts(work.id, true);
  } finally {
    await teacher.close();
  }
});

it("答案冲突保稿且释放活动预留，下一次有效交卷按新的收件水位封存", async () => {
  const work = await open(
    await assignKernelFixture(app, world),
    world.ownerCookie,
  );
  const q1 = work.first.questionId;
  const stale = { revisions: await work.revisions() };
  await sendActivity(work, [
    event("question_focus", 0, q1),
    event("answer_change", 1, q1),
    event("question_blur", 3, q1),
  ]);
  await work.save(0, 1);
  const conflict = await denied(
    await work.submit(stale),
    409,
    "ANSWER_REVISION_CONFLICT",
  );
  expect(conflict).toMatchObject({
    _questionId: q1,
    _current: { revision: 1, draft: { kind: "choice", index: 1 } },
  });
  expect(storedActivity(work.id)).toMatchObject({
    seals: { n: 0 },
    rows: [
      { state: null, active_sec: null },
      { state: null, active_sec: null },
    ],
  });
  authorityFacts(work.id, false);
  await sendActivity(work, [
    event("question_focus", 4, q1),
    event("answer_change", 5, q1),
    event("question_blur", 8, q1),
  ]);
  await result(await work.submit());
  expect(await teacherActivity(work.id)).toEqual({
    activeSec: 7,
    scoreFinal: 50,
    rows: [
      [7, 2],
      [null, 0],
    ],
  });
  authorityFacts(work.id, true);
});

it("升级后恢复已确认但没有旧活动水位的票据，保留历史未知且不从迟到事件补算", async () => {
  const work = await open(
    await assignKernelFixture(app, world),
    world.ownerCookie,
  );
  await work.save(0, 1);
  db.$client.exec(`
    CREATE TRIGGER interrupt_legacy_ticket BEFORE UPDATE OF status ON attempts
    WHEN NEW.status = 'graded'
    BEGIN SELECT RAISE(ABORT, 'interrupted host projection'); END
  `);
  try {
    expect((await work.submit()).status).toBe(500);
  } finally {
    db.$client.exec("DROP TRIGGER interrupt_legacy_ticket");
  }
  db.$client
    .prepare(`
    UPDATE kernel_attempt_confirmations
    SET request_json = json_remove(request_json, '$.activitySeal')
    WHERE attempt_id = ?
  `)
    .run(work.id);
  await sendActivity(work, [
    event("question_focus", 0, work.first.questionId),
    event("answer_change", 1, work.first.questionId),
    event("question_blur", 3, work.first.questionId),
  ]);
  expect(await teacherActivity(work.id)).toEqual({
    activeSec: null,
    scoreFinal: 50,
    rows: [
      [null, 1],
      [null, 0],
    ],
  });
  expect((await result(await call(work.root, work.cookie))).time).toMatchObject(
    {
      metric: "question_activity_sealed",
      knownCount: 0,
      unknownCount: 2,
      activeSec: null,
    },
  );
  expect(storedActivity(work.id)).toMatchObject({
    seals: { n: 0 },
    rows: [
      { state: null, active_sec: null },
      { state: null, active_sec: null },
    ],
  });
  authorityFacts(work.id, true);
});
