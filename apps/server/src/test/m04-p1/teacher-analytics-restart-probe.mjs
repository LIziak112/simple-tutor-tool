import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import {
  analyticsOverviewOkSchema,
  analyticsQuestionsDataSchema,
  analyticsQuestionsOkSchema,
  analyticsStudentOkSchema,
  assignmentCreateOkSchema,
  attemptStartOkSchema,
} from "@tutor/contract";
import { createDb } from "../../db/client.ts";
import { callToolJson, connectMcpClientViaApp } from "../mcp-test-utils.ts";
import { extractSessionToken } from "../note-world.ts";
import { submitAttemptRequest } from "../submit-revisions.ts";
import { postAssignment, setupAssignment } from "./product-fixture.ts";
import { createRealServiceFixture } from "./real-service-fixture.mjs";

// 默认仍由 HTTP 首读；指定此参数时验证同一中断场景由实际教师 SDK 首读。
const useQuestionStats = process.argv.includes("--question-stats");
const service = await createRealServiceFixture();
const { app, dataDir, boot, stop } = service;
const dbRead = (f) => {
  const db = createDb(join(dataDir, "tutor.db"));
  try {
    return f(db.$client);
  } finally {
    db.$client.close();
  }
};
async function status(response, expected) {
  assert.equal(response.status, expected, await response.clone().text());
  return response;
}

try {
  const firstPid = await boot(true);
  const world = await setupAssignment(app);
  const { teacher, ownerCookie } = world;
  const call = (path, cookie = teacher, method = "GET", body) =>
    app.request(path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const makeCourse = async (title) => {
    const result = await status(
      await call("/api/teacher/courses", teacher, "POST", { title }),
      201,
    );
    return (await result.json()).data.id;
  };
  const kernelCourse = await makeCourse("学情内核作业");
  const independentCourse = await makeCourse("学情隔离旧卷");
  for (const course of [kernelCourse, independentCourse]) {
    await status(
      await call(`/api/teacher/courses/${course}/members`, teacher, "POST", {
        studentIds: [world.studentId, world.otherStudentId],
      }),
      200,
    );
  }
  const assign = async (courseId, kernel) => {
    const result = await status(
      await call("/api/teacher/assignments", teacher, "POST", {
        title: kernel ? "内核两题" : "旧侧两题",
        courseId,
        unitIds: [world.unitId],
        studentIds: [world.studentId],
        dueAt: "2099-01-01T00:00:00.000Z",
        answerRelease: "after_due",
        allowRedo: false,
        ...(kernel ? { executionBackend: "kernel" } : {}),
      }),
      201,
    );
    return assignmentCreateOkSchema.parse(await result.json()).data
      .assignments[0].id;
  };
  const fill = async (assignment) => {
    const opened = await status(
      await postAssignment(app, assignment, ownerCookie),
      200,
    );
    const { id } = attemptStartOkSchema.parse(await opened.json()).data;
    for (const [question, index] of [
      ["m04-p0-q1", 1],
      ["m04-p0-q2", 0],
    ]) {
      await status(
        await call(
          `/api/student/attempts/${id}/answers/${question}`,
          ownerCookie,
          "PUT",
          {
            answer: { kind: "choice", index },
          },
        ),
        200,
      );
    }
    return id;
  };

  const legacy = await fill(await assign(independentCourse, false));
  await status(await submitAttemptRequest(app, ownerCookie, legacy), 200);
  const candidate = await fill(await assign(kernelCourse, true));
  dbRead((db) =>
    db.exec(`
    CREATE TRIGGER interrupt_analytics_projection BEFORE UPDATE OF status ON attempts
    WHEN NEW.status = 'graded'
    BEGIN SELECT RAISE(ABORT, 'interrupted analytics projection'); END
  `),
  );
  try {
    await status(await submitAttemptRequest(app, ownerCookie, candidate), 500);
  } finally {
    dbRead((db) => db.exec("DROP TRIGGER interrupt_analytics_projection"));
  }
  const host = () =>
    dbRead((db) =>
      db
        .prepare(
          "SELECT status, score_auto, score_final FROM attempts WHERE id = ?",
        )
        .get(candidate),
    );
  assert.equal(host().status, "draft");
  const outside = await status(
    await call("/api/public/teacher/register", "", "POST", {
      loginName: "教师域外",
      password: "other-teacher-8",
    }),
    200,
  );
  const otherTeacher = `tutor_session=${extractSessionToken(outside)}`;

  await stop();
  const secondPid = await boot(false);
  assert.notEqual(firstPid, secondPid);
  const endpoint = (view, course, days = "all") =>
    `/api/teacher/analytics/${view}?${new URLSearchParams({ courseId: course, days })}`;
  async function load(view, schema, course, cookie = teacher, days) {
    const response = await status(
      await call(endpoint(view, course, days), cookie),
      200,
    );
    return schema.parse(await response.json()).data;
  }
  const questionView = (course, cookie, days) =>
    load("questions", analyticsQuestionsOkSchema, course, cookie, days);
  const overview = (course, cookie, days) =>
    load("overview", analyticsOverviewOkSchema, course, cookie, days);
  const student = (course, id = world.studentId, days) =>
    load(`student/${id}`, analyticsStudentOkSchema, course, teacher, days);

  const answers = ({ questions }) =>
    questions.map(
      ({
        questionId,
        judgedCount,
        correctCount,
        correctRate,
        wrongAnswers,
      }) => ({
        questionId,
        judgedCount,
        correctCount,
        correctRate,
        wrongAnswers,
      }),
    );
  async function tool(cookie, query) {
    const issued = await status(
      await call("/api/teacher/api-token", cookie, "POST"),
      200,
    );
    const client = await connectMcpClientViaApp(
      app,
      "/mcp",
      (await issued.json()).data.token,
      "question-stats-acceptance",
    );
    try {
      return await callToolJson(client, "get_question_stats", query);
    } finally {
      await client.close();
    }
  }
  async function stats(
    courseId,
    cookie = teacher,
    days = "all",
    focusDays = 14,
  ) {
    const result = await tool(cookie, { courseId, days, focusDays });
    assert.equal(result.isError, false, JSON.stringify(result.data));
    return analyticsQuestionsDataSchema.parse(result.data);
  }

  const firstStats = useQuestionStats ? await stats(kernelCourse) : undefined;
  if (firstStats !== undefined) {
    const beforeHttp = host();
    const oldStats = await stats(independentCourse);
    console.log(
      JSON.stringify({
        sdkFirstRead: answers(firstStats),
        legacy: answers(oldStats),
        beforeHttp,
      }),
    );
    assert.deepEqual(answers(firstStats), answers(oldStats));
    assert.equal(beforeHttp.status, "graded");
    assert.equal(firstStats.range.days, "all");
    assert.equal(firstStats.range.from, null);
    assert.deepEqual((await stats(kernelCourse, otherTeacher)).questions, []);
  }
  const question = await questionView(kernelCourse);
  const kOverview = await overview(kernelCourse);
  const kStudent = await student(kernelCourse);
  const old = await overview(independentCourse);
  if (firstStats !== undefined) {
    assert.deepEqual(firstStats.questions, question.questions);
    const recent = await stats(kernelCourse, teacher, 1, 1);
    const recentHttp = await questionView(kernelCourse, teacher, "1");
    assert.deepEqual(recent.questions, recentHttp.questions);
    assert.equal(recent.range.days, 1);
    assert.equal(
      Date.parse(recent.range.to) - Date.parse(recent.range.from),
      86_400_000,
    );
  }
  console.log(
    JSON.stringify({
      firstPid,
      secondPid,
      question: answers(question),
      overview: kOverview.overall,
      student: kStudent.totals,
      old: old.overall,
      host: host(),
    }),
  );
  const expected = {
    judgedCount: 2,
    correctCount: 1,
    correctRate: 0.5,
    selfJudgedCount: 0,
  };
  assert.deepEqual(old.overall, expected);
  assert.deepEqual(kOverview.overall, expected);
  assert.equal(kOverview.pendingMarkCount, 0);
  assert.deepEqual(kStudent.totals, { ...expected, pendingCount: 0 });
  assert.deepEqual(
    answers(question),
    answers(await questionView(independentCourse)),
  );
  assert.deepEqual(
    answers(question).find(({ questionId }) => questionId === "m04-p0-q2")
      .wrongAnswers,
    [{ answerText: "A", count: 1 }],
  );
  assert.deepEqual(
    answers(await questionView(kernelCourse, teacher, "1")),
    answers(question),
  );
  assert.deepEqual(
    (await overview(kernelCourse, teacher, "1")).overall,
    expected,
  );
  assert.deepEqual(
    (await questionView(kernelCourse, otherTeacher)).questions,
    [],
  );
  assert.equal(
    (await overview(kernelCourse, otherTeacher)).overall.judgedCount,
    0,
  );
  await status(
    await call(
      endpoint(`student/${world.studentId}`, kernelCourse),
      otherTeacher,
    ),
    404,
  );
  assert.equal(
    (await student(kernelCourse, world.otherStudentId)).totals.judgedCount,
    0,
  );
  await status(
    await call(endpoint("questions", kernelCourse), ownerCookie),
    401,
  );

  const laterClock = `data:text/javascript,${encodeURIComponent(`
    const offset = 3 * 86_400_000;
    globalThis.Date = new Proxy(Date, {
      construct: (Clock, args) => Reflect.construct(Clock, args.length ? args : [Clock.now() + offset]),
      apply: (Clock) => new Clock(Clock.now() + offset).toString(),
      get: (Clock, key, receiver) => key === "now" ? () => Clock.now() + offset : Reflect.get(Clock, key, receiver),
    });
  `)}`;
  const path = join(dataDir, "learning-kernel.sqlite");
  const offline = join(dataDir, "learning-kernel-offline.sqlite");
  renameSync(path, offline);
  try {
    for (const view of [
      "questions",
      "overview",
      `student/${world.studentId}`,
    ]) {
      const unavailable = await status(
        await call(endpoint(view, kernelCourse)),
        503,
      );
      const body = await unavailable.json();
      assert.equal(body.error, "KERNEL_ATTEMPT_UNAVAILABLE");
      assert.ok(!Object.hasOwn(body, "data"));
    }
    assert.deepEqual((await overview(independentCourse)).overall, expected);
    assert.deepEqual(
      answers(await questionView(independentCourse)),
      answers(question),
    );
    assert.equal(
      (await student(kernelCourse, world.otherStudentId)).totals.judgedCount,
      0,
    );
    assert.deepEqual(
      (await questionView(kernelCourse, otherTeacher)).questions,
      [],
    );
    await stop();
    const agedPid = await boot(false, { preloads: [laterClock] });
    assert.notEqual(agedPid, secondPid);
    assert.deepEqual(
      (await questionView(kernelCourse, teacher, "1")).questions,
      [],
    );
    await status(await call(endpoint("questions", kernelCourse, "all")), 503);
    if (useQuestionStats) {
      const unavailable = await tool(teacher, {
        courseId: kernelCourse,
        days: "all",
      });
      assert.equal(unavailable.isError, true);
      assert.equal(unavailable.data.error, "KERNEL_ATTEMPT_UNAVAILABLE");
      assert.ok(!Object.hasOwn(unavailable.data, "questions"));
      assert.deepEqual((await stats(kernelCourse, teacher, 1)).questions, []);
      assert.deepEqual((await stats(kernelCourse, otherTeacher)).questions, []);
      assert.deepEqual(
        answers(await stats(independentCourse)),
        answers(question),
      );
    }
    await status(await call(endpoint("overview", kernelCourse, "1")), 503);
  } finally {
    renameSync(offline, path);
  }
  const agedOverview = await overview(kernelCourse, teacher, "1");
  assert.equal(agedOverview.overall.judgedCount, 0);
  assert.equal(
    agedOverview.matrix.cells.find(({ attemptId }) => attemptId === candidate)
      .status,
    "graded",
  );
  assert.equal(
    agedOverview.focus.points.find(
      ({ knowledge }) => knowledge === "合成整数乘法",
    ).wrongCount,
    1,
  );
  assert.equal(
    (await student(kernelCourse, world.studentId, "1")).totals.judgedCount,
    0,
  );
  assert.deepEqual(
    answers(await questionView(kernelCourse)),
    answers(question),
  );
  assert.deepEqual(host(), {
    status: "graded",
    score_auto: null,
    score_final: null,
  });
  assert.deepEqual(
    dbRead((db) =>
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM responses WHERE attempt_id=? AND (answer_json IS NOT NULL OR auto_correct IS NOT NULL OR final_correct IS NOT NULL)",
        )
        .get(candidate),
    ),
    { n: 0 },
  );
  console.log("教师三学情入口的重启恢复、筛选、域隔离和离线范围均通过");
} finally {
  await service.close();
}
