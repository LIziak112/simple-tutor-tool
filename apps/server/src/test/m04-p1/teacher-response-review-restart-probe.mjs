import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { attemptStartOkSchema, questionReviewOkSchema } from "@tutor/contract";
import { createDb } from "../../db/client.ts";
import { callToolJson, connectMcpClientViaApp } from "../mcp-test-utils.ts";
import { extractSessionToken } from "../note-world.ts";
import { submitAttemptRequest } from "../submit-revisions.ts";
import {
  assignFixture,
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "./product-fixture.ts";
import { createRealServiceFixture } from "./real-service-fixture.mjs";

const service = await createRealServiceFixture();
const { app, dataDir, boot, stop } = service;
const first = "m04-p0-q1";
const second = "m04-p0-q2";
function withProduct(f) {
  const db = createDb(join(dataDir, "tutor.db"));
  try {
    return f(db.$client);
  } finally {
    db.$client.close();
  }
}
async function status(response, expected, code) {
  assert.equal(response.status, expected, await response.clone().text());
  if (code !== undefined) {
    const body = await response.json();
    assert.equal(body.error, code);
    assert.ok(!Object.hasOwn(body, "data"));
  }
  return response;
}
const answers = (data) =>
  data.responses
    .map((row) => [
      row.questionId,
      row.answerRevision,
      row.answered,
      row.finalCorrect,
      row.changeCount,
    ])
    .sort((a, b) => a[0].localeCompare(b[0]));

try {
  const firstPid = await boot(true);
  const world = await setupAssignment(app);
  const { teacher, ownerCookie, otherCookie } = world;
  const call = (path, cookie, method = "GET", body) =>
    app.request(path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function open(assignmentId, cookie = ownerCookie) {
    const response = await status(
      await postAssignment(app, assignmentId, cookie),
      200,
    );
    return attemptStartOkSchema.parse(await response.json()).data.id;
  }
  async function save(id, question, index, cookie = ownerCookie) {
    await status(
      await call(
        `/api/student/attempts/${id}/answers/${question}`,
        cookie,
        "PUT",
        {
          answer: { kind: "choice", index },
        },
      ),
      200,
    );
  }
  async function complete(
    id,
    firstChoice = 1,
    cookie = ownerCookie,
    interrupted = false,
  ) {
    await save(id, first, firstChoice, cookie);
    await save(id, second, 0, cookie);
    await status(
      await submitAttemptRequest(app, cookie, id),
      interrupted ? 500 : 200,
    );
  }
  const old = await open(world.assignmentId);
  await complete(old);
  const extraLegacy = await assignFixture(
    app,
    teacher,
    world.unitId,
    world.studentId,
  );
  const older = await open(extraLegacy);
  await complete(older, 0);
  const kernelAssignment = await assignKernelFixture(app, world);
  const candidate = await open(kernelAssignment);
  const otherCompleted = await open(kernelAssignment, otherCookie);
  await status(
    await call(
      `/api/student/attempts/${candidate}/flags/${first}`,
      ownerCookie,
      "PUT",
      {
        flag: "unsure",
      },
    ),
    200,
  );
  const draftAssignment = await assignKernelFixture(app, world);
  const draft = await open(draftAssignment);
  withProduct((db) =>
    db.exec(`
    CREATE TRIGGER interrupt_query_draft BEFORE UPDATE OF activated_at ON attempts
    BEGIN SELECT RAISE(ABORT, 'interrupted draft projection'); END
  `),
  );
  try {
    await status(
      await call(
        `/api/student/attempts/${draft}/answers/${second}`,
        ownerCookie,
        "PUT",
        {
          answer: { kind: "choice", index: 0 },
        },
      ),
      500,
    );
  } finally {
    withProduct((db) => db.exec("DROP TRIGGER interrupt_query_draft"));
  }
  const beforeConfirmation = new Date().toISOString();
  withProduct((db) =>
    db.exec(`
    CREATE TRIGGER interrupt_teacher_response_review BEFORE UPDATE OF status ON attempts
    WHEN NEW.status = 'graded'
    BEGIN SELECT RAISE(ABORT, 'interrupted teacher response review'); END
  `),
  );
  try {
    await complete(candidate, 1, ownerCookie, true);
    await complete(otherCompleted, 1, otherCookie, true);
  } finally {
    withProduct((db) =>
      db.exec("DROP TRIGGER interrupt_teacher_response_review"),
    );
  }
  const host = (id) =>
    withProduct((db) =>
      db
        .prepare(
          "SELECT status,submitted_at,activated_at,score_auto,score_final FROM attempts WHERE id=?",
        )
        .get(id),
    );
  assert.equal(host(candidate).status, "draft");
  assert.equal(host(otherCompleted).status, "draft");
  assert.equal(host(draft).activated_at, null);

  const outside = await status(
    await call("/api/public/teacher/register", "", "POST", {
      loginName: "逐题教师乙",
      password: "other-teacher-8",
    }),
    200,
  );
  const otherTeacher = `tutor_session=${extractSessionToken(outside)}`;
  await stop();
  const secondPid = await boot(false);
  assert.notEqual(firstPid, secondPid);

  function webPath(studentId, args) {
    return `/api/teacher/students/${studentId}/question-review?${new URLSearchParams(args)}`;
  }
  async function web(args) {
    const response = await status(
      await call(webPath(world.studentId, args), teacher),
      200,
    );
    return questionReviewOkSchema.parse(await response.json()).data;
  }
  const clients = [];
  async function sdk(cookie) {
    const tokenResponse = await status(
      await call("/api/teacher/api-token", cookie, "POST"),
      200,
    );
    const client = await connectMcpClientViaApp(
      app,
      "/mcp",
      (await tokenResponse.json()).data.token,
      "response-review-acceptance",
    );
    clients.push(client);
    return (args) => callToolJson(client, "query_student_responses", args);
  }
  try {
    const invoke = await sdk(teacher);
    const query = async (args) => {
      const tool = await invoke({ studentId: world.studentId, ...args });
      assert.equal(tool.isError, false, JSON.stringify(tool.data));
      return tool.data;
    };
    // Web 与 SDK 分别在两个不同学生的中断卷上担当首次读取。
    const wrong = await web({ kind: "wrong", from: beforeConfirmation });
    const afterWeb = host(candidate);
    const afterOther = host(otherCompleted);
    const alternate = await query({
      studentId: world.otherStudentId,
      attemptIds: [otherCompleted],
    });
    const observed = await query({ attemptIds: [candidate] });
    const oldRows = await query({ attemptIds: [old] });
    console.log(
      JSON.stringify({
        firstPid,
        secondPid,
        web: wrong.questions.map(({ questionId, finalCorrect, redoCount }) => [
          questionId,
          finalCorrect,
          redoCount,
        ]),
        legacy: answers(oldRows),
        candidate: answers(observed),
        sdkFirstRead: answers(alternate),
        hostAfterWeb: afterWeb.status,
        otherAfterWeb: afterOther.status,
      }),
    );
    const truth = [
      [first, 1, true, true, 1],
      [second, 1, true, false, 1],
    ];
    assert.equal(afterWeb.status, "graded");
    assert.equal(afterOther.status, "draft");
    assert.equal(host(otherCompleted).status, "graded");
    assert.deepEqual(answers(alternate), truth);
    assert.deepEqual(answers(observed), truth);
    assert.deepEqual(answers(oldRows), truth);
    assert.equal(wrong.total, 1);
    assert.deepEqual(
      wrong.questions.map((row) => ({
        q: row.questionId,
        attempt: row.attemptId,
        source: row.effectiveVerdict,
        redo: row.redoCount,
        lastAt: row.lastAt,
      })),
      [
        {
          q: second,
          attempt: candidate,
          source: { source: "auto", value: false },
          redo: 0,
          lastAt: afterWeb.submitted_at,
        },
      ],
    );

    const at = afterWeb.submitted_at;
    assert.ok(observed.responses.every((row) => row.submittedAt === at));
    const atExact = await query({
      attemptIds: [candidate],
      from: at,
      to: at,
      correct: "false",
      minChangeCount: 1,
      answered: true,
    });
    assert.deepEqual(answers(atExact), [truth[1]]);
    const mixed = {
      attemptIds: [old, older, candidate],
      correct: "false",
      limit: 1,
    };
    const pages = [];
    let cursor;
    do {
      const page = await query({
        ...mixed,
        ...(cursor === undefined ? {} : { cursor }),
      });
      assert.equal(page.total, 4);
      assert.equal(page.responses.length, 1);
      pages.push(...page.responses);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    assert.equal(new Set(pages.map(({ revisionId }) => revisionId)).size, 4);
    assert.equal(pages.at(-1).attemptId, candidate);
    const webFirst = await web({ kind: "wrong", limit: 1 });
    const webSecond = await web({
      kind: "wrong",
      limit: 1,
      cursor: webFirst.nextCursor,
    });
    assert.equal(webFirst.total, 2);
    assert.equal(webSecond.total, 2);
    assert.equal(webFirst.questions[0].questionId, second);
    assert.equal(webFirst.questions[0].redoCount, 2);
    assert.equal(webSecond.questions[0].questionId, first);
    assert.equal(webSecond.questions[0].redoCount, 0);

    assert.ok(
      observed.responses.every(
        (row) =>
          !Object.hasOwn(row, "answer") &&
          !Object.hasOwn(row, "options") &&
          !Object.hasOwn(row, "solutionMd"),
      ),
    );
    const full = await query({
      attemptIds: [candidate],
      fields: "full",
      questionId: second,
    });
    assert.equal(full.total, 1);
    assert.equal(full.responses[0].answer.kind, "choice");
    assert.ok(full.responses[0].options.length >= 2);
    assert.ok(Object.hasOwn(full.responses[0], "solutionMd"));
    assert.ok(!Object.hasOwn(wrong.questions[0], "answer"));
    assert.deepEqual(
      (await web({ kind: "unsure" })).questions.map(
        ({ questionId }) => questionId,
      ),
      [first],
    );
    assert.equal(
      (await query({ attemptIds: [candidate], flaggedUnsure: true })).total,
      1,
    );
    await status(
      await call(
        `/api/student/attempts/${candidate}/notes/${second}/corrections`,
        ownerCookie,
        "POST",
        {
          copyFromOriginal: false,
        },
      ),
      201,
    );
    assert.deepEqual(
      (await web({ kind: "corrected" })).questions.map(
        ({ questionId }) => questionId,
      ),
      [second],
    );
    assert.equal(
      (await query({ attemptIds: [candidate], hasCorrection: true })).total,
      1,
    );
    assert.equal((await query({ attemptIds: [draft] })).total, 0);
    const live = await query({
      attemptIds: [draft],
      includeUnsubmitted: true,
      questionId: second,
      minChangeCount: 1,
    });
    assert.deepEqual(answers(live), [[second, 1, false, null, 1]]);
    assert.equal(live.responses[0].attemptStatus, "draft");
    assert.equal(live.responses[0].pending, true);
    assert.equal(live.responses[0].submittedAt, null);
    assert.ok(host(draft).activated_at);
    assert.equal(
      (
        await query({
          studentId: world.otherStudentId,
          attemptIds: [candidate],
        })
      ).total,
      0,
    );

    await status(
      await call(webPath(world.studentId, { kind: "wrong" }), otherTeacher),
      404,
      "STUDENT_NOT_FOUND",
    );
    const outsider = await sdk(otherTeacher);
    const rejected = await outsider({ studentId: world.studentId });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.data.error, "STUDENT_NOT_FOUND");

    const kernelPath = join(dataDir, "learning-kernel.sqlite");
    renameSync(kernelPath, `${kernelPath}.held`);
    try {
      await status(
        await call(webPath(world.studentId, { kind: "wrong" }), teacher),
        503,
        "KERNEL_ATTEMPT_UNAVAILABLE",
      );
      const unavailable = await invoke({
        studentId: world.studentId,
        attemptIds: [candidate],
      });
      assert.equal(unavailable.isError, true);
      assert.equal(unavailable.data.error, "KERNEL_ATTEMPT_UNAVAILABLE");
      assert.deepEqual(answers(await query({ attemptIds: [old] })), truth);
      assert.equal(
        (await query({ attemptIds: [candidate], questionId: "外部题目" }))
          .total,
        0,
      );
      assert.equal(
        (
          await query({
            attemptIds: [candidate],
            to: "2000-01-01T00:00:00.000Z",
          })
        ).total,
        0,
      );
    } finally {
      renameSync(`${kernelPath}.held`, kernelPath);
    }
    const raw = withProduct((db) =>
      db
        .prepare(
          "SELECT count(*) AS n FROM responses WHERE attempt_id IN (?, ?, ?) AND (answer_json IS NOT NULL OR answer_revision <> 0 OR auto_correct IS NOT NULL OR final_correct IS NOT NULL)",
        )
        .get(candidate, otherCompleted, draft),
    );
    assert.deepEqual(raw, { n: 0 });
    assert.equal(host(candidate).score_final, null);
    console.log("两进程逐题检索、混合分页、错题与存疑、应用公开范围均通过");
  } finally {
    for (const client of clients) await client.close();
  }
} finally {
  await service.close();
}
