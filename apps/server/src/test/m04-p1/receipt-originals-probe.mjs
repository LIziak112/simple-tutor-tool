import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import {
  attemptStartOkSchema,
  attemptSubmitRequestSchema,
} from "@tutor/contract";
import pino from "pino";
import { createDb } from "../../db/client.ts";
import { createTestDb, createTestDir } from "../../db/test-utils.ts";
import {
  requireAssignmentVisible,
  requireUsableAttempt,
} from "../../services/attempt-access.ts";
import {
  prepareChoiceOriginals,
  projectConfirmedChoiceEvidence,
} from "../../services/attempt-choice-evidence.ts";
import { attemptSummaryOf } from "../../services/attempt-summary.ts";
import {
  gcNoteVersions,
  NOTE_GC_SAFETY_WINDOW_MS,
} from "../../services/note-gc.ts";
import {
  makeNotePng,
  postNoteImage,
  putNoteReceipt,
} from "../note-fixtures.ts";
import { fetchSubmitRevisions } from "../submit-revisions.ts";
import { createTrialApp } from "./assembly.ts";
import {
  attemptFacts,
  loginAssignmentOwner,
  postAssignment,
  setupAssignment,
} from "./product-fixture.ts";
import {
  draftForAssignment,
  projectTrialDraft,
  publicationForAssignment,
} from "./publication.ts";

const archiveHash =
  "62221d38e30bff8c64dccfca3e9c8075dd98a57a824984daa8fb07d16084063e";
assert.ok(process.argv[2], "须提供隔离的 K4 试装目录");
const preview = resolve(process.argv[2]);
const hash = (data) => createHash("sha256").update(data).digest("hex");
assert.equal(
  hash(readFileSync(join(preview, "learning-kernel-0.1.0.tgz"))),
  archiveHash,
);
const previewRequire = createRequire(join(preview, "package.json"));
const kernelEntry = previewRequire.resolve("learning-kernel");
const { openLearningRuntime } = await import(pathToFileURL(kernelEntry).href);

const firstId = "m04-p0-q1";
const secondId = "m04-p0-q2";
const compact = (rows) => rows.map((row) => ({ ...row }));
function confirmablePractice(publication) {
  const { practice } = publication.input;
  return {
    ...practice,
    questions: practice.questions.map((question, index) => ({
      ...question,
      version: publication.revisions[index].version,
    })),
    steps: practice.steps.map((step) => ({
      ...step,
      submit: {
        ...step.submit,
        slots: {
          ...step.submit.slots,
          answers: {
            ...step.submit.slots.answers,
            confirmFromDrafts: { allowUnanswered: true },
          },
        },
      },
    })),
  };
}
function makeTrial(withScoring = false) {
  const dataDir = createTestDir();
  const productPath = join(dataDir, "ownclass.sqlite");
  const kernelPath = join(dataDir, "learning-kernel.sqlite");
  const template = createTestDb();
  writeFileSync(productPath, template.$client.serialize());
  template.$client.close();
  let db = createDb(productPath);
  let runtime;
  let app;
  let opened;
  let scoredPublicationError;
  let expectOriginal;
  let activeRecovery;
  function mount() {
    runtime = openLearningRuntime({
      databasePath: kernelPath,
      verifyOriginal: (scope) => expectOriginal?.(scope) === true,
      authorizeConfirmationRecovery: (scope) =>
        activeRecovery !== undefined &&
        scope.activityId === activeRecovery.attemptId &&
        scope.studentId === activeRecovery.studentId &&
        scope.operationId === activeRecovery.operationId &&
        scope.stepAttemptId === activeRecovery.stepAttemptId,
    });
    app = createTrialApp(
      {
        db,
        dataDir,
        logger: pino({ enabled: false }),
        publicUrl: "http://localhost:8787",
      },
      (productDb, studentId, assignmentId) => {
        const assignment = requireAssignmentVisible(
          productDb,
          studentId,
          assignmentId,
        );
        const publication = publicationForAssignment(
          productDb,
          assignment,
          studentId,
        );
        assert.deepEqual(publication.revisions, [
          { id: firstId, version: 1 },
          { id: secondId, version: 1 },
        ]);
        const practice = confirmablePractice(publication);
        if (withScoring) {
          try {
            runtime.publish({ ...publication.input, practice });
          } catch (error) {
            scoredPublicationError = error;
          }
          assert.ok(
            scoredPublicationError,
            "启用统一确认的 P0 评分声明应被拒绝",
          );
          runtime.publish(publication.input);
        } else {
          const { grading, ...withoutGrading } = practice;
          assert.ok(grading);
          runtime.publish({ practice: withoutGrading });
        }
        opened = runtime.start(
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
          opened.activityId,
          opened.startedAt,
        );
        projectTrialDraft(productDb, draft);
        return attemptSummaryOf(draft);
      },
    );
  }
  mount();
  return {
    dataDir,
    productPath,
    kernelPath,
    get db() {
      return db;
    },
    get app() {
      return app;
    },
    get runtime() {
      return runtime;
    },
    get opened() {
      return opened;
    },
    get scoredPublicationError() {
      return scoredPublicationError;
    },
    verifyWith(verify) {
      expectOriginal = verify;
    },
    recover(scope) {
      requireUsableAttempt(db, scope.studentId, scope.attemptId);
      activeRecovery = scope;
      try {
        return runtime.recoverChoiceConfirmation(
          { role: "student", id: scope.studentId },
          scope.attemptId,
          {
            protocolVersion: 1,
            operationId: scope.operationId,
            stepAttemptId: scope.stepAttemptId,
          },
        );
      } finally {
        activeRecovery = undefined;
      }
    },
    reopen() {
      runtime.close();
      db.$client.close();
      expectOriginal = undefined;
      activeRecovery = undefined;
      db = createDb(productPath);
      mount();
    },
    close() {
      runtime.close();
      db.$client.close();
    },
  };
}

function evidence(trial, attemptId) {
  return compact(
    trial.db.$client
      .prepare(
        "SELECT id, question_id, state, version_id, recorded_at FROM submission_evidence WHERE attempt_id=? ORDER BY question_id",
      )
      .all(attemptId),
  );
}

function kernelFacts(trial) {
  const sqlite = new DatabaseSync(trial.kernelPath, { readOnly: true });
  try {
    return Object.fromEntries(
      [
        "practices",
        "scoring_keys",
        "activities",
        "submissions",
        "automatic_verdicts",
        "completions",
      ].map((table) => [
        table,
        sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
      ]),
    );
  } finally {
    sqlite.close();
  }
}

async function open(trial) {
  const world = await setupAssignment(trial.app);
  const response = await postAssignment(
    trial.app,
    world.assignmentId,
    world.ownerCookie,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const product = attemptStartOkSchema.parse(await response.json()).data;
  const { activityId, stepAttemptId } = trial.opened;
  assert.equal(product.id, activityId);
  return {
    ...world,
    scope: {
      attemptId: activityId,
      studentId: world.studentId,
      stepAttemptId,
      operationId: randomUUID(),
      practiceVersion: 1,
    },
    principal: { role: "student", id: world.studentId },
  };
}

async function bytes(trial, world, url, type) {
  const response = await trial.app.request(url, {
    headers: { cookie: world.ownerCookie },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), type);
  return Buffer.from(await response.arrayBuffer());
}

async function scoredRed() {
  const trial = makeTrial(true);
  try {
    const world = await open(trial);
    const { scope } = world;
    trial.verifyWith(
      ({ questionId, original }) =>
        [firstId, secondId].includes(questionId) && original.state === "none",
    );
    let rejected;
    try {
      trial.runtime.confirmChoices(world.principal, scope.attemptId, {
        protocolVersion: 1,
        stepAttemptId: scope.stepAttemptId,
        operationId: scope.operationId,
        slotId: "answers",
        questions: [
          {
            questionId: firstId,
            questionVersion: 1,
            revision: 0,
            original: { state: "none" },
          },
          {
            questionId: secondId,
            questionVersion: 1,
            revision: 0,
            original: { state: "none" },
          },
        ],
      });
    } catch (error) {
      rejected = error;
    }
    assert.equal(rejected?.code, "INVALID_SLOT");
    assert.equal(rejected?.status, 422);
    assert.deepEqual(trial.scoredPublicationError.issues, [
      {
        code: "custom",
        path: ["practice", "steps", 0, "submit", "slots"],
        message: "草稿确认槽须与内置评分分开声明",
      },
    ]);
    assert.equal(kernelFacts(trial).submissions, 0);
    assert.equal(kernelFacts(trial).automatic_verdicts, 0);
    assert.deepEqual(evidence(trial, scope.attemptId), []);
    return {
      scoredPublicationIssues: trial.scoredPublicationError.issues,
      status: rejected.status,
      code: rejected.code,
      message: rejected.message,
    };
  } finally {
    trial.close();
  }
}

function reservations(trial, { attemptId, operationId }) {
  return compact(
    trial.db.$client
      .prepare(
        "SELECT state,version_id,pending_version_id FROM attempt_original_reservations WHERE attempt_id=? AND operation_id=?",
      )
      .all(attemptId, operationId),
  );
}

function assertProjectedOnly(trial, rows) {
  const product = attemptFacts(trial.db);
  assert.deepEqual(product, {
    attempts: 1,
    responses: 2,
    scores: 0,
    evidence: rows,
    settlements: 0,
  });
  assert.equal(
    trial.db.$client
      .prepare(
        "SELECT COUNT(*) AS n FROM attempts WHERE submitted_at IS NOT NULL",
      )
      .get().n,
    0,
  );
  assert.equal(
    trial.db.$client
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'submit'")
      .get().n,
    0,
  );
  assert.equal(
    trial.db.$client
      .prepare(
        "SELECT COUNT(*) AS n FROM responses WHERE answer_json IS NOT NULL OR auto_correct IS NOT NULL OR final_correct IS NOT NULL",
      )
      .get().n,
    0,
  );
  return product;
}

function confirm(trial, world, questions) {
  const { scope, principal } = world;
  trial.verifyWith(
    (request) =>
      request.activityId === scope.attemptId &&
      request.studentId === scope.studentId &&
      request.operationId === scope.operationId &&
      request.stepAttemptId === scope.stepAttemptId &&
      request.slotId === "answers" &&
      questions.some(
        (row) =>
          row.questionId === request.questionId &&
          row.questionVersion === request.questionVersion &&
          isDeepStrictEqual(row.original, request.original),
      ),
  );
  return trial.runtime.confirmChoices(principal, scope.attemptId, {
    protocolVersion: 1,
    operationId: scope.operationId,
    stepAttemptId: scope.stepAttemptId,
    slotId: "answers",
    questions,
  });
}

async function frozenRecovery() {
  const trial = makeTrial();
  try {
    const world = await open(trial);
    const { scope } = world;
    const v1 = await putNoteReceipt(
      trial.app,
      world.ownerCookie,
      scope.attemptId,
      firstId,
      1,
    );
    const png = makeNotePng();
    const imageResponse = await postNoteImage(
      trial.app,
      "student",
      v1.versionId,
      png,
      world.ownerCookie,
    );
    assert.equal(imageResponse.status, 200);
    const {
      data: { imageId },
    } = await imageResponse.json();
    const documentPath = `/api/student/note-versions/${v1.versionId}/document`;
    const imagePath = `/api/student/note-versions/${v1.versionId}/images/${imageId}.png`;
    const originalBody = await bytes(
      trial,
      world,
      documentPath,
      "application/gzip",
    );
    assert.equal(hash(gunzipSync(originalBody)), v1.hash);
    const saved = trial.runtime.saveChoiceDraft(
      world.principal,
      scope.attemptId,
      {
        protocolVersion: 1,
        operationId: randomUUID(),
        stepAttemptId: scope.stepAttemptId,
        slotId: "answers",
        questionId: firstId,
        questionVersion: 1,
        choice: "1",
        baseRevision: 0,
      },
    );
    assert.equal(saved.revision, 1);
    const hostRevisions = await fetchSubmitRevisions(
      trial.app,
      world.ownerCookie,
      scope.attemptId,
    );
    const wire = attemptSubmitRequestSchema.parse({
      revisions: hostRevisions.map((row) =>
        row.questionId === firstId
          ? { ...row, expectedAnswerRevision: saved.revision }
          : row,
      ),
      evidence: [
        {
          questionId: firstId,
          state: "frozen",
          versionId: v1.versionId,
          revision: v1.revision,
        },
        { questionId: secondId, state: "none" },
      ],
    });
    assert.equal(wire.revisions.length, 2);
    assert.throws(
      () =>
        prepareChoiceOriginals(trial.db, trial.dataDir, scope, {
          revisions: wire.revisions,
        }),
      { code: "NOTE_EVIDENCE_MISMATCH" },
    );
    const questions = prepareChoiceOriginals(
      trial.db,
      trial.dataDir,
      scope,
      wire,
    );
    assert.deepEqual(
      questions.map(({ original }) => original),
      [
        {
          state: "frozen",
          documentId: v1.noteId,
          versionId: v1.versionId,
          sha256: v1.hash,
        },
        { state: "none" },
      ],
    );
    const pending = [
      {
        state: "pending",
        version_id: v1.versionId,
        pending_version_id: v1.versionId,
      },
    ];
    assert.deepEqual(reservations(trial, scope), pending);
    const v2 = await putNoteReceipt(
      trial.app,
      await loginAssignmentOwner(trial.app),
      scope.attemptId,
      firstId,
      2,
      { baseRevision: v1.revision },
    );
    assert.equal(v2.revision, 2);
    assert.deepEqual(
      prepareChoiceOriginals(trial.db, trial.dataDir, scope, wire),
      questions,
    );
    const kernelReceipt = confirm(trial, world, questions);

    assert.deepEqual(evidence(trial, scope.attemptId), []);
    assert.deepEqual(kernelFacts(trial), {
      practices: 1,
      scoring_keys: 0,
      activities: 1,
      submissions: 1,
      automatic_verdicts: 0,
      completions: 1,
    });
    trial.reopen();
    const recovered = trial.recover(scope);
    assert.deepEqual(recovered.receipt, kernelReceipt);
    assert.deepEqual(
      recovered.confirmation.questions.map(({ choice }) => choice),
      ["1", null],
    );
    const gcTime = new Date(
      Date.parse(v2.savedAt) + NOTE_GC_SAFETY_WINDOW_MS + 1,
    );
    const pendingGc = gcNoteVersions(trial.db, trial.dataDir, { now: gcTime });
    assert.equal(pendingGc.keptByReference, 2);
    assert.equal(pendingGc.deletedVersionRows, 0);
    assert.equal(pendingGc.deletedFiles, 0);
    assert.equal(pendingGc.fileFailures, 0);
    assert.deepEqual(reservations(trial, scope), pending);
    const recovery = (requested) => trial.recover(requested);
    assert.throws(
      () =>
        projectConfirmedChoiceEvidence(
          trial.db,
          { ...scope, operationId: randomUUID() },
          recovery,
        ),
      { status: 404 },
    );
    assert.throws(
      () =>
        trial.runtime.recoverChoiceConfirmation(
          world.principal,
          scope.attemptId,
          {
            protocolVersion: 1,
            stepAttemptId: scope.stepAttemptId,
            operationId: scope.operationId,
          },
        ),
      { status: 403 },
    );
    assert.throws(
      () =>
        projectConfirmedChoiceEvidence(
          trial.db,
          { ...scope, attemptId: randomUUID() },
          recovery,
        ),
      { code: "ATTEMPT_NOT_FOUND" },
    );
    for (const stale of [
      {
        ...recovered.confirmation.questions[0].original,
        versionId: v2.versionId,
      },
      { ...recovered.confirmation.questions[0].original, sha256: v2.hash },
      {
        ...recovered.confirmation.questions[0].original,
        documentId: randomUUID(),
      },
    ]) {
      const changed = structuredClone(recovered);
      changed.confirmation.questions[0].original = stale;
      assert.throws(
        () => projectConfirmedChoiceEvidence(trial.db, scope, () => changed),
        { code: "NOTE_EVIDENCE_MISMATCH" },
      );
    }
    trial.db.$client.exec(`
      CREATE TEMP TRIGGER reject_m04_original_projection
      BEFORE UPDATE OF state ON attempt_original_reservations
      WHEN NEW.state = 'projected'
        AND (SELECT COUNT(*) FROM submission_evidence WHERE attempt_id=NEW.attempt_id)=2
      BEGIN SELECT RAISE(ABORT, 'm04 projection failure'); END`);
    assert.throws(
      () => projectConfirmedChoiceEvidence(trial.db, scope, recovery),
      /m04 projection failure/u,
    );
    trial.db.$client.exec("DROP TRIGGER reject_m04_original_projection");
    assert.deepEqual(evidence(trial, scope.attemptId), []);
    assert.deepEqual(reservations(trial, scope), pending);
    assert.deepEqual(
      projectConfirmedChoiceEvidence(trial.db, scope, recovery),
      kernelReceipt,
    );
    assert.deepEqual(
      evidence(trial, scope.attemptId).map(
        ({ question_id, state, version_id }) => [
          question_id,
          state,
          version_id,
        ],
      ),
      [
        [firstId, "frozen", v1.versionId],
        [secondId, "none", null],
      ],
    );
    const stable = evidence(trial, scope.attemptId);
    assert.ok(
      stable.every(
        ({ recorded_at }) => recorded_at === kernelReceipt.confirmedAt,
      ),
    );
    assert.deepEqual(reservations(trial, scope), [
      {
        state: "projected",
        version_id: v1.versionId,
        pending_version_id: null,
      },
    ]);
    assert.deepEqual(
      projectConfirmedChoiceEvidence(trial.db, scope, recovery),
      kernelReceipt,
    );
    assert.deepEqual(evidence(trial, scope.attemptId), stable);
    const gc = gcNoteVersions(trial.db, trial.dataDir, { now: gcTime });
    assert.equal(gc.keptByReference, 2);
    assert.equal(gc.deletedVersionRows, 0);
    assert.equal(gc.deletedFiles, 0);
    assert.equal(gc.fileFailures, 0);
    assert.deepEqual(
      await bytes(trial, world, documentPath, "application/gzip"),
      originalBody,
    );
    assert.deepEqual(
      await bytes(trial, world, imagePath, "image/png"),
      Buffer.from(png),
    );
    const detail = await trial.app.request(
      `/api/student/attempts/${scope.attemptId}/evidence/${firstId}`,
      { headers: { cookie: world.ownerCookie } },
    );
    assert.equal(detail.status, 200);
    const { data } = await detail.json();
    assert.equal(data.note.currentVersionId, v2.versionId);
    assert.equal(data.evidence.versionId, v1.versionId);
    const product = assertProjectedOnly(trial, 2);
    const kernel = kernelFacts(trial);
    assert.equal(kernel.submissions, 1);
    assert.equal(kernel.automatic_verdicts, 0);
    return {
      recovered: recovered.receipt,
      productPath: trial.productPath,
      kernelPath: trial.kernelPath,
      projected: stable,
      pendingGc,
      gc,
      gzipBytes: originalBody.length,
      pngBytes: png.length,
      product,
      kernel,
    };
  } finally {
    trial.close();
  }
}

async function unfrozenRecovery(omitted) {
  const trial = makeTrial();
  try {
    const world = await open(trial);
    const { scope } = world;
    const working = omitted
      ? null
      : await putNoteReceipt(
          trial.app,
          world.ownerCookie,
          scope.attemptId,
          firstId,
          1,
        );
    const wire = attemptSubmitRequestSchema.parse({
      revisions: await fetchSubmitRevisions(
        trial.app,
        world.ownerCookie,
        scope.attemptId,
      ),
      ...(omitted
        ? {}
        : {
            evidence: [
              { questionId: firstId, state: "missing" },
              { questionId: secondId, state: "none" },
            ],
          }),
    });
    const questions = prepareChoiceOriginals(
      trial.db,
      trial.dataDir,
      scope,
      wire,
    );
    const states = omitted
      ? ["uncollected", "uncollected"]
      : ["missing", "none"];
    assert.deepEqual(
      questions.map(({ original }) => original.state),
      states,
    );
    const receipt = confirm(trial, world, questions);
    trial.reopen();
    assert.deepEqual(
      trial
        .recover(scope)
        .confirmation.questions.map(({ original }) => original.state),
      states,
    );
    const recover = (requested) => trial.recover(requested);
    assert.deepEqual(
      projectConfirmedChoiceEvidence(trial.db, scope, recover),
      receipt,
    );
    const stable = evidence(trial, scope.attemptId);
    assert.deepEqual(
      projectConfirmedChoiceEvidence(trial.db, scope, recover),
      receipt,
    );
    assert.deepEqual(evidence(trial, scope.attemptId), stable);
    assert.deepEqual(
      stable.map(({ question_id, state, version_id }) => [
        question_id,
        state,
        version_id,
      ]),
      omitted
        ? []
        : [
            [firstId, "missing", null],
            [secondId, "none", null],
          ],
    );
    assert.deepEqual(reservations(trial, scope), []);
    const detail = await trial.app.request(
      `/api/student/attempts/${scope.attemptId}/evidence/${firstId}`,
      { headers: { cookie: world.ownerCookie } },
    );
    assert.equal(detail.status, 200);
    const { data } = await detail.json();
    if (working) {
      assert.equal(data.note.currentVersionId, working.versionId);
      assert.equal(data.evidence.state, "missing");
      assert.equal(data.evidence.versionId, null);
    } else {
      assert.equal(data.note, null);
      assert.equal(data.evidence, null);
    }
    const product = assertProjectedOnly(trial, omitted ? 0 : 2);
    const kernel = kernelFacts(trial);
    assert.equal(kernel.submissions, 1);
    assert.equal(kernel.automatic_verdicts, 0);
    return { states, product, kernel };
  } finally {
    trial.close();
  }
}
console.log(
  JSON.stringify(
    {
      archiveHash,
      scoringRed: await scoredRed(),
      frozen: await frozenRecovery(),
      missing: await unfrozenRecovery(false),
      uncollected: await unfrozenRecovery(true),
    },
    null,
    2,
  ),
);
