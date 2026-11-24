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
import { fetchSubmitRevisions } from "../submit-revisions.ts";
import {
  assignKernelFixture,
  loginAssignmentOwner,
  postAssignment,
  setupAssignment,
} from "./product-fixture.ts";
import { createRealServiceFixture } from "./real-service-fixture.mjs";

const first = await createRealServiceFixture();
const peer = await createRealServiceFixture(first.dataDir);
const { dataDir } = first;
const gate = join(dataDir, "amendment-stage.json");
const reason = "合成勘误原因";
const corrected = { kind: "choice", index: 1 };
const previous = { kind: "choice", index: 0 };
const questionId = "m04-p0-q1";
const clients = [];
const proof = {};
const source = new URL("./fixtures/P0-单选夹具.md", import.meta.url);
const preload = new URL(
  "./fixtures/pause-choice-amendment-after-stage.mjs",
  import.meta.url,
).href;

async function responseBody(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

function call(app, path, cookie, method = "GET", data) {
  return app.request(path, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}

function product(read, readOnly = true) {
  using db = new DatabaseSync(join(dataDir, "tutor.db"), { readOnly });
  return read(db);
}

function persisted(id) {
  return product((db) => ({
    pending: db
      .prepare(
        "SELECT operation_id, intent_json FROM kernel_choice_amendments WHERE attempt_id = ?",
      )
      .get(id),
    audits: db
      .prepare(`SELECT a.id, a.answer_revision, a.previous_json, a.reason, a.teacher_id
      FROM response_edit_audits a JOIN responses r ON r.id = a.response_id
      WHERE r.attempt_id = ? ORDER BY a.answer_revision`)
      .all(id),
    host: db
      .prepare(
        "SELECT status, activated_at, last_activity_at FROM attempts WHERE id = ?",
      )
      .get(id),
  }));
}

function authoritative(id) {
  using db = new DatabaseSync(join(dataDir, "learning-kernel.sqlite"), {
    readOnly: true,
  });
  return db
    .prepare(`SELECT
    (SELECT COUNT(*) FROM works WHERE activity_id=? AND question_id IS NOT NULL) AS choices,
    (SELECT COUNT(*) FROM choice_draft_amendments x JOIN works w ON w.id=x.work_id WHERE w.activity_id=?) AS amendments,
    (SELECT COUNT(*) FROM submissions s JOIN step_attempts a ON a.id=s.step_attempt_id WHERE a.activity_id=?) AS confirmations,
    (SELECT COUNT(*) FROM completions WHERE activity_id=?) AS completions`)
    .get(id, id, id, id);
}

async function staged(id) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    try {
      const state = JSON.parse(readFileSync(gate, "utf8"));
      if (state.attemptId === id) return state;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
    await sleep(50);
  }
  throw new Error("未观测到提交后的教师勘误待处理记录");
}

async function teacherClient(service, token) {
  const health = await service.app.request("/api/public/health");
  const url = new URL("/mcp", health.url);
  const client = await connectMcpClientViaHttp(
    url.href,
    token,
    "teacher-choice-amendment",
  );
  clients.push(client);
  return client;
}

function edit(client, id, expectedAnswerRevision = 0) {
  return callToolJson(client, "update_response_answer", {
    attemptId: id,
    questionId,
    answer: corrected,
    reason,
    expectedAnswerRevision,
  });
}

try {
  const firstPid = await first.boot(true, {
    preloads: [preload],
    extraEnv: { OWNCLASS_TEST_AMENDMENT_STAGE_GATE: gate },
  });
  const world = await setupAssignment(first.app);
  const peerPid = await peer.boot(false);
  assert.notEqual(firstPid, peerPid);
  const peerCookie = await loginAssignmentOwner(peer.app);
  const actor = product(
    (db) =>
      db
        .prepare("SELECT teacher_id AS teacherId FROM students WHERE id = ?")
        .get(world.studentId).teacherId,
  );
  const {
    data: { token },
  } = await responseBody(
    await call(first.app, "/api/teacher/api-token", world.teacher, "POST"),
    200,
  );
  const reviewer = await teacherClient(first, token);

  async function open() {
    const assignment = await assignKernelFixture(first.app, world);
    const result = await responseBody(
      await postAssignment(first.app, assignment, world.ownerCookie),
      200,
    );
    const { id, frozenAt } = attemptStartOkSchema.parse(result).data;
    const revisions = await fetchSubmitRevisions(
      first.app,
      world.ownerCookie,
      id,
    );
    const row = revisions.find((item) => item.questionId === questionId);
    assert.ok(row);
    return {
      id,
      frozenAt,
      assignment,
      revisions,
      row,
      path: `/api/student/attempts/${id}`,
    };
  }
  async function save(env) {
    const response = await call(
      peer.app,
      `${env.path}/answers/${questionId}`,
      peerCookie,
      "PUT",
      {
        answer: previous,
        baseRevision: 0,
        mutationId: randomUUID(),
        expectedFrozenAt: env.frozenAt,
        questionRevisionId: env.row.questionRevisionId,
      },
    );
    return responseBody(response, 200);
  }
  async function draft(env, cookie = peerCookie) {
    return attemptDraftOkSchema.parse(
      await responseBody(await call(peer.app, env.path, cookie), 200),
    ).data;
  }
  async function competing(env, winning) {
    const editCall = edit(reviewer, env.id);
    const pause = await Promise.race([
      staged(env.id),
      editCall.then((result) => {
        throw new Error(`到暂停点前提前返回 ${JSON.stringify(result)}`);
      }),
    ]);
    assert.equal(persisted(env.id).pending?.operation_id, pause.operationId);
    assert.equal(authoritative(env.id).amendments, 0);
    try {
      await winning(pause);
    } finally {
      writeFileSync(`${gate}.${pause.operationId}.release`, "");
    }
    return editCall;
  }

  const saveWin = await open();
  const saveEdit = await competing(saveWin, async () => {
    await save(saveWin);
  });
  assert.equal(saveEdit.data.error, "ANSWER_REVISION_CONFLICT");
  assert.deepEqual((await draft(saveWin)).drafts, { [questionId]: previous });
  assert.equal(persisted(saveWin.id).pending, undefined);
  assert.deepEqual(persisted(saveWin.id).audits, []);
  assert.equal(authoritative(saveWin.id).choices, 1);
  proof.studentSave = {
    teacher: saveEdit.data.error,
    authority: authoritative(saveWin.id),
  };

  const confirmWin = await open();
  const confirmEdit = await competing(confirmWin, async () => {
    const response = await call(
      peer.app,
      `${confirmWin.path}/submit`,
      peerCookie,
      "POST",
      { revisions: confirmWin.revisions },
    );
    const confirmed = attemptResultOkSchema.parse(
      await responseBody(response, 200),
    ).data;
    assert.equal(confirmed.attempt.scoreAuto, 0);
  });
  assert.equal(confirmEdit.data.error, "ATTEMPT_NOT_IN_PROGRESS");
  assert.equal(persisted(confirmWin.id).pending, undefined);
  assert.deepEqual(persisted(confirmWin.id).audits, []);
  assert.deepEqual(
    { ...authoritative(confirmWin.id) },
    { choices: 0, amendments: 0, confirmations: 1, completions: 1 },
  );
  proof.studentConfirm = {
    teacher: confirmEdit.data.error,
    authority: authoritative(confirmWin.id),
  };

  const resume = await open();
  const kept = await competing(resume, async (pause) => {
    const markdown = readFileSync(source, "utf8").replace(
      "2 + 3 等于多少？",
      "合成新版本，2 加 3 等于多少？",
    );
    await responseBody(
      await call(
        peer.app,
        "/api/teacher/import/commit",
        world.teacher,
        "POST",
        { markdown, filename: "M04P0.md" },
      ),
      200,
    );
    const opened = attemptStartOkSchema.parse(
      await responseBody(
        await postAssignment(peer.app, resume.assignment, peerCookie),
        200,
      ),
    ).data;
    assert.equal(opened.id, resume.id);
    assert.equal(opened.frozenAt, resume.frozenAt);
    assert.equal(persisted(resume.id).pending?.operation_id, pause.operationId);
    const read = await draft(resume);
    assert.deepEqual(read.drafts, { [questionId]: corrected });
    assert.equal(
      read.units
        .flatMap(({ questions }) => questions)
        .find(({ id }) => id === questionId).questionRevisionId,
      resume.row.questionRevisionId,
    );
    assert.equal(persisted(resume.id).audits[0]?.id, pause.operationId);
  });
  assert.equal(kept.data.success, true);
  assert.equal(kept.data.answerRevision, 1);
  assert.equal(persisted(resume.id).pending, undefined);
  assert.equal(persisted(resume.id).audits.length, 1);
  assert.equal(authoritative(resume.id).amendments, 1);
  const stale = await call(
    peer.app,
    `${resume.path}/submit`,
    peerCookie,
    "POST",
    { revisions: resume.revisions },
  );
  assert.equal(
    (await responseBody(stale, 409)).error,
    "ANSWER_REVISION_CONFLICT",
  );
  assert.equal(authoritative(resume.id).confirmations, 0);
  const current = await fetchSubmitRevisions(peer.app, peerCookie, resume.id);
  const accepted = await call(
    peer.app,
    `${resume.path}/submit`,
    peerCookie,
    "POST",
    { revisions: current },
  );
  assert.equal(
    attemptResultOkSchema.parse(await responseBody(accepted, 200)).data.attempt
      .scoreAuto,
    50,
  );
  assert.equal(authoritative(resume.id).confirmations, 1);
  proof.freeze = {
    sameAttempt: true,
    sameFrozenRow: true,
    teacher: kept.data.answerRevision,
    authority: authoritative(resume.id),
  };

  const backup = await open();
  await save(backup);
  await first.stop();
  await peer.stop();
  const backupPid = await peer.boot(true, {
    extraEnv: { INSTANCE_BACKUP_OPERATOR_ID: actor },
  });
  assert.notEqual(backupPid, peerPid);
  const connected = await teacherClient(peer, token);
  product(
    (db) =>
      db.exec(
        "CREATE TRIGGER reject_amendment_audit BEFORE INSERT ON response_edit_audits BEGIN SELECT RAISE(ABORT, 'interrupted audit'); END",
      ),
    false,
  );
  try {
    assert.equal((await edit(connected, backup.id, 1)).isError, true);
  } finally {
    product((db) => db.exec("DROP TRIGGER reject_amendment_audit"), false);
  }
  const interrupted = persisted(backup.id);
  assert.ok(interrupted.pending);
  assert.deepEqual(interrupted.audits, []);
  assert.equal(authoritative(backup.id).amendments, 1);

  const download = await call(
    peer.app,
    "/api/teacher/backup/download",
    world.teacher,
  );
  assert.equal(download.status, 200, await download.clone().text());
  const bytes = await download.arrayBuffer();
  assert.ok(bytes.byteLength > 0);
  const original = await draft(backup);
  assert.deepEqual(original.drafts, { [questionId]: corrected });
  assert.equal(persisted(backup.id).pending, undefined);

  const form = new FormData();
  form.set("zip", new File([bytes], "tutor-backup.zip"));
  form.set("password", "teacher-pass-8");
  const restored = await peer.app.request("/api/teacher/backup/restore", {
    method: "POST",
    body: form,
    headers: { cookie: world.teacher },
  });
  await responseBody(restored, 200);
  const afterRestore = persisted(backup.id);
  assert.equal(
    afterRestore.pending?.operation_id,
    interrupted.pending.operation_id,
  );
  assert.deepEqual(afterRestore.audits, []);
  if (peerPid === backupPid) throw new Error("备份轮未重启");
  const renewedCookie = await loginAssignmentOwner(peer.app);
  assert.deepEqual((await draft(backup, renewedCookie)).drafts, {
    [questionId]: corrected,
  });
  const recovered = persisted(backup.id);
  assert.equal(recovered.pending, undefined);
  assert.equal(recovered.audits.length, 1);
  assert.equal(recovered.audits[0].id, interrupted.pending.operation_id);
  assert.equal(recovered.audits[0].teacher_id, actor);
  assert.equal(recovered.audits[0].previous_json, JSON.stringify(previous));
  assert.equal(recovered.audits[0].reason, reason);
  assert.equal(authoritative(backup.id).amendments, 1);
  assert.equal(
    product((db) => db.prepare("PRAGMA foreign_key_check").all()).length,
    0,
  );
  proof.backup = {
    status: restored.status,
    bytes: bytes.byteLength,
    capturedPending: true,
    recovered: recovered.audits,
    authority: authoritative(backup.id),
  };
  console.log(JSON.stringify(proof, null, 2));
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  await peer.stop();
  await first.close();
}
