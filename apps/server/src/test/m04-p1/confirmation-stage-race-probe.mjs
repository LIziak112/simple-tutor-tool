import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { attemptResultOkSchema, attemptStartOkSchema } from "@tutor/contract";
import { openLearningRuntime } from "learning-kernel";
import { createDb } from "../../db/client.ts";
import { putNoteForm, putNoteReceipt } from "../note-fixtures.ts";
import { fetchSubmitRevisions } from "../submit-revisions.ts";
import {
  assignKernelFixture,
  loginAssignmentOwner,
  postAssignment,
  setupAssignment,
} from "./product-fixture.ts";
import { createRealServiceFixture } from "./real-service-fixture.mjs";

const first = await createRealServiceFixture();
const other = await createRealServiceFixture(first.dataDir);
const gate = join(first.dataDir, "prepared-confirmation.json");
const artifact = new URL(
  "./fixtures/pause-confirmation-after-stage.mjs",
  import.meta.url,
).href;
async function waitForStage(attemptId) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const signal = JSON.parse(readFileSync(gate, "utf8"));
      if (signal.attemptId === attemptId) return signal;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
    await sleep(50);
  }
  throw new Error("未观察到宿主已提交的预留阶段");
}
function withProduct(read) {
  const db = createDb(join(first.dataDir, "tutor.db"));
  try {
    return read(db.$client);
  } finally {
    db.$client.close();
  }
}
function readProduct(attemptId) {
  return withProduct((db) => ({
    ticket: db
      .prepare(
        "SELECT operation_id FROM kernel_attempt_confirmations WHERE attempt_id=?",
      )
      .get(attemptId),
    reserves: db
      .prepare(
        "SELECT operation_id, state, version_id, pending_version_id FROM attempt_original_reservations WHERE attempt_id=?",
      )
      .all(attemptId),
  }));
}
function requireKActive(studentId, attemptId) {
  const runtime = openLearningRuntime({
    databasePath: join(first.dataDir, "learning-kernel.sqlite"),
  });
  try {
    assert.equal(
      runtime.read({ role: "student", id: studentId }, attemptId).status,
      "active",
    );
  } finally {
    runtime.close();
  }
}
async function expectResponse(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  const payload = await response.json();
  if (code !== undefined) assert.equal(payload.error, code);
  return payload;
}

try {
  const oldPid = await first.boot(true, {
    preloads: [artifact],
    extraEnv: { OWNCLASS_TEST_CONFIRM_STAGE_GATE: gate },
  });
  const world = await setupAssignment(first.app);
  const rivalPid = await other.boot(false);
  assert.notEqual(oldPid, rivalPid);
  const secondCookie = await loginAssignmentOwner(other.app);
  assert.notEqual(secondCookie, world.ownerCookie);

  async function makeAttempt() {
    const assignmentId = await assignKernelFixture(first.app, world);
    const opened = await expectResponse(
      await postAssignment(first.app, assignmentId, world.ownerCookie),
      200,
    );
    const { id, frozenAt } = attemptStartOkSchema.parse(opened).data;
    const path = `/api/student/attempts/${id}`;
    const revisions = () =>
      fetchSubmitRevisions(first.app, world.ownerCookie, id);
    const [q1, q2] = await revisions();
    await expectResponse(
      await first.app.request(`${path}/answers/${q1.questionId}`, {
        method: "PUT",
        headers: {
          cookie: world.ownerCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          answer: { kind: "choice", index: 1 },
          mutationId: randomUUID(),
          baseRevision: 0,
          questionRevisionId: q1.questionRevisionId,
          expectedFrozenAt: frozenAt,
        }),
      }),
      200,
    );
    const v1 = await putNoteReceipt(
      first.app,
      world.ownerCookie,
      id,
      q1.questionId,
    );
    const v2 = await putNoteReceipt(
      first.app,
      world.ownerCookie,
      id,
      q1.questionId,
      2,
      { baseRevision: v1.revision },
    );
    const body = {
      revisions: await revisions(),
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
    const submit = (app, cookie, payload = body) =>
      app.request(`${path}/submit`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    const writeNote = (app, cookie, strokes, options) =>
      app.request(`${path}/notes/${q1.questionId}`, {
        method: "PUT",
        headers: { cookie },
        body: putNoteForm(strokes, options),
      });
    return { id, body, submit, v2, writeNote };
  }

  const overlap = await makeAttempt();
  const firstRequest = overlap.submit(first.app, world.ownerCookie);
  const staged = await waitForStage(overlap.id);
  requireKActive(world.studentId, overlap.id);
  const earlier = readProduct(overlap.id);
  assert.deepEqual(earlier.ticket, { operation_id: staged.operationId });
  assert.deepEqual(earlier.reserves, [
    {
      operation_id: staged.operationId,
      state: "pending",
      version_id: overlap.v2.versionId,
      pending_version_id: overlap.v2.versionId,
    },
  ]);
  const sameIntent = {
    revisions: overlap.body.revisions.toReversed(),
    evidence: overlap.body.evidence.toReversed(),
  };
  const winner = await overlap.submit(other.app, secondCookie, sameIntent);
  const score = attemptResultOkSchema.parse(await expectResponse(winner, 200))
    .data.attempt.scoreAuto;
  assert.equal(score, 50);
  writeFileSync(`${gate}.${staged.operationId}.release`, "");
  const firstResponse = await firstRequest;
  await expectResponse(firstResponse, 409, "ALREADY_SUBMITTED");
  const afterOverlap = readProduct(overlap.id);
  assert.deepEqual(afterOverlap.ticket, earlier.ticket);
  assert.deepEqual(afterOverlap.reserves, [
    { ...earlier.reserves[0], state: "projected", pending_version_id: null },
  ]);

  const changed = await makeAttempt();
  const replacedRequest = changed.submit(first.app, world.ownerCookie);
  const replacedStage = await waitForStage(changed.id);
  requireKActive(world.studentId, changed.id);
  const changedIntent = {
    ...changed.body,
    evidence: changed.body.evidence.map((item) => ({
      questionId: item.questionId,
      state: "missing",
    })),
  };
  await expectResponse(
    await changed.submit(other.app, secondCookie, changedIntent),
    200,
  );
  writeFileSync(`${gate}.${replacedStage.operationId}.release`, "");
  await expectResponse(await replacedRequest, 409, "ALREADY_SUBMITTED");
  const afterReplacement = readProduct(changed.id);
  assert.notEqual(
    afterReplacement.ticket.operation_id,
    replacedStage.operationId,
  );
  assert.deepEqual(afterReplacement.reserves, [
    {
      operation_id: replacedStage.operationId,
      state: "aborted",
      version_id: changed.v2.versionId,
      pending_version_id: null,
    },
  ]);

  const writing = await makeAttempt();
  const submitBeforeWrite = writing.submit(first.app, world.ownerCookie);
  const writeStage = await waitForStage(writing.id);
  const writingTicket = readProduct(writing.id);
  requireKActive(world.studentId, writing.id);
  const noteVersions = () =>
    withProduct((db) =>
      db
        .prepare(
          "SELECT revision FROM note_versions WHERE note_id=? ORDER BY revision",
        )
        .all(writing.v2.noteId)
        .map(({ revision }) => revision),
    );
  const files = () =>
    readdirSync(
      join(first.dataDir, "blobs", "notes", writing.v2.noteId),
    ).sort();
  const beforeFiles = files();
  const nextWrite = (options = { baseRevision: 2 }) =>
    writing.writeNote(other.app, secondCookie, 3, options);
  const kernelPath = join(first.dataDir, "learning-kernel.sqlite");
  const offlinePath = `${kernelPath}.missing`;
  renameSync(kernelPath, offlinePath);
  try {
    await expectResponse(await nextWrite(), 503, "KERNEL_ATTEMPT_UNAVAILABLE");
  } finally {
    renameSync(offlinePath, kernelPath);
  }
  withProduct((db) =>
    db.exec(`
    CREATE TRIGGER fail_note_during_pending_confirmation BEFORE INSERT ON note_versions
    BEGIN SELECT RAISE(ABORT, 'interrupted scratch install'); END
  `),
  );
  try {
    await expectResponse(await nextWrite(), 500);
  } finally {
    withProduct((db) =>
      db.exec("DROP TRIGGER fail_note_during_pending_confirmation"),
    );
  }
  assert.deepEqual(files(), beforeFiles);
  assert.deepEqual(noteVersions(), [1, 2]);
  assert.deepEqual(readProduct(writing.id), writingTicket);

  const wrote = await expectResponse(await nextWrite(), 200);
  assert.equal(wrote.data.revision, 3);
  assert.deepEqual(readProduct(writing.id), writingTicket);
  writeFileSync(`${gate}.${writeStage.operationId}.release`, "");
  await expectResponse(await submitBeforeWrite, 409, "NOTE_EVIDENCE_MISMATCH");
  requireKActive(world.studentId, writing.id);
  assert.equal(readProduct(writing.id).ticket, undefined);
  assert.deepEqual(noteVersions(), [1, 2, 3]);

  // 两个独立进程争同一个版本。共享 mutation 返回同一回执，其他 mutation 只准一个切头。
  const same = { baseRevision: 3, mutationId: randomUUID() };
  const replays = await Promise.all([
    writing.writeNote(first.app, world.ownerCookie, 4, same),
    writing.writeNote(other.app, secondCookie, 4, same),
  ]);
  const receipts = await Promise.all(
    replays.map((item) => expectResponse(item, 200)),
  );
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal(receipts[0].data.revision, 4);
  const edits = await Promise.all([
    writing.writeNote(first.app, world.ownerCookie, 5, { baseRevision: 4 }),
    writing.writeNote(other.app, secondCookie, 5, { baseRevision: 4 }),
  ]);
  assert.deepEqual(edits.map(({ status }) => status).sort(), [200, 409]);
  const losingEdit = await expectResponse(
    edits.find(({ status }) => status === 409),
    409,
    "NOTE_REVISION_CONFLICT",
  );
  const lastNote = await expectResponse(
    edits.find(({ status }) => status === 200),
    200,
  );
  assert.equal(losingEdit._current.versionId, lastNote.data.versionId);
  assert.deepEqual(noteVersions(), [1, 2, 3, 4, 5]);
  assert.equal(files().length, beforeFiles.length + 3);
  const latest = {
    ...writing.body,
    evidence: writing.body.evidence.map((item) =>
      item.state === "frozen"
        ? { ...item, versionId: lastNote.data.versionId, revision: 5 }
        : item,
    ),
  };
  await expectResponse(
    await writing.submit(other.app, secondCookie, latest),
    200,
  );
  await expectResponse(
    await nextWrite({ baseRevision: 5 }),
    409,
    "ALREADY_SUBMITTED",
  );
  assert.deepEqual(noteVersions(), [1, 2, 3, 4, 5]);

  const interrupted = await makeAttempt();
  const dropped = interrupted.submit(first.app, world.ownerCookie).then(
    (response) => ({ http: response.status }),
    () => ({ disconnected: true }),
  );
  const held = await waitForStage(interrupted.id);
  requireKActive(world.studentId, interrupted.id);
  const beforeRestart = readProduct(interrupted.id);
  await first.stop("SIGKILL");
  assert.deepEqual(await dropped, { disconnected: true });
  await other.stop();
  const restartedPid = await other.boot(false);
  assert.notEqual(restartedPid, oldPid);
  assert.notEqual(restartedPid, rivalPid);
  const resumed = await interrupted.submit(other.app, secondCookie);
  assert.equal(
    attemptResultOkSchema.parse(await expectResponse(resumed, 200)).data.attempt
      .scoreAuto,
    50,
  );
  const afterRestart = readProduct(interrupted.id);
  assert.deepEqual(afterRestart.ticket, { operation_id: held.operationId });
  assert.deepEqual(afterRestart.ticket, beforeRestart.ticket);
  assert.deepEqual(afterRestart.reserves, [
    {
      ...beforeRestart.reserves[0],
      state: "projected",
      pending_version_id: null,
    },
  ]);
  await expectResponse(
    await interrupted.submit(other.app, secondCookie),
    409,
    "ALREADY_SUBMITTED",
  );
  console.log(
    JSON.stringify(
      {
        processes: [oldPid, rivalPid, restartedPid],
        sameIntent: {
          winner: winner.status,
          contender: firstResponse.status,
          preserved: staged.operationId,
        },
        differentIntent: {
          replaced: replacedStage.operationId,
          winner: afterReplacement.ticket.operation_id,
          retired: afterReplacement.reserves[0].state,
        },
        scratchDuringConfirmation: {
          pendingRevision: wrote.data.revision,
          resumedSubmissionRevision: lastNote.data.revision,
          replayedRevision: receipts[0].data.revision,
          conflictingMutation: losingEdit.error,
          finalRevisions: noteVersions(),
        },
        restartedBeforeConfirmation: {
          preserved: held.operationId,
          response: resumed.status,
          noteRevision: interrupted.v2.revision,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await other.close();
  // 失败时也可能仍停在进程内暂停点。
  await first.stop("SIGKILL");
  await first.close();
}
