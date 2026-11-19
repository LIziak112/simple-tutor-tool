import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import {
  assignmentCreateOkSchema,
  attemptStartOkSchema,
  pendingMarkListDataSchema,
  teacherAttemptListDataSchema,
} from "@tutor/contract";
import { createDb } from "../../db/client.ts";
import { callToolJson, connectMcpClientViaApp } from "../mcp-test-utils.ts";
import { extractSessionToken } from "../note-world.ts";
import { submitAttemptRequest } from "../submit-revisions.ts";
import { postAssignment, setupAssignment } from "./product-fixture.ts";
import { createRealServiceFixture } from "./real-service-fixture.mjs";

const service = await createRealServiceFixture();
const { app, dataDir, boot, stop } = service;
const manualQuestion = "m04-p4-legacy-solve";
async function status(response, expected) {
  assert.equal(response.status, expected, await response.clone().text());
  return response;
}
function dbRead(f) {
  const db = createDb(join(dataDir, "tutor.db"));
  try {
    return f(db.$client);
  } finally {
    db.$client.close();
  }
}

try {
  const firstPid = await boot(true);
  const world = await setupAssignment(app);
  const { teacher, ownerCookie, otherCookie } = world;
  const call = (path, cookie = teacher, method = "GET", body) =>
    app.request(path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const course = await status(
    await call("/api/teacher/courses", teacher, "POST", {
      title: "批改对照课程",
    }),
    201,
  );
  const courseId = (await course.json()).data.id;
  await status(
    await call(`/api/teacher/courses/${courseId}/members`, teacher, "POST", {
      studentIds: [world.studentId, world.otherStudentId],
    }),
    200,
  );
  const source = [
    "---",
    "kind: practice",
    "unit: M04-P4 传统待批",
    "topic: 学生说明",
    "---",
    "",
    `::::question{id=${manualQuestion} type=solve difficulty=1 knowledge="传统待批"}`,
    "请解释你的思路。",
    "::::",
  ].join("\n");
  const unit = await status(
    await call("/api/teacher/import/commit", teacher, "POST", {
      markdown: source,
      filename: "M04-传统待批.md",
    }),
    200,
  );
  const { id: manualUnitId } = (await unit.json()).data.units[0];
  async function assignment(title, unitId, kernel = false) {
    const created = await status(
      await call("/api/teacher/assignments", teacher, "POST", {
        title,
        courseId,
        unitIds: [unitId],
        studentIds: [world.studentId, world.otherStudentId],
        allowRedo: false,
        dueAt: "2099-01-01T00:00:00.000Z",
        answerRelease: "after_due",
        ...(kernel ? { executionBackend: "kernel" } : {}),
      }),
      201,
    );
    return assignmentCreateOkSchema.parse(await created.json()).data
      .assignments[0].id;
  }
  async function open(assignmentId, cookie = ownerCookie) {
    const opened = await status(
      await postAssignment(app, assignmentId, cookie),
      200,
    );
    return attemptStartOkSchema.parse(await opened.json()).data;
  }
  const save = async (id, questionId, answer, cookie = ownerCookie) =>
    status(
      await call(
        `/api/student/attempts/${id}/answers/${questionId}`,
        cookie,
        "PUT",
        { answer },
      ),
      200,
    );
  const manualAssignment = await assignment("手写作业", manualUnitId);
  const manual = await open(manualAssignment);
  await save(manual.id, manualQuestion, {
    kind: "final",
    finalAnswer: "先画示意图",
  });
  await status(await submitAttemptRequest(app, ownerCookie, manual.id), 200);

  const firstAssignment = await assignment("内核队列首读", world.unitId, true);
  const secondAssignment = await assignment("内核卡片首读", world.unitId, true);
  const early = await open(firstAssignment);
  const late = await open(secondAssignment);
  const active = await open(firstAssignment, otherCookie);
  await save(active.id, "m04-p0-q1", { kind: "choice", index: 1 }, otherCookie);
  const onlyOpened = await open(secondAssignment, otherCookie);
  for (const attempt of [early, late]) {
    await save(attempt.id, "m04-p0-q1", { kind: "choice", index: 1 });
    await save(attempt.id, "m04-p0-q2", { kind: "choice", index: 0 });
  }
  const from = new Date().toISOString();
  dbRead((db) =>
    db.exec(`
    CREATE TRIGGER interrupt_workbench_projection BEFORE UPDATE OF status ON attempts
    WHEN NEW.status = 'graded'
    BEGIN SELECT RAISE(ABORT, 'interrupted workbench projection'); END
  `),
  );
  try {
    for (const attempt of [early, late])
      await status(
        await submitAttemptRequest(app, ownerCookie, attempt.id),
        500,
      );
  } finally {
    dbRead((db) => db.exec("DROP TRIGGER interrupt_workbench_projection"));
  }
  const host = (id) =>
    dbRead((db) =>
      db
        .prepare(
          "SELECT status, score_auto, score_final FROM attempts WHERE id = ?",
        )
        .get(id),
    );
  assert.equal(host(early.id).status, "draft");
  assert.equal(host(late.id).status, "draft");

  const outside = await status(
    await call("/api/public/teacher/register", "", "POST", {
      loginName: "批改他教师",
      password: "other-teacher-8",
    }),
    200,
  );
  const otherTeacher = `tutor_session=${extractSessionToken(outside)}`;
  await stop();
  const secondPid = await boot(false);
  assert.notEqual(firstPid, secondPid);

  const pathOf = (view, params) =>
    `/api/teacher/${view}?${new URLSearchParams(params)}`;
  async function read(view, schema, params, cookie) {
    const result = await status(await call(pathOf(view, params), cookie), 200);
    return schema.parse((await result.json()).data);
  }
  const cards = (params, cookie) =>
    read("attempts", teacherAttemptListDataSchema, params, cookie);
  const pending = (params, cookie) =>
    read("pending-marks", pendingMarkListDataSchema, params, cookie);
  const noMarks = await pending({
    assignmentId: firstAssignment,
    studentId: world.studentId,
  });
  const afterQueue = host(early.id);
  const graded = { courseId, status: "graded", from, limit: 1 };
  const pageOne = await cards(graded);
  const pageTwo = await cards({ ...graded, offset: 1 });
  const cardFacts = ({ attempts, total }) => ({
    total,
    attempts: attempts.map(
      ({
        attemptId,
        status,
        scoreAuto,
        scoreFinal,
        pendingCount,
        resultCounts,
      }) => ({
        attemptId,
        status,
        scoreAuto,
        scoreFinal,
        pendingCount,
        resultCounts,
      }),
    ),
  });
  console.log(
    JSON.stringify({
      firstPid,
      secondPid,
      noMarks: noMarks.marks.length,
      afterQueue,
      pageOne: cardFacts(pageOne),
      pageTwo: cardFacts(pageTwo),
      early: early.id,
      late: late.id,
    }),
  );
  assert.equal(noMarks.marks.length, 0);
  assert.deepEqual(afterQueue, {
    status: "graded",
    score_auto: null,
    score_final: null,
  });
  for (const [page, attempt] of [
    [pageOne, late],
    [pageTwo, early],
  ]) {
    assert.deepEqual(cardFacts(page), {
      total: 2,
      attempts: [
        {
          attemptId: attempt.id,
          status: "graded",
          scoreAuto: 50,
          scoreFinal: 50,
          pendingCount: 0,
          resultCounts: {
            correctCount: 1,
            totalCount: 2,
            pendingCount: 0,
            pendingSelfReviewCount: 0,
          },
        },
      ],
    });
  }
  assert.deepEqual(cardFacts(await cards(graded)), cardFacts(pageOne));
  assert.deepEqual(await cards({ ...graded, offset: 2 }), {
    attempts: [],
    total: 2,
  });
  const inProgress = await cards({
    courseId,
    status: "draft",
    studentId: world.otherStudentId,
  });
  assert.equal(inProgress.total, 1);
  assert.equal(inProgress.attempts[0].attemptId, active.id);
  assert.equal(inProgress.attempts[0].scoreAuto, null);
  assert.equal(inProgress.attempts[0].pendingCount, 0);
  assert.ok(
    !inProgress.attempts.some(({ attemptId }) => attemptId === onlyOpened.id),
  );
  assert.equal((await cards({ courseId })).total, 4);
  const manualQueue = await pending({ courseId });
  assert.deepEqual(
    manualQueue.marks.map(({ attemptId, questionId, answerText }) => [
      attemptId,
      questionId,
      answerText,
    ]),
    [[manual.id, manualQuestion, "先画示意图"]],
  );
  const manualCard = await cards({
    assignmentId: manualAssignment,
    status: "submitted",
  });
  assert.equal(manualCard.total, 1);
  assert.equal(manualCard.attempts[0].pendingCount, 1);
  assert.deepEqual(await pending({ courseId }, otherTeacher), { marks: [] });
  assert.deepEqual(await cards({ courseId }, otherTeacher), {
    attempts: [],
    total: 0,
  });
  await status(
    await call(pathOf("pending-marks", { courseId }), ownerCookie),
    401,
  );

  async function openTeacherTool(cookie) {
    const created = await status(
      await call("/api/teacher/api-token", cookie, "POST"),
      200,
    );
    return connectMcpClientViaApp(
      app,
      "/mcp",
      (await created.json()).data.token,
      "m04-workbench",
    );
  }
  const client = await openTeacherTool(teacher);
  try {
    const args = { ...graded, studentId: world.studentId };
    const first = await callToolJson(client, "query_student_attempts", args);
    const next = await callToolJson(client, "query_student_attempts", {
      ...args,
      cursor: "1",
    });
    const facts = ({ data }) =>
      data.attempts.map((card) => [
        card.attemptId,
        card.scoreAuto,
        card.scoreFinal,
        card.correctCount,
        card.wrongCount,
        card.pendingCount,
        card.submittedCount,
      ]);
    console.log(
      JSON.stringify({ toolFirst: facts(first), toolNext: facts(next) }),
    );
    for (const [result, attempt, cursor] of [
      [first, late, "1"],
      [next, early, null],
    ]) {
      assert.equal(result.isError, false);
      assert.equal(result.data.total, 2);
      assert.equal(result.data.nextCursor, cursor);
      assert.deepEqual(facts(result), [[attempt.id, 50, 50, 1, 1, 0, 2]]);
    }
  } finally {
    await client.close();
  }
  const outsideTool = await openTeacherTool(otherTeacher);
  try {
    const denied = await callToolJson(outsideTool, "query_student_attempts", {
      studentId: world.studentId,
      courseId,
    });
    assert.equal(denied.isError, true);
    assert.equal(denied.data.error, "STUDENT_NOT_FOUND");
  } finally {
    await outsideTool.close();
  }

  const kernelPath = join(dataDir, "learning-kernel.sqlite");
  const offlinePath = join(dataDir, "learning-kernel-offline.sqlite");
  renameSync(kernelPath, offlinePath);
  try {
    assert.deepEqual(
      await pending({ assignmentId: manualAssignment }),
      manualQueue,
    );
    assert.deepEqual(
      cardFacts(
        await cards({ assignmentId: manualAssignment, status: "submitted" }),
      ),
      cardFacts(manualCard),
    );
    await status(
      await call(pathOf("pending-marks", { assignmentId: firstAssignment })),
      503,
    );
    await status(await call(pathOf("attempts", graded)), 503);
    assert.equal((await cards({ ...graded, offset: 2 })).total, 2);
    assert.deepEqual(await pending({ courseId }, otherTeacher), { marks: [] });
  } finally {
    renameSync(offlinePath, kernelPath);
  }
  assert.deepEqual(host(late.id), {
    status: "graded",
    score_auto: null,
    score_final: null,
  });
  assert.deepEqual(
    dbRead((db) =>
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM responses WHERE attempt_id IN (?, ?) AND (answer_json IS NOT NULL OR auto_correct IS NOT NULL OR final_correct IS NOT NULL)",
        )
        .get(early.id, late.id),
    ),
    { n: 0 },
  );
  console.log(
    "教师工作台两处首读、卡片分页、传统待批、隔离与内核离线范围均通过",
  );
} finally {
  await service.close();
}
