import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import {
  analyticsOverviewOkSchema,
  analyticsQuestionsOkSchema,
  analyticsStudentOkSchema,
  assignmentCreateOkSchema,
  attemptStartOkSchema,
} from "@tutor/contract";
import { createDb } from "../../db/client.ts";
import { extractSessionToken } from "../note-world.ts";
import { submitAttemptRequest } from "../submit-revisions.ts";
import { postAssignment, setupAssignment } from "./product-fixture.ts";
import { createRealServiceFixture } from "./real-service-fixture.mjs";

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

  const question = await questionView(kernelCourse);
  const kOverview = await overview(kernelCourse);
  const kStudent = await student(kernelCourse);
  const old = await overview(independentCourse);
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
