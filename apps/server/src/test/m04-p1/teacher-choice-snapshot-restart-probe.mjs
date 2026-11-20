import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import {
  attemptDraftOkSchema,
  attemptResultOkSchema,
  attemptStartOkSchema,
} from "@tutor/contract";
import { callToolJson, connectMcpClientViaHttp } from "../mcp-test-utils.ts";
import { putNoteReceipt } from "../note-fixtures.ts";
import { submitAttemptRequest } from "../submit-revisions.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "./product-fixture.ts";
import { createRealServiceFixture } from "./real-service-fixture.mjs";

const first = await createRealServiceFixture();
const peer = await createRealServiceFixture(first.dataDir);
const gate = join(first.dataDir, "snapshot-stage.json");
const preload = new URL(
  "./fixtures/pause-choice-amendment-after-stage.mjs",
  import.meta.url,
).href;
const stageEnv = { OWNCLASS_TEST_AMENDMENT_STAGE_GATE: gate };
const q1 = "m04-p0-q1";
const q2 = "m04-p0-q2";
const stemMd = "跨进程恢复后勘误题面";
const choose = (index) => ({ kind: "choice", index });
const clients = [];

function sql(read, readonly = true, database = "tutor.db") {
  using db = new DatabaseSync(join(first.dataDir, database), {
    readOnly: readonly,
  });
  return read(db);
}
function pending(id) {
  return sql((db) =>
    db
      .prepare(
        "SELECT operation_id, intent_json FROM kernel_choice_amendments WHERE attempt_id=?",
      )
      .get(id),
  );
}
function audits(id) {
  return sql((db) =>
    db
      .prepare(`SELECT x.id, x.kind, x.answer_revision FROM response_edit_audits x
    JOIN responses r ON r.id=x.response_id WHERE r.attempt_id=?`)
      .all(id),
  );
}
function facts(id) {
  return sql(
    (db) =>
      db
        .prepare(`SELECT
    (SELECT COUNT(*) FROM choice_snapshot_revisions r JOIN step_attempts s ON s.id=r.step_attempt_id WHERE s.activity_id=?) AS amendments,
    (SELECT COUNT(*) FROM submissions p JOIN step_attempts s ON s.id=p.step_attempt_id WHERE s.activity_id=?) AS confirmations,
    (SELECT COUNT(*) FROM automatic_verdicts v JOIN submissions p ON p.id=v.submission_id JOIN step_attempts s ON s.id=p.step_attempt_id WHERE s.activity_id=?) AS verdicts`)
        .get(id, id, id),
    true,
    "learning-kernel.sqlite",
  );
}

async function body(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
const req = (app, path, cookie, method = "GET", data) =>
  app.request(path, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
async function clientOf(service, token) {
  const health = await service.app.request("/api/public/health");
  const client = await connectMcpClientViaHttp(
    new URL("/mcp", health.url).href,
    token,
    "snapshot-restart",
  );
  clients.push(client);
  return client;
}

async function staged(id) {
  for (let count = 0; count < 350; count++) {
    try {
      const result = JSON.parse(readFileSync(gate, "utf8"));
      if (result.attemptId === id) return result.operationId;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
    await sleep(50);
  }
  throw new Error("未观测到题面暂存");
}

try {
  const initialPid = await first.boot(true, {
    preloads: [preload],
    extraEnv: stageEnv,
  });
  const world = await setupAssignment(first.app);
  await peer.boot(false);
  const {
    data: { token },
  } = await body(
    await req(first.app, "/api/teacher/api-token", world.teacher, "POST"),
    200,
  );
  const teacher = await clientOf(first, token);
  async function open() {
    const assignment = await assignKernelFixture(first.app, world);
    const result = attemptStartOkSchema.parse(
      await body(
        await postAssignment(first.app, assignment, world.ownerCookie),
        200,
      ),
    ).data;
    const old = sql(
      (db) =>
        db
          .prepare(
            "SELECT question_snapshot_json FROM responses WHERE attempt_id=? AND question_id=?",
          )
          .get(result.id, q1).question_snapshot_json,
    );
    return {
      id: result.id,
      path: `/api/student/attempts/${result.id}`,
      old: JSON.parse(old),
    };
  }
  const edit = (at) =>
    callToolJson(teacher, "update_response_snapshot", {
      attemptId: at.id,
      questionId: q1,
      expectedAnswerRevision: 0,
      reason: "合成跨进程勘误",
      snapshot: { ...at.old, stemMd, answers: choose(0) },
    });
  const draft = async (at, app = peer.app) =>
    attemptDraftOkSchema.parse(
      await body(await req(app, at.path, world.ownerCookie), 200),
    ).data;

  const evidenceRace = await open();
  const evidenceBefore = await draft(evidenceRace);
  const evidenceEdit = edit(evidenceRace);
  const evidenceOperation = await staged(evidenceRace.id);
  assert.equal(
    JSON.parse(pending(evidenceRace.id).intent_json).kind,
    "snapshot",
  );
  assert.equal(facts(evidenceRace.id).amendments, 0);
  let original;
  try {
    original = await putNoteReceipt(
      peer.app,
      world.ownerCookie,
      evidenceRace.id,
      q1,
    );
  } finally {
    writeFileSync(`${gate}.${evidenceOperation}.release`, "");
  }
  const rejected = await evidenceEdit;
  assert.equal(rejected.data.error, "RESPONSE_EVIDENCE_EXISTS");
  assert.equal(pending(evidenceRace.id), undefined);
  assert.deepEqual(audits(evidenceRace.id), []);
  assert.equal(facts(evidenceRace.id).amendments, 0);
  const readNote = await req(
    peer.app,
    `/api/student/note-versions/${original.versionId}/document`,
    world.ownerCookie,
  );
  assert.equal(readNote.status, 200);
  assert.ok((await readNote.arrayBuffer()).byteLength > 0);
  assert.equal(
    (await draft(evidenceRace)).units[0].questions[0].stemMd,
    evidenceBefore.units[0].questions[0].stemMd,
  );

  const interrupted = await open();
  await body(
    await req(
      peer.app,
      `${interrupted.path}/answers/${q2}`,
      world.ownerCookie,
      "PUT",
      { answer: choose(2) },
    ),
    200,
  );
  sql(
    (db) =>
      db.exec(`CREATE TRIGGER interrupt_snapshot_projection BEFORE INSERT ON response_edit_audits
    WHEN NEW.kind='snapshot' BEGIN SELECT RAISE(ABORT, 'interrupted snapshot projection'); END`),
    false,
  );
  const interruptedEdit = edit(interrupted);
  const operation = await staged(interrupted.id);
  writeFileSync(`${gate}.${operation}.release`, "");
  assert.equal((await interruptedEdit).isError, true);
  assert.equal(pending(interrupted.id).operation_id, operation);
  assert.deepEqual(audits(interrupted.id), []);
  assert.equal(facts(interrupted.id).amendments, 1);
  await first.stop("SIGKILL");
  await peer.stop();
  sql((db) => db.exec("DROP TRIGGER interrupt_snapshot_projection"), false);

  const restartedPid = await first.boot(false);
  assert.notEqual(restartedPid, initialPid);
  const restarted = await clientOf(first, token);
  const firstRead = await callToolJson(restarted, "query_student_responses", {
    studentId: world.studentId,
    attemptIds: [interrupted.id],
    includeUnsubmitted: true,
    fields: "full",
  });
  assert.equal(firstRead.isError, false);
  const changed = firstRead.data.responses.find((row) => row.questionId === q1);
  assert.ok(changed);
  assert.equal(changed.answerRevision, 1);
  assert.ok(JSON.stringify(changed).includes(stemMd));
  assert.equal(pending(interrupted.id), undefined);
  assert.deepEqual(
    audits(interrupted.id).map((row) => ({ ...row })),
    [{ id: operation, kind: "snapshot", answer_revision: 1 }],
  );
  const current = await draft(interrupted, first.app);
  assert.equal(current.draftRevisions[q1], 1);
  assert.equal(current.drafts[q1], undefined);
  const question = current.units
    .flatMap((unit) => unit.questions)
    .find((row) => row.id === q1);
  assert.ok(question);
  await body(
    await req(
      first.app,
      `${interrupted.path}/answers/${q1}`,
      world.ownerCookie,
      "PUT",
      {
        answer: choose(0),
        baseRevision: 1,
        mutationId: randomUUID(),
        expectedFrozenAt: current.attempt.frozenAt,
        questionRevisionId: question.questionRevisionId,
      },
    ),
    200,
  );
  const result = attemptResultOkSchema.parse(
    await body(
      await submitAttemptRequest(first.app, world.ownerCookie, interrupted.id),
      200,
    ),
  ).data;
  assert.equal(result.attempt.scoreAuto, 100);
  const repeated = await body(
    await submitAttemptRequest(first.app, world.ownerCookie, interrupted.id),
    409,
  );
  assert.equal(repeated.error, "ALREADY_SUBMITTED");
  const authority = { ...facts(interrupted.id) };
  assert.deepEqual(authority, { amendments: 1, confirmations: 1, verdicts: 2 });
  console.log(
    JSON.stringify({
      evidenceWon: rejected.data.error,
      teacherFirstRead: 1,
      recoveredOriginalOperation: true,
      publishedScore: 100,
      afterRepeat: authority,
    }),
  );
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  await peer.close();
  await first.close();
}
