import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { attemptResultOkSchema, attemptStartOkSchema } from "@tutor/contract";
import { openLearningRuntime } from "learning-kernel";
import { createDb } from "../../db/client.ts";
import {
  makeNotePng,
  postNoteImage,
  putNoteReceipt,
} from "../note-fixtures.ts";
import { fetchSubmitRevisions } from "../submit-revisions.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "./product-fixture.ts";
import { createRealServiceFixture } from "./real-service-fixture.mjs";

const service = await createRealServiceFixture();
const { app, dataDir, boot, stop } = service;
const kernelPath = join(dataDir, "learning-kernel.sqlite");
const productPath = join(dataDir, "tutor.db");
function productRead(read) {
  const db = createDb(productPath);
  try {
    return read(db.$client);
  } finally {
    db.$client.close();
  }
}
function inspect(attemptId) {
  return productRead((db) => ({
    prepared: db
      .prepare(
        "SELECT operation_id, step_attempt_id FROM kernel_attempt_confirmations WHERE attempt_id=?",
      )
      .get(attemptId),
    lifecycle: db
      .prepare(
        "SELECT status, submitted_at, score_auto, score_final FROM attempts WHERE id=?",
      )
      .get(attemptId),
    originals: db
      .prepare(
        "SELECT state, version_id, pending_version_id FROM attempt_original_reservations WHERE attempt_id=?",
      )
      .all(attemptId),
    evidence: db
      .prepare(
        "SELECT question_id, state, version_id FROM submission_evidence WHERE attempt_id=? ORDER BY question_id",
      )
      .all(attemptId),
    oldAnswers: db
      .prepare(
        "SELECT COUNT(*) AS n FROM responses WHERE attempt_id=? AND (answer_json IS NOT NULL OR auto_correct IS NOT NULL OR final_correct IS NOT NULL)",
      )
      .get(attemptId).n,
  }));
}
async function expectStatus(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  if (code !== undefined) {
    const body = await response.json();
    assert.equal(body.error, code);
    assert.ok(!Object.hasOwn(body, "data"));
  }
}
function recover(attemptId, studentId, prepared) {
  const runtime = openLearningRuntime({
    databasePath: kernelPath,
    authorizeConfirmationRecovery: (request) =>
      request.activityId === attemptId &&
      request.studentId === studentId &&
      request.stepAttemptId === prepared.step_attempt_id &&
      request.operationId === prepared.operation_id,
  });
  try {
    return runtime.recoverChoiceConfirmation(
      { role: "student", id: studentId },
      attemptId,
      {
        protocolVersion: 1,
        stepAttemptId: prepared.step_attempt_id,
        operationId: prepared.operation_id,
      },
    );
  } finally {
    runtime.close();
  }
}

try {
  const firstPid = await boot(true);
  const world = await setupAssignment(app);
  const assignmentId = await assignKernelFixture(app, world);
  const start = await postAssignment(app, assignmentId, world.ownerCookie);
  await expectStatus(start, 200);
  const { id, frozenAt } = attemptStartOkSchema.parse(await start.json()).data;
  const root = `/api/student/attempts/${id}`;
  const [q1, q2] = await fetchSubmitRevisions(app, world.ownerCookie, id);
  const call = (path, cookie = world.ownerCookie, method = "GET", payload) =>
    app.request(path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  for (const [question, index] of [
    [q1, 1],
    [q2, 2],
  ]) {
    await expectStatus(
      await call(
        `${root}/answers/${question.questionId}`,
        world.ownerCookie,
        "PUT",
        {
          answer: { kind: "choice", index },
          mutationId: randomUUID(),
          baseRevision: 0,
          expectedFrozenAt: frozenAt,
          questionRevisionId: question.questionRevisionId,
        },
      ),
      200,
    );
  }

  const v1 = await putNoteReceipt(app, world.ownerCookie, id, q1.questionId, 1);
  const v2 = await putNoteReceipt(
    app,
    world.ownerCookie,
    id,
    q1.questionId,
    2,
    { baseRevision: 1 },
  );
  const png = Buffer.from(makeNotePng());
  const attached = await postNoteImage(
    app,
    "student",
    v2.versionId,
    png,
    world.ownerCookie,
  );
  await expectStatus(attached, 200);
  const {
    data: { imageId },
  } = await attached.json();
  const documentPath = `/api/student/note-versions/${v2.versionId}/document`;
  const imagePath = `/api/student/note-versions/${v2.versionId}/images/${imageId}.png`;
  const bytes = async (path) => {
    const response = await call(path);
    await expectStatus(response, 200);
    return Buffer.from(await response.arrayBuffer());
  };
  const document = await bytes(documentPath);
  const body = {
    revisions: await fetchSubmitRevisions(app, world.ownerCookie, id),
    evidence: [
      {
        questionId: q1.questionId,
        state: "frozen",
        versionId: v2.versionId,
        revision: v2.revision,
      },
      { questionId: q2.questionId, state: "none" },
    ],
  };
  const submit = (payload = body, cookie = world.ownerCookie) =>
    call(`${root}/submit`, cookie, "POST", payload);

  productRead((db) =>
    db.exec(`
    CREATE TRIGGER fail_confirmation_projection
    BEFORE UPDATE OF status, submitted_at ON attempts
    WHEN NEW.status <> OLD.status
    BEGIN SELECT RAISE(ABORT, 'forced P3 confirmation projection interruption'); END
  `),
  );
  const first = await submit();
  await expectStatus(first, 500);
  const held = inspect(id);
  assert.equal(held.lifecycle.status, "draft");
  assert.equal(held.lifecycle.submitted_at, null);
  assert.equal(held.oldAnswers, 0);
  assert.deepEqual(held.evidence, []);
  assert.deepEqual(held.originals, [
    {
      state: "pending",
      version_id: v2.versionId,
      pending_version_id: v2.versionId,
    },
  ]);
  assert.ok(held.prepared);
  const durable = recover(id, world.studentId, held.prepared);
  assert.equal(
    durable.confirmation.questions[0].original.versionId,
    v2.versionId,
  );
  assert.equal(durable.evaluation.correctCount, 2);
  const different = {
    ...body,
    evidence: [
      { questionId: q1.questionId, state: "missing" },
      { questionId: q2.questionId, state: "missing" },
    ],
  };
  await expectStatus(await submit(different), 500);
  assert.deepEqual(inspect(id), held);
  assert.deepEqual(recover(id, world.studentId, held.prepared), durable);
  productRead((db) => db.exec("DROP TRIGGER fail_confirmation_projection"));

  await stop();
  const restartedPid = await boot(false);
  assert.notEqual(firstPid, restartedPid);
  await expectStatus(await call(root, world.otherCookie), 403, "FORBIDDEN");
  await expectStatus(
    await submit(different, world.otherCookie),
    403,
    "FORBIDDEN",
  );
  const hiddenKernel = `${kernelPath}.held`;
  renameSync(kernelPath, hiddenKernel);
  try {
    await expectStatus(await call(root), 503, "KERNEL_ATTEMPT_UNAVAILABLE");
    await expectStatus(await submit(), 503, "KERNEL_ATTEMPT_UNAVAILABLE");
    assert.deepEqual(inspect(id), held);
    assert.deepEqual(await bytes(documentPath), document);
  } finally {
    renameSync(hiddenKernel, kernelPath);
  }

  const reopened = await call(root);
  await expectStatus(reopened, 200);
  const detail = attemptResultOkSchema.parse(await reopened.json()).data;
  assert.equal(detail.attempt.id, id);
  assert.equal(detail.attempt.submittedAt, durable.receipt.confirmedAt);
  assert.equal(detail.attempt.scoreAuto, 100);
  assert.deepEqual(
    detail.units.flatMap(({ questions }) =>
      questions.map(({ questionRevisionId }) => questionRevisionId),
    ),
    [q1.questionRevisionId, q2.questionRevisionId],
  );
  const projected = inspect(id);
  assert.deepEqual(projected.prepared, held.prepared);
  assert.deepEqual(projected.lifecycle, {
    status: "graded",
    submitted_at: durable.receipt.confirmedAt,
    score_auto: null,
    score_final: null,
  });
  assert.deepEqual(projected.originals, [
    { state: "projected", version_id: v2.versionId, pending_version_id: null },
  ]);
  assert.deepEqual(projected.evidence, [
    { question_id: q1.questionId, state: "frozen", version_id: v2.versionId },
    { question_id: q2.questionId, state: "none", version_id: null },
  ]);
  assert.equal(projected.oldAnswers, 0);
  await expectStatus(await submit(), 409, "ALREADY_SUBMITTED");
  await expectStatus(await submit(different), 409, "ALREADY_SUBMITTED");
  assert.deepEqual(recover(id, world.studentId, projected.prepared), durable);
  assert.deepEqual(await bytes(documentPath), document);
  assert.deepEqual(await bytes(imagePath), png);
  using kernel = new DatabaseSync(kernelPath, { readOnly: true });
  const counts = kernel
    .prepare(`SELECT
    (SELECT COUNT(*) FROM submissions s JOIN step_attempts a ON a.id=s.step_attempt_id WHERE a.activity_id=?) AS submissions,
    (SELECT COUNT(*) FROM automatic_verdicts WHERE submission_id=?) AS verdicts,
    (SELECT COUNT(*) FROM completions WHERE activity_id=?) AS completions`)
    .get(id, durable.receipt.id, id);
  assert.deepEqual(
    { ...counts },
    { submissions: 1, verdicts: 2, completions: 1 },
  );
  const secondOpen = await postAssignment(app, assignmentId, world.otherCookie);
  await expectStatus(secondOpen, 200);
  const missed = attemptStartOkSchema.parse(await secondOpen.json()).data;
  const missedRoot = `/api/student/attempts/${missed.id}`;
  const priorRevisions = await fetchSubmitRevisions(
    app,
    world.otherCookie,
    missed.id,
  );
  const [firstMissed] = priorRevisions;
  productRead((db) =>
    db.exec(`
    CREATE TRIGGER fail_first_answer_activity
    BEFORE UPDATE OF activated_at, last_activity_at ON attempts
    BEGIN SELECT RAISE(ABORT, 'forced pre-confirmation draft activity interruption'); END
  `),
  );
  const missedPut = await call(
    `${missedRoot}/answers/${firstMissed.questionId}`,
    world.otherCookie,
    "PUT",
    {
      answer: { kind: "choice", index: 1 },
      mutationId: randomUUID(),
      baseRevision: 0,
      expectedFrozenAt: missed.frozenAt,
      questionRevisionId: firstMissed.questionRevisionId,
    },
  );
  await expectStatus(missedPut, 500);
  const activityFields =
    "SELECT activated_at, last_activity_at FROM attempts WHERE id=?";
  assert.deepEqual(
    productRead((db) => db.prepare(activityFields).get(missed.id)),
    {
      activated_at: null,
      last_activity_at: null,
    },
  );
  const beforeConfirmKernel = openLearningRuntime({ databasePath: kernelPath });
  let actualFirst;
  try {
    const actor = { role: "student", id: world.otherStudentId };
    const view = beforeConfirmKernel.read(actor, missed.id);
    assert.deepEqual(
      view.choiceDrafts.map(({ questionId, revision }) => [
        questionId,
        revision,
      ]),
      [[firstMissed.questionId, 1]],
    );
    actualFirst = beforeConfirmKernel.readChoiceDraftActivity(
      actor,
      missed.id,
    )?.firstChangedAt;
    assert.ok(actualFirst);
  } finally {
    beforeConfirmKernel.close();
  }
  productRead((db) => db.exec("DROP TRIGGER fail_first_answer_activity"));
  await stop();
  const directSubmitPid = await boot(false);
  assert.notEqual(directSubmitPid, restartedPid);
  // 重启后不进详情。仅用先前的冻结凭据和内核已经落库的修订直接交卷。
  const direct = await call(`${missedRoot}/submit`, world.otherCookie, "POST", {
    revisions: priorRevisions.map((item, index) =>
      index === 0 ? { ...item, expectedAnswerRevision: 1 } : item,
    ),
  });
  await expectStatus(direct, 200);
  const directlyConfirmed = attemptResultOkSchema.parse(
    await direct.json(),
  ).data;
  assert.equal(directlyConfirmed.attempt.scoreAuto, 50);
  assert.equal(directlyConfirmed.attempt.activatedAt, actualFirst);
  assert.ok(directlyConfirmed.attempt.submittedAt > actualFirst);
  assert.deepEqual(
    productRead((db) => db.prepare(activityFields).get(missed.id)),
    {
      activated_at: actualFirst,
      last_activity_at: directlyConfirmed.attempt.submittedAt,
    },
  );
  console.log(
    JSON.stringify(
      {
        firstPid,
        restartedPid,
        interrupted: first.status,
        score: detail.attempt.scoreAuto,
        notes: {
          first: v1.revision,
          held: v2.revision,
          documentBytes: document.length,
          pngBytes: png.length,
        },
        receipt: durable.receipt,
        counts,
        directlyConfirmedAfterDraftInterruption: {
          pid: directSubmitPid,
          firstChangedAt: actualFirst,
          submittedAt: directlyConfirmed.attempt.submittedAt,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await service.close();
}
