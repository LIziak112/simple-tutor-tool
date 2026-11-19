import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  attemptDraftOkSchema,
  attemptStartOkSchema,
  studentRecordsOkSchema,
} from "@tutor/contract";
import { openLearningRuntime } from "learning-kernel";
import { createDb } from "../../db/client.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "./product-fixture.ts";

import { createRealServiceFixture } from "./real-service-fixture.mjs";

const service = await createRealServiceFixture();
const { app, dataDir, boot, stop } = service;

async function interruptProjection(put, inspect) {
  const product = createDb(join(dataDir, "tutor.db"));
  try {
    product.$client.exec(`
      CREATE TRIGGER fail_choice_activity_projection
      BEFORE UPDATE OF activated_at, last_activity_at ON attempts
      BEGIN SELECT RAISE(ABORT, 'forced P3 activity projection failure'); END
    `);
    try {
      const response = await put();
      assert.equal(response.status, 500, await response.clone().text());
      inspect(product.$client);
      return response.status;
    } finally {
      product.$client.exec("DROP TRIGGER fail_choice_activity_projection");
    }
  } finally {
    product.$client.close();
  }
}
try {
  const firstPid = await boot(true);
  const world = await setupAssignment(app);
  const assignmentId = await assignKernelFixture(app, world);
  const started = await postAssignment(app, assignmentId, world.ownerCookie);
  assert.equal(started.status, 200, await started.clone().text());
  const { id, frozenAt } = attemptStartOkSchema.parse(
    await started.json(),
  ).data;
  const path = `/api/student/attempts/${id}`;
  const headers = {
    cookie: world.ownerCookie,
    "content-type": "application/json",
  };
  const detail = async () => {
    const response = await app.request(path, { headers });
    assert.equal(response.status, 200, await response.clone().text());
    return attemptDraftOkSchema.parse(await response.json()).data;
  };
  const records = async () => {
    const response = await app.request("/api/student/records", { headers });
    assert.equal(response.status, 200);
    return studentRecordsOkSchema.parse(await response.json()).data;
  };
  const { units } = await detail();
  const questions = units.flatMap(({ questions }) => questions);
  assert.deepEqual(
    questions.map(({ id }) => id),
    ["m04-p0-q1", "m04-p0-q2"],
  );
  assert.equal((await records()).total, 0);
  const [question, second] = questions;
  const saveRequest = (item, index) => {
    const wire = JSON.stringify({
      answer: { kind: "choice", index },
      baseRevision: 0,
      mutationId: randomUUID(),
      questionRevisionId: item.questionRevisionId,
      expectedFrozenAt: frozenAt,
    });
    return () =>
      app.request(`${path}/answers/${item.id}`, {
        method: "PUT",
        headers,
        body: wire,
      });
  };
  const put = saveRequest(question, 1);
  const activitySql =
    "SELECT activated_at, last_activity_at FROM attempts WHERE id=?";
  const interruptedStatus = await interruptProjection(put, (db) => {
    assert.deepEqual(db.prepare(activitySql).get(id), {
      activated_at: null,
      last_activity_at: null,
    });
  });

  const runtime = openLearningRuntime({
    databasePath: join(dataDir, "learning-kernel.sqlite"),
  });
  let committed;
  try {
    const actor = { role: "student", id: world.studentId };
    const { choiceDrafts } = runtime.read(actor, id);
    assert.deepEqual(
      choiceDrafts.map(({ questionId, revision, choice }) => [
        questionId,
        revision,
        choice,
      ]),
      [[question.id, 1, "1"]],
    );
    committed = runtime.readChoiceDraftActivity(actor, id);
    assert.ok(committed?.firstChangedAt);
  } finally {
    runtime.close();
  }

  await stop();
  const rebootPid = await boot(false);
  assert.notEqual(firstPid, rebootPid);
  const recordsBeforeDetail = (await records()).total;
  const recovered = await detail();
  assert.equal(recovered.attempt.id, id);
  assert.equal(recovered.attempt.activatedAt, committed.firstChangedAt);
  const frozenIdentity = ({ units }) =>
    units.flatMap(({ questions }) =>
      questions.map(({ questionRevisionId }) => questionRevisionId),
    );
  assert.deepEqual(frozenIdentity(recovered), frozenIdentity({ units }));
  assert.deepEqual(recovered.drafts, {
    [question.id]: { kind: "choice", index: 1 },
  });
  assert.deepEqual(recovered.draftRevisions, {
    [question.id]: 1,
    [questions[1].id]: 0,
  });
  const after = await records();
  assert.equal(after.total, 1);
  assert.equal(after.records[0].lastActivityAt, committed.lastChangedAt);
  const replay = await put();
  assert.equal(replay.status, 200);
  const receipt = (await replay.json()).data;
  assert.deepEqual(receipt, {
    revision: 1,
    questionId: question.id,
    changeCount: 1,
  });
  const secondPut = saveRequest(second, 2);
  const retryInterruptedStatus = await interruptProjection(secondPut, (db) => {
    assert.equal(
      db.prepare(activitySql).get(id).last_activity_at,
      committed.lastChangedAt,
    );
  });
  // 这次在重试前不读详情，单独证明 PUT 能补回投影。
  const retry = await secondPut();
  assert.equal(retry.status, 200);
  assert.deepEqual((await retry.json()).data, {
    revision: 1,
    questionId: second.id,
    changeCount: 1,
  });
  const activityAfterRetry = (await records()).records[0].lastActivityAt;
  assert.ok(activityAfterRetry > committed.lastChangedAt);
  const afterRetry = await detail();
  assert.deepEqual(afterRetry.draftRevisions, {
    [question.id]: 1,
    [second.id]: 1,
  });
  const productAfter = createDb(join(dataDir, "tutor.db"));
  try {
    assert.deepEqual(
      productAfter.$client
        .prepare(
          "SELECT answer_json, answer_revision, auto_correct FROM responses WHERE attempt_id=? ORDER BY question_id",
        )
        .all(id),
      [
        { answer_json: null, answer_revision: 0, auto_correct: null },
        { answer_json: null, answer_revision: 0, auto_correct: null },
      ],
    );
  } finally {
    productAfter.$client.close();
  }
  console.log(
    JSON.stringify(
      {
        firstPid,
        rebootPid,
        interruptedStatus,
        committed,
        recordsBeforeDetail,
        recordsAfterDetail: after.total,
        draftRevisions: recovered.draftRevisions,
        replay: receipt,
        retryInterruptedStatus,
        activityAfterRetry,
        revisionsAfterRetry: afterRetry.draftRevisions,
      },
      null,
      2,
    ),
  );
} finally {
  await service.close();
}
