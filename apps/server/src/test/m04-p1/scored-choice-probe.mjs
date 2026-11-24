import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { attemptStartOkSchema } from "@tutor/contract";
import { openLearningRuntime } from "learning-kernel";
import pino from "pino";
import serverPackage from "../../../package.json" with { type: "json" };
import { createApp } from "../../app.ts";
import { createDb } from "../../db/client.ts";
import { createTestDb, createTestDir } from "../../db/test-utils.ts";
import { HttpError } from "../../lib/http-error.ts";
import { answerReleaseProjection } from "../../services/answer-publication.ts";
import {
  requireAssignmentRow,
  requireAssignmentVisible,
  requireUsableAttempt,
} from "../../services/attempt-access.ts";
import {
  createOwnClassChoiceEvaluator,
  ownClassChoiceEvaluatorRef,
} from "../../services/attempt-choice-evaluation.ts";
import {
  prepareChoiceOriginals,
  projectConfirmedChoiceEvidence,
} from "../../services/attempt-choice-evidence.ts";
import { scoreAutoOf } from "../../services/attempt-final-outcome.ts";
import { attemptResponseRows } from "../../services/attempt-freeze.ts";
import { scoreSummaryCoreOf } from "../../services/attempt-score-summary.ts";
import { attemptSummaryOf } from "../../services/attempt-summary.ts";
import {
  makeNotePng,
  postNoteImage,
  putNoteReceipt,
} from "../note-fixtures.ts";
import { fetchSubmitRevisions } from "../submit-revisions.ts";
import { createTrialApp } from "./assembly.ts";
import { createTrialChoiceDraftSaver } from "./choice-draft-adapter.ts";
import {
  assignFixture,
  attemptFacts,
  postAssignment,
  setupAssignment,
} from "./product-fixture.ts";
import {
  draftForAssignment,
  projectTrialDraft,
  publicationForAssignment,
} from "./publication.ts";

const [mode] = process.argv.slice(2);
assert.ok(mode === undefined || mode === "--all-withheld");
const allWithheld = mode === "--all-withheld";
const dependency = serverPackage.dependencies["learning-kernel"];
const archive = /^file:(vendor\/learning-kernel-([0-9a-f]{64})\.tgz)$/u.exec(
  dependency,
);
assert.ok(archive?.[1]);
const sha = createHash("sha256")
  .update(readFileSync(new URL(`../../../${archive[1]}`, import.meta.url)))
  .digest("hex");
assert.equal(sha, archive[2]);
const entry = import.meta.resolve("learning-kernel");
const dataDir = createTestDir();
const productPath = join(dataDir, "ownclass.sqlite");
const kernelPath = join(dataDir, "learning-kernel.sqlite");
const template = createTestDb();
writeFileSync(productPath, template.$client.serialize());
template.$client.close();
let db = createDb(productPath);
let runtime;
let app;
let hostApp;
let activeRecovery;
let activeOriginals;
const bindings = new Map();
const evaluated = new Map();
const rejectedEvaluatorInputs = [];
const principal = (id) => ({ role: "student", id });
const deadline = "2099-01-01T00:00:00.000Z";

function mount() {
  const grader = createOwnClassChoiceEvaluator(db, () => activeRecovery);
  runtime = openLearningRuntime({
    databasePath: kernelPath,
    choiceEvaluators: [
      {
        ...grader,
        evaluate(input) {
          checkEvaluatorScope(grader, input);
          const result = grader.evaluate(input);
          evaluated.set(
            input.activityId,
            (evaluated.get(input.activityId) ?? 0) + 1,
          );
          return result;
        },
      },
    ],
    verifyOriginal: (request) =>
      boundRequest(request, activeOriginals?.scope) &&
      activeOriginals.questions.some(
        (row) =>
          row.questionId === request.questionId &&
          row.questionVersion === request.questionVersion &&
          isDeepStrictEqual(row.original, request.original),
      ),
    authorizeConfirmationRecovery: (request) =>
      boundRequest(request, activeRecovery),
  });
  const options = {
    db,
    dataDir,
    isProduction: false,
    publicUrl: "http://localhost:8787",
    logger: pino({ enabled: false }),
  };
  hostApp = createApp(options);
  app = createTrialApp(
    options,
    startScored,
    (studentId, attemptId) => {
      const scope = scopeOf(db, studentId, attemptId);
      const view = runtime.read(principal(studentId), attemptId);
      return view.status === "completed"
        ? { ...view, ...publishedSummary(db, scope, new Date()) }
        : view;
    },
    createTrialChoiceDraftSaver(
      (...args) => runtime.saveChoiceDraft(...args),
      lookup,
      {
        isClosed: (actor, attemptId) =>
          runtime.read(actor, attemptId).status === "completed",
      },
    ),
    submitScored,
  );
}

function checkEvaluatorScope(grader, input) {
  if (rejectedEvaluatorInputs.length > 0) return;
  const invalid = {
    activity: { activityId: randomUUID() },
    step: { stepAttemptId: randomUUID() },
    slot: { slotId: "other-slot" },
    practice: { practice: { ...input.practice, id: randomUUID() } },
    practiceVersion: {
      practice: { ...input.practice, version: input.practice.version + 1 },
    },
    questionVersion: { questionVersion: input.questionVersion + 1 },
    acceptedChoice: { acceptedChoice: "other-key" },
    submittedChoice: { choice: "other-choice" },
  };
  const expected = { code: "CHOICE_EVALUATION_SCOPE_MISMATCH" };
  for (const [name, fields] of Object.entries(invalid)) {
    assert.throws(() => grader.evaluate({ ...input, ...fields }), expected);
    rejectedEvaluatorInputs.push(name);
  }
  const previous = activeRecovery;
  activeRecovery = {
    ...previous,
    questionRevisions: new Map([[input.questionId, randomUUID()]]),
  };
  try {
    assert.throws(() => grader.evaluate(input), expected);
    rejectedEvaluatorInputs.push("responseId");
  } finally {
    activeRecovery = previous;
  }
}

function boundRequest(request, scope) {
  return (
    scope !== undefined &&
    request.activityId === scope.attemptId &&
    request.stepAttemptId === scope.stepAttemptId &&
    request.studentId === scope.studentId &&
    request.operationId === scope.operationId &&
    (request.slotId === undefined || request.slotId === scope.slotId)
  );
}

function lookup(current, studentId, attemptId) {
  const attempt = requireUsableAttempt(current, studentId, attemptId);
  const stepAttemptId = bindings.get(attemptId)?.stepAttemptId;
  if (
    !stepAttemptId ||
    attempt.sourceType !== "assignment" ||
    !attempt.assignmentId
  ) {
    throw new HttpError(404, "ATTEMPT_NOT_FOUND", "作答记录不存在");
  }
  return { attempt, stepAttemptId };
}

function startScored(current, studentId, assignmentId) {
  const assignment = requireAssignmentVisible(current, studentId, assignmentId);
  const { input, revisions } = publicationForAssignment(
    current,
    assignment,
    studentId,
  );
  const { practice } = input;
  runtime.publish({
    ...input,
    practice: {
      ...practice,
      questions: practice.questions.map((question, index) => ({
        ...question,
        version: revisions[index].version,
      })),
      steps: practice.steps.map((step) => ({
        ...step,
        submit: {
          ...step.submit,
          slots: {
            answers: {
              ...step.submit.slots.answers,
              confirmFromDrafts: { allowUnanswered: true },
            },
          },
        },
      })),
      grading: {
        assessment: {
          ...practice.grading.assessment,
          evaluator: ownClassChoiceEvaluatorRef,
        },
      },
    },
  });
  const receipt = runtime.start(
    { role: "student", id: studentId },
    {
      protocolVersion: 1,
      operationId: `open:${assignmentId}`,
      practiceId: assignmentId,
      practiceVersion: 1,
    },
  );
  const draft = draftForAssignment(
    assignment,
    studentId,
    receipt.activityId,
    receipt.startedAt,
  );
  if (!bindings.has(receipt.activityId)) {
    projectTrialDraft(current, draft);
    bindings.set(receipt.activityId, receipt);
  }
  return attemptSummaryOf(draft);
}

function scopeOf(current, studentId, attemptId) {
  const { attempt, stepAttemptId } = lookup(current, studentId, attemptId);
  return {
    attemptId,
    studentId,
    stepAttemptId,
    assignmentId: attempt.assignmentId,
    practiceVersion: 1,
    slotId: "answers",
    operationId: `confirm:${attemptId}`,
    questionRevisions: new Map(
      attemptResponseRows(current, attemptId).map((row) => [
        row.questionId,
        row.id,
      ]),
    ),
  };
}

function recover(scope) {
  activeRecovery = scope;
  try {
    return runtime.recoverChoiceConfirmation(
      principal(scope.studentId),
      scope.attemptId,
      {
        protocolVersion: 1,
        stepAttemptId: scope.stepAttemptId,
        operationId: scope.operationId,
      },
    );
  } finally {
    activeRecovery = undefined;
  }
}

function publishedSummary(current, scope, now, confirmed) {
  const release = answerReleaseProjection(
    requireAssignmentRow(current, scope.assignmentId),
    now,
  );
  if (!release.answersReleased) return release;
  const recovered = confirmed ?? recover(scope);
  const verdicts = new Map(
    recovered.evaluation.questions.map(({ questionId, correct }) => [
      questionId,
      correct,
    ]),
  );
  const rows = recovered.confirmation.questions.map(
    ({ questionId, choice }) => ({
      hasSnapshot: true,
      answerJson: null,
      submittedAt: recovered.receipt.confirmedAt,
      autoCorrect: verdicts.get(questionId),
      finalCorrect: verdicts.get(questionId),
      gradingPolicy: "auto",
      teacherMark: null,
      selfReviewVerdict: null,
      selfReviewAt: null,
      selfReviewRevision: 0,
      answered: choice !== null,
    }),
  );
  const scoreAuto = scoreAutoOf(rows);
  const summary = {
    ...scoreSummaryCoreOf(rows, { finalized: true }),
    scoreFinal: scoreAuto,
  };
  return { ...release, scoreAuto, summary };
}

function submitScored(current, studentId, attemptId, now, request) {
  const scope = scopeOf(current, studentId, attemptId);
  if (runtime.read(principal(studentId), attemptId).status === "completed") {
    projectConfirmedChoiceEvidence(current, scope, recover);
    throw new HttpError(409, "ALREADY_SUBMITTED", "这份练习已交卷");
  }
  const questions = prepareChoiceOriginals(current, dataDir, scope, request);
  activeOriginals = { scope, questions };
  try {
    runtime.confirmChoices(principal(studentId), attemptId, {
      protocolVersion: 1,
      stepAttemptId: scope.stepAttemptId,
      slotId: scope.slotId,
      operationId: scope.operationId,
      questions,
    });
  } finally {
    activeOriginals = undefined;
  }
  let confirmed;
  const receipt = projectConfirmedChoiceEvidence(current, scope, (bound) => {
    confirmed = recover(bound);
    return confirmed;
  });
  return { receipt, ...publishedSummary(current, scope, now, confirmed) };
}

function scanPublic(body) {
  assert.doesNotMatch(
    JSON.stringify(body),
    /合成详解[甲乙]|"(?:acceptedChoice|acceptedChoices|scoringKey|scoringKeys|grading|evaluation|assessment|autoCorrect|finalCorrect|solutionMd)"\s*:/u,
  );
  if (body.data?.answersReleased !== true) {
    assert.doesNotMatch(
      JSON.stringify(body),
      /"(?:correct|correctCount|scoreAuto|scoreFinal|summary)"\s*:/u,
    );
  }
}

async function call(path, cookie, method, body, expectedStatus) {
  const response = await app.request(path, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(payload));
  scanPublic(payload);
  if (expectedStatus >= 400) {
    assert.equal(Object.hasOwn(payload, "data"), false);
    assert.equal(Object.hasOwn(payload, "_current"), false);
  }
  return payload;
}

function kernelFacts() {
  const inspection = new DatabaseSync(kernelPath, { readOnly: true });
  try {
    return Object.fromEntries(
      [
        "activities",
        "submissions",
        "completions",
        "evaluation_tasks",
        "automatic_verdicts",
      ].map((table) => [
        table,
        inspection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
      ]),
    );
  } finally {
    inspection.close();
  }
}

function assertLegacyUnwritten() {
  assert.deepEqual(attemptFacts(db), {
    attempts: 4,
    responses: 8,
    scores: 0,
    evidence: 8,
    settlements: 0,
  });
  const rows = db.$client
    .prepare(`SELECT
    (SELECT COUNT(*) FROM attempts WHERE status <> 'draft' OR submitted_at IS NOT NULL) AS settled,
    (SELECT COUNT(*) FROM responses WHERE answer_json IS NOT NULL OR auto_correct IS NOT NULL OR final_correct IS NOT NULL OR answer_revision <> 0 OR change_count <> 0) AS answered`)
    .get();
  assert.deepEqual(rows, { settled: 0, answered: 0 });
}

async function originalBytes(path, cookie, status = 200) {
  const response = await app.request(path, { headers: { cookie } });
  assert.equal(response.status, status);
  return Buffer.from(await response.arrayBuffer());
}

async function writeOriginal(attemptId, cookie, questionId) {
  const first = await putNoteReceipt(app, cookie, attemptId, questionId, 1);
  const second = await putNoteReceipt(app, cookie, attemptId, questionId, 2, {
    baseRevision: first.revision,
  });
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.notEqual(first.versionId, second.versionId);
  const png = makeNotePng();
  const image = await postNoteImage(
    app,
    "student",
    second.versionId,
    png,
    cookie,
  );
  assert.equal(image.status, 200);
  const {
    data: { imageId },
  } = await image.json();
  const documentPath = `/api/student/note-versions/${second.versionId}/document`;
  const imagePath = `/api/student/note-versions/${second.versionId}/images/${imageId}.png`;
  const document = await originalBytes(documentPath, cookie);
  assert.deepEqual(await originalBytes(imagePath, cookie), Buffer.from(png));
  return { second, document, documentPath, imagePath, png: Buffer.from(png) };
}

function assertPublication(data, scenario, released) {
  assert.equal(data.answersReleased, released);
  if (!released) {
    assert.equal(Object.hasOwn(data, "scoreAuto"), false);
    assert.equal(Object.hasOwn(data, "summary"), false);
    return;
  }
  const answered = scenario.answers.filter((answer) => answer !== null).length;
  const correct = scenario.graded.filter(Boolean).length;
  assert.equal(data.scoreAuto, scenario.score);
  assert.deepEqual(data.summary, {
    total: 2,
    answered,
    correct,
    wrong: answered - correct,
    pending: 0,
    unanswered: 2 - answered,
    autoGradable: 2,
    pendingCount: 0,
    scoreFinal: scenario.score,
  });
}

try {
  mount();
  const world = await setupAssignment(app, deadline);
  const frozen = JSON.parse(
    readFileSync(
      new URL("./fixtures/P0-冻结单选.json", import.meta.url),
      "utf8",
    ),
  );
  const { questions, cases } = frozen;
  const remainingDeadline = allWithheld ? deadline : undefined;
  const assignments = [
    await assignFixture(
      app,
      world.teacher,
      world.unitId,
      world.otherStudentId,
      remainingDeadline,
    ),
    world.assignmentId,
    await assignFixture(
      app,
      world.teacher,
      world.unitId,
      world.studentId,
      remainingDeadline,
    ),
    await assignFixture(
      app,
      world.teacher,
      world.unitId,
      world.studentId,
      remainingDeadline,
    ),
  ];
  const scenarios = [
    {
      name: "全对",
      answers: questions.map(({ answers }) => answers),
      graded: [true, true],
      score: 100,
    },
    {
      name: "都有作答",
      answers: cases.complete,
      graded: [true, false],
      score: 50,
    },
    { name: "全空", answers: cases.empty, graded: [false, false], score: 0 },
    {
      name: "部分作答",
      answers: cases.partial,
      graded: [true, false],
      score: 50,
    },
  ];
  const outcomes = [];
  for (const [index, scenario] of scenarios.entries()) {
    const student = index === 0 ? world.otherStudentId : world.studentId;
    const cookie = index === 0 ? world.otherCookie : world.ownerCookie;
    const other = index === 0 ? world.ownerCookie : world.otherCookie;
    const assignmentId = assignments[index];
    const released = !allWithheld && index !== 1;
    const opened = await postAssignment(app, assignmentId, cookie);
    assert.equal(opened.status, 200, await opened.clone().text());
    const { id, frozenAt } = attemptStartOkSchema.parse(
      await opened.json(),
    ).data;
    const url = `/api/student/attempts/${id}`;
    const revisions = await fetchSubmitRevisions(hostApp, cookie, id);
    const before = await call(url, cookie, "GET", undefined, 200);
    assert.deepEqual(
      before.data.inputs.questions.questions,
      questions.map(({ id, version, stemMd, options }) => ({
        id,
        version,
        prompt: stemMd,
        options: Object.fromEntries(
          options.map((value, i) => [String(i), value]),
        ),
      })),
    );
    assert.deepEqual(
      revisions.map(({ questionId, expectedAnswerRevision }) => [
        questionId,
        expectedAnswerRevision,
      ]),
      questions.map(({ id }) => [id, 0]),
    );
    for (const [questionIndex, revision] of revisions.entries()) {
      const answer = scenario.answers[questionIndex];
      if (answer === null) continue;
      const request = {
        answer,
        questionRevisionId: revision.questionRevisionId,
        expectedFrozenAt: frozenAt,
      };
      if (index === 1 && questionIndex === 0) {
        const initial = await call(
          `${url}/answers/${revision.questionId}`,
          cookie,
          "PUT",
          {
            ...request,
            answer: { kind: "choice", index: 0 },
            mutationId: randomUUID(),
            baseRevision: 0,
          },
          200,
        );
        assert.equal(initial.data.revision, 1);
        revision.expectedAnswerRevision = 1;
      }
      const body =
        index === 0
          ? { answer }
          : {
              ...request,
              mutationId: randomUUID(),
              baseRevision: revision.expectedAnswerRevision,
            };
      const saved = await call(
        `${url}/answers/${revision.questionId}`,
        cookie,
        "PUT",
        body,
        200,
      );
      assert.equal(saved.data.revision, revision.expectedAnswerRevision + 1);
      revision.expectedAnswerRevision = saved.data.revision;
    }
    const original =
      index === 0
        ? await writeOriginal(id, cookie, questions[0].id)
        : undefined;
    const wire = {
      revisions,
      evidence: revisions.map(({ questionId }) => ({
        questionId,
        ...(original && questionId === questions[0].id
          ? {
              state: "frozen",
              versionId: original.second.versionId,
              revision: original.second.revision,
            }
          : { state: "none" }),
      })),
    };
    const denied = await call(`${url}/submit`, other, "POST", wire, 403);
    assert.equal(denied.error, "FORBIDDEN");
    if (index === 1) {
      const stale = {
        ...wire,
        revisions: revisions.map((row, i) =>
          i
            ? row
            : { ...row, questionRevisionId: revisions[1].questionRevisionId },
        ),
      };
      const invalid = await call(`${url}/submit`, cookie, "POST", stale, 409);
      assert.equal(invalid.error, "QUESTION_REVISION_STALE");
    }
    const result = await call(`${url}/submit`, cookie, "POST", wire, 200);
    assertPublication(result.data, scenario, released);
    const scope = scopeOf(db, student, id);
    assert.throws(
      () =>
        runtime.recoverChoiceConfirmation(principal(student), id, {
          protocolVersion: 1,
          stepAttemptId: scope.stepAttemptId,
          operationId: scope.operationId,
        }),
      { status: 403, code: "FORBIDDEN" },
    );
    const recovered = recover(scope);
    assert.deepEqual(result.data.receipt, recovered.receipt);
    if (original) {
      assert.deepEqual(recovered.confirmation.questions[0].original, {
        state: "frozen",
        documentId: original.second.noteId,
        versionId: original.second.versionId,
        sha256: original.second.hash,
      });
      assert.deepEqual(
        db.$client
          .prepare(
            "SELECT state, version_id FROM submission_evidence WHERE attempt_id = ? AND question_id = ?",
          )
          .get(id, questions[0].id),
        {
          state: "frozen",
          version_id: original.second.versionId,
        },
      );
      assert.deepEqual(
        await originalBytes(original.documentPath, cookie),
        original.document,
      );
      assert.equal(
        (
          await app.request(original.documentPath, {
            headers: { cookie: other },
          })
        ).status,
        403,
      );
    }
    const choices = recovered.confirmation.questions.map(
      ({ choice, revision, questionId, questionVersion }) => [
        questionId,
        questionVersion,
        choice,
        revision,
      ],
    );
    assert.deepEqual(
      choices,
      questions.map(({ id: qid, version }, i) => [
        qid,
        version,
        scenario.answers[i] === null ? null : String(scenario.answers[i].index),
        revisions[i].expectedAnswerRevision,
      ]),
    );
    assert.equal(recovered.evaluation.questionCount, 2);
    assert.equal(
      recovered.evaluation.correctCount,
      scenario.graded.filter(Boolean).length,
    );
    assert.deepEqual(
      recovered.evaluation.questions.map(({ correct }) => correct),
      scenario.graded,
    );
    assert.equal(
      scoreAutoOf(
        recovered.evaluation.questions.map(({ correct }) => ({
          autoCorrect: correct,
        })),
      ),
      scenario.score,
    );
    const beforeReplay = kernelFacts();
    const repeat = await call(`${url}/submit`, cookie, "POST", wire, 409);
    assert.equal(repeat.error, "ALREADY_SUBMITTED");
    assert.deepEqual(kernelFacts(), beforeReplay);
    assert.equal(evaluated.get(id), 2);
    const detail = await call(url, cookie, "GET", undefined, 200);
    assert.equal(detail.data.status, "completed");
    assertPublication(detail.data, scenario, released);
    assert.equal(
      (await call(url, other, "GET", undefined, 403)).error,
      "FORBIDDEN",
    );
    outcomes.push({
      assignmentId,
      id,
      student,
      cookie,
      other,
      wire,
      scenario,
      released,
      releasedAtSubmit: released,
      original,
      name: scenario.name,
      score: scenario.score,
      choices,
      receipt: recovered.receipt,
      evaluation: recovered.evaluation,
    });
  }

  const once = kernelFacts();
  assert.deepEqual(once, {
    activities: 4,
    submissions: 4,
    completions: 4,
    evaluation_tasks: 4,
    automatic_verdicts: 8,
  });
  assertLegacyUnwritten();
  if (!allWithheld) {
    const row = outcomes[1];
    const changed = await call(
      `/api/teacher/assignments/${row.assignmentId}`,
      world.teacher,
      "PATCH",
      {
        dueAt: "2020-01-01T00:00:00.000Z",
      },
      200,
    );
    assert.equal(changed.data.answerRelease, "after_due");
    const result = await call(
      `/api/student/attempts/${row.id}`,
      row.cookie,
      "GET",
      undefined,
      200,
    );
    assertPublication(result.data, row.scenario, true);
    assert.equal(
      (
        await call(
          `/api/student/attempts/${row.id}`,
          row.other,
          "GET",
          undefined,
          403,
        )
      ).error,
      "FORBIDDEN",
    );
    row.released = true;
  }
  runtime.close();
  db.$client.close();
  db = createDb(productPath);
  mount();
  for (const row of outcomes) {
    const response = await postAssignment(app, row.assignmentId, row.cookie);
    assert.equal(response.status, 200);
    assert.equal(
      attemptStartOkSchema.parse(await response.json()).data.id,
      row.id,
    );
    const replay = await call(
      `/api/student/attempts/${row.id}/submit`,
      row.cookie,
      "POST",
      row.wire,
      409,
    );
    assert.equal(replay.error, "ALREADY_SUBMITTED");
    const recovered = recover(scopeOf(db, row.student, row.id));
    assert.deepEqual(recovered.receipt, row.receipt);
    assert.deepEqual(recovered.evaluation, row.evaluation);
    const view = await call(
      `/api/student/attempts/${row.id}`,
      row.cookie,
      "GET",
      undefined,
      200,
    );
    assertPublication(view.data, row.scenario, row.released);
    if (row.original) {
      assert.deepEqual(
        await originalBytes(row.original.documentPath, row.cookie),
        row.original.document,
      );
      assert.deepEqual(
        await originalBytes(row.original.imagePath, row.cookie),
        row.original.png,
      );
      await originalBytes(row.original.imagePath, row.other, 403);
    }
    assert.equal(evaluated.get(row.id), 2);
  }
  assert.deepEqual(kernelFacts(), once);
  assertLegacyUnwritten();
  console.log(
    JSON.stringify(
      {
        sha,
        entry,
        allWithheld,
        productPath,
        kernelPath,
        outcomes: outcomes.map(
          ({
            name,
            score,
            choices,
            receipt,
            evaluation,
            released,
            releasedAtSubmit,
            original,
          }) => ({
            name,
            score,
            choices,
            receipt,
            evaluation,
            releasedAtSubmit,
            released,
            ...(original
              ? {
                  original: {
                    versionId: original.second.versionId,
                    revision: original.second.revision,
                    documentBytes: original.document.length,
                    imageBytes: original.png.length,
                  },
                }
              : {}),
          }),
        ),
        kernel: once,
        product: attemptFacts(db),
        closedReplay: 409,
        otherStudent: 403,
        withholdingChecked: true,
        rejectedEvaluatorInputs,
      },
      null,
      2,
    ),
  );
} finally {
  runtime?.close();
  db.$client.close();
}
