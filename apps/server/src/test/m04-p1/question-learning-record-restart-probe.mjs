import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import {
  attemptStartOkSchema,
  learningRecordSchema,
  reviewPackPreviewDataSchema,
  reviewPackSchema,
} from "@tutor/contract";
import { createDb } from "../../db/client.ts";
import {
  getAiLearningRecord,
  learningRecordMaterialRefs,
} from "../../services/learning-record-service.ts";
import { assertNoLeak } from "../assert-no-leak.ts";
import { callToolJson, connectMcpClientViaApp } from "../mcp-test-utils.ts";
import { putNoteReceipt } from "../note-fixtures.ts";
import { extractSessionToken } from "../note-world.ts";
import {
  fetchSubmitRevisions,
  submitAttemptRequest,
} from "../submit-revisions.ts";
import { unzipEntries } from "../unzip.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "./product-fixture.ts";
import { createRealServiceFixture } from "./real-service-fixture.mjs";

const service = await createRealServiceFixture();
const { app, dataDir, boot, stop } = service;
const far = "2099-01-01T00:00:00.000Z";
const past = "2000-01-01T00:00:00.000Z";
const first = "m04-p0-q1";
const question = "m04-p0-q2";
const studentPrivate = [
  "attemptId",
  "studentId",
  "questionId",
  "versionId",
  "snapshotHash",
  "teacherMark",
  "teacherComment",
  "reviewSource",
  "effectiveVerdict",
  "acceptedChoice",
  "scoringKey",
];
const choice = { kind: "choice", index: 0 };
function dbRead(f) {
  const db = createDb(join(dataDir, "tutor.db"));
  try {
    return f(db.$client, db);
  } finally {
    db.$client.close();
  }
}
async function status(response, expected) {
  assert.equal(response.status, expected, await response.clone().text());
  return response;
}
function compareRecord(record) {
  return {
    choice: record.answer.current,
    text: record.answer.answerText,
    revision: record.answer.answerRevision,
    answered: record.grading.answered,
    auto: record.grading.autoCorrect,
    final: record.grading.finalCorrect,
  };
}

try {
  const firstPid = await boot(true);
  const world = await setupAssignment(app, far);
  const { teacher, ownerCookie, otherCookie } = world;
  const assignment = await assignKernelFixture(app, world, {
    dueAt: far,
    answerRelease: "after_due",
  });
  const call = (path, cookie, method = "GET", body) =>
    app.request(path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function open(assignmentId) {
    const opened = await status(
      await postAssignment(app, assignmentId, ownerCookie),
      200,
    );
    const { id } = attemptStartOkSchema.parse(await opened.json()).data;
    for (const [qid, index] of [
      [first, 1],
      [question, 0],
    ]) {
      await status(
        await call(
          `/api/student/attempts/${id}/answers/${qid}`,
          ownerCookie,
          "PUT",
          {
            answer: { kind: "choice", index },
          },
        ),
        200,
      );
    }
    const revisions = await fetchSubmitRevisions(app, ownerCookie, id);
    const v1 = await putNoteReceipt(app, ownerCookie, id, question);
    const v2 = await putNoteReceipt(app, ownerCookie, id, question, 2, {
      baseRevision: v1.revision,
    });
    return {
      id,
      v2,
      rowId: revisions.find(({ questionId }) => questionId === question)
        .questionRevisionId,
    };
  }
  const legacy = await open(world.assignmentId);
  const candidate = await open(assignment);
  const root = (role, work, qid = question) =>
    `/api/${role}/attempts/${work.id}/questions/${qid}`;
  async function getRecord(role, work) {
    const response = await status(
      await call(
        `${root(role, work)}/record`,
        role === "student" ? ownerCookie : teacher,
      ),
      200,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()).data;
    if (role === "student")
      assertNoLeak(body, { allow: ["answer"], forbid: studentPrivate });
    return learningRecordSchema.parse(body);
  }
  const teacherDraft = await getRecord("teacher", candidate);
  const studentDraft = await getRecord("student", candidate);
  const teacherDraftPack = await pack("teacher", candidate);
  const studentDraftPack = await pack("student", candidate);
  const evidence = ({ v2 }) => [
    { questionId: first, state: "none" },
    {
      questionId: question,
      state: "frozen",
      versionId: v2.versionId,
      revision: v2.revision,
    },
  ];
  await status(
    await submitAttemptRequest(app, ownerCookie, legacy.id, evidence(legacy)),
    200,
  );
  // 两版由正常草稿端点生成。切回 V2 交卷，之后恢复曾见的中断截面。
  // 读回测试不要求交卷后仍能通过草稿端点写入。
  const late = await putNoteReceipt(
    app,
    ownerCookie,
    candidate.id,
    question,
    3,
    { baseRevision: candidate.v2.revision },
  );
  assert.equal(late.revision, 3);
  function restoreHead({ versionId, revision, noteId, savedAt }) {
    const result = dbRead((db) =>
      db
        .prepare(
          "UPDATE notes SET current_version_id=?,current_revision=?,server_saved_at=?,updated_at=? WHERE id=? AND attempt_id=?",
        )
        .run(versionId, revision, savedAt, savedAt, noteId, candidate.id),
    );
    assert.equal(result.changes, 1);
  }
  restoreHead(candidate.v2);
  dbRead((db) =>
    db.exec(`
    CREATE TRIGGER interrupt_learning_record_projection BEFORE UPDATE OF status ON attempts
    WHEN NEW.status = 'graded'
    BEGIN SELECT RAISE(ABORT, 'interrupted learning record projection'); END
  `),
  );
  try {
    await status(
      await submitAttemptRequest(
        app,
        ownerCookie,
        candidate.id,
        evidence(candidate),
      ),
      500,
    );
  } finally {
    dbRead((db) =>
      db.exec("DROP TRIGGER interrupt_learning_record_projection"),
    );
  }
  const host = () =>
    dbRead((db) =>
      db.prepare("SELECT status FROM attempts WHERE id=?").get(candidate.id),
    );
  assert.equal(host().status, "draft");
  restoreHead(late);
  const outside = await status(
    await call("/api/public/teacher/register", "", "POST", {
      loginName: "单题记录他教师",
      password: "other-teacher-8",
    }),
    200,
  );
  const otherTeacher = `tutor_session=${extractSessionToken(outside)}`;
  await stop();
  const secondPid = await boot(false);
  assert.notEqual(firstPid, secondPid);

  async function pack(role, work) {
    const path = `${root(role, work)}/review-pack`;
    const cookie = role === "student" ? ownerCookie : teacher;
    const preview = await status(
      await call(`${path}/preview`, cookie, "POST"),
      200,
    );
    const data = reviewPackPreviewDataSchema.parse((await preview.json()).data);
    const response = await status(await call(path, cookie, "POST"), 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    const entries = unzipEntries(new Uint8Array(await response.arrayBuffer()));
    assert.equal(entries.get("review.md").toString("utf8"), data.reviewMd);
    const rawPack = JSON.parse(entries.get("pack.json"));
    const rawRecord = JSON.parse(entries.get("record.json"));
    if (role === "student") {
      assertNoLeak(rawPack, {
        forbid: [...studentPrivate, "autoCorrect", "finalCorrect"],
      });
      assertNoLeak(rawRecord, { allow: ["answer"], forbid: studentPrivate });
    }
    return {
      preview: data,
      pack: reviewPackSchema.parse(rawPack),
      record: learningRecordSchema.parse(rawRecord),
    };
  }

  const fromPack = await pack("teacher", candidate);
  const actual = await getRecord("teacher", candidate);
  const expected = await getRecord("teacher", legacy);
  const summary = compareRecord(actual);
  console.log(
    JSON.stringify({
      firstPid,
      secondPid,
      draft: compareRecord(teacherDraft),
      old: compareRecord(expected),
      actual: summary,
      packed: compareRecord(fromPack.record),
      packageAnswer: fromPack.pack.response.answerText,
      packageFinal: fromPack.pack.response.finalCorrect,
      original: fromPack.pack.evidence.version,
      host: host(),
      lateRevision: late.revision,
    }),
  );
  assert.deepEqual(compareRecord(expected), {
    choice,
    text: "A",
    revision: 1,
    answered: true,
    auto: false,
    final: false,
  });
  assert.deepEqual(summary, compareRecord(expected));
  assert.deepEqual(compareRecord(fromPack.record), summary);
  assert.equal(fromPack.pack.response.answerText, "A");
  assert.equal(fromPack.pack.response.finalCorrect, false);
  assert.equal(
    fromPack.pack.evidence.version.versionId,
    candidate.v2.versionId,
  );
  assert.equal(actual.identity.questionRevisionId, candidate.rowId);
  assert.equal(actual.identity.questionNo, 2);
  assert.equal(actual.identity.attemptStatus, "graded");
  assert.equal(host().status, "graded");
  const draftMaterial = (record) =>
    record.ink.find(({ kind }) => kind === "draft");
  assert.equal(draftMaterial(actual).version.versionId, candidate.v2.versionId);
  assert.equal(draftMaterial(fromPack.record).version.revision, 2);
  assert.equal(draftMaterial(fromPack.record).strokes.length, 2);
  dbRead((_, db) => {
    const ai = getAiLearningRecord(
      db,
      dataDir,
      world.studentId,
      candidate.id,
      question,
    );
    const pinned = learningRecordMaterialRefs(db, candidate.id, question).find(
      ({ kind }) => kind === "draft",
    );
    assert.deepEqual(ai.answer.current, choice);
    assert.equal(draftMaterial(ai).version.revision, late.revision);
    assert.equal(draftMaterial(ai).version.revision, pinned.revision);
    assert.equal(draftMaterial(ai).version.hash, pinned.hash);
  });

  for (const draft of [
    teacherDraft,
    studentDraft,
    teacherDraftPack.record,
    studentDraftPack.record,
  ]) {
    assert.equal(draft.identity.attemptStatus, "draft");
    assert.deepEqual(draft.answer.current, choice);
    assert.equal(draft.answer.answerRevision, 1);
    assert.equal(draft.grading.answered, false);
  }

  for (const { pack: draftPack } of [teacherDraftPack, studentDraftPack])
    assert.equal(draftPack.response.answerText, "A");

  async function studentVisibility(released) {
    const current = await getRecord("student", candidate);
    const exported = await pack("student", candidate);
    assert.deepEqual(current.answer.current, choice);
    assert.equal(current.answer.answerRevision, 1);
    assert.equal(current.grading.answered, true);
    assert.equal(draftMaterial(current).version.revision, 2);
    assert.equal(exported.preview.released, released);
    assert.equal(exported.pack.response.answerText, "A");
    for (const record of [current, exported.record]) {
      if (released) assert.equal(record.grading.finalCorrect, false);
      else assert.ok(!Object.hasOwn(record.grading, "finalCorrect"));
    }
  }
  for (const path of ["record", "review-pack/preview", "review-pack"]) {
    const method = path === "record" ? "GET" : "POST";
    await status(
      await call(`${root("student", candidate)}/${path}`, otherCookie, method),
      403,
    );
    await status(
      await call(`${root("teacher", candidate)}/${path}`, otherTeacher, method),
      404,
    );
  }
  await studentVisibility(false);
  for (const dueAt of [past, far]) {
    await status(
      await call(`/api/teacher/assignments/${assignment}`, teacher, "PATCH", {
        dueAt,
      }),
      200,
    );
    await studentVisibility(dueAt === past);
    assert.deepEqual(
      compareRecord(await getRecord("teacher", candidate)),
      summary,
    );
  }

  async function teacherTool(cookie) {
    const tokenResult = await status(
      await call("/api/teacher/api-token", cookie, "POST"),
      200,
    );
    const client = await connectMcpClientViaApp(
      app,
      "/mcp",
      (await tokenResult.json()).data.token,
      "m04-record",
    );
    try {
      return await callToolJson(client, "get_question_learning_record", {
        attemptId: candidate.id,
        questionId: question,
      });
    } finally {
      await client.close();
    }
  }

  const tool = await teacherTool(teacher);
  assert.equal(tool.isError, false);
  assert.deepEqual(
    compareRecord(learningRecordSchema.parse(tool.data)),
    summary,
  );
  const outsider = await teacherTool(otherTeacher);
  assert.equal(outsider.isError, true);
  assert.equal(outsider.data.error, "ATTEMPT_NOT_FOUND");

  const kernelPath = join(dataDir, "learning-kernel.sqlite");
  const offline = join(dataDir, "learning-kernel-offline.sqlite");
  renameSync(kernelPath, offline);
  try {
    for (const [role, cookie] of [
      ["student", ownerCookie],
      ["teacher", teacher],
    ]) {
      for (const path of ["record", "review-pack/preview", "review-pack"]) {
        const response = await status(
          await call(
            `${root(role, candidate)}/${path}`,
            cookie,
            path === "record" ? "GET" : "POST",
          ),
          503,
        );
        const error = await response.json();
        assert.equal(error.error, "KERNEL_ATTEMPT_UNAVAILABLE");
        assert.ok(!Object.hasOwn(error, "data"));
      }
    }
    assert.deepEqual(
      compareRecord(await getRecord("teacher", legacy)),
      summary,
    );
    const offlineTool = await teacherTool(teacher);
    assert.equal(offlineTool.isError, true);
    assert.equal(offlineTool.data.error, "KERNEL_ATTEMPT_UNAVAILABLE");
    await status(
      await call(`${root("student", candidate)}/record`, otherCookie),
      403,
    );
  } finally {
    renameSync(offline, kernelPath);
  }
  assert.deepEqual(
    dbRead((db) =>
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM responses WHERE attempt_id=? AND (answer_json IS NOT NULL OR auto_correct IS NOT NULL OR final_correct IS NOT NULL)",
        )
        .get(candidate.id),
    ),
    { n: 0 },
  );
  for (const [role, cookie] of [
    ["student", ownerCookie],
    ["teacher", teacher],
  ]) {
    await status(await call(`/api/${role}/logout`, cookie, "POST"), 200);
    await status(await call(`${root(role, candidate)}/record`, cookie), 401);
    await status(
      await call(`${root(role, candidate)}/review-pack`, cookie, "POST"),
      401,
    );
  }
  console.log("单题学习记录、导出两份 JSON、原稿版本、公布及身份隔离均通过");
} finally {
  await service.close();
}
