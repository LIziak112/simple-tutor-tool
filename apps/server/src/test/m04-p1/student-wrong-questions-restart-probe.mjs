import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import {
  attemptDraftOkSchema,
  attemptStartOkSchema,
  wrongPracticeOkSchema,
  wrongQuestionsOkSchema,
} from "@tutor/contract";
import { createDb } from "../../db/client.ts";
import { assertNoLeak } from "../assert-no-leak.ts";
import { callToolJson, connectMcpClientViaApp } from "../mcp-test-utils.ts";
import { submitAttemptRequest } from "../submit-revisions.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "./product-fixture.ts";
import { createRealServiceFixture } from "./real-service-fixture.mjs";

const service = await createRealServiceFixture();
const { app, dataDir, boot, stop } = service;
const q1 = "m04-p0-q1";
const q2 = "m04-p0-q2";
const courseQuestion = "m04-p4-course-choice";
const future = "2099-01-01T00:00:00.000Z";
const past = "2000-01-01T00:00:00.000Z";
const forbidden = [
  "keyRef",
  "scoringKey",
  "acceptedChoice",
  "studentId",
  "responseId",
  "operationId",
];
const dbRead = (operation) => {
  const db = createDb(join(dataDir, "tutor.db"));
  try {
    return operation(db.$client);
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
  const { ownerCookie, otherCookie, teacher } = world;
  const call = (path, cookie = ownerCookie, method = "GET", body) =>
    app.request(path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const list = async (query = "", cookie = ownerCookie) => {
    const response = await status(
      await call(`/api/student/wrong-questions?${query}`, cookie),
      200,
    );
    const body = await response.json();
    assertNoLeak(body, { allow: ["answers", "solutionMd"], forbid: forbidden });
    return wrongQuestionsOkSchema.parse(body).data.questions;
  };
  const open = async (assignment, selections) => {
    const response = await status(
      await postAssignment(app, assignment, ownerCookie),
      200,
    );
    const { id } = attemptStartOkSchema.parse(await response.json()).data;
    for (const [question, index] of selections) {
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

  const legacy = await open(world.assignmentId, [[q1, 0]]);
  await status(await submitAttemptRequest(app, ownerCookie, legacy), 200);
  const course = await status(
    await call("/api/teacher/courses", teacher, "POST", {
      title: "独立课程历史",
    }),
    201,
  );
  const courseId = (await course.json()).data.id;
  const markdown = [
    "---",
    "kind: practice",
    "unit: M04-P4 独立练习",
    "topic: 合成算式",
    "---",
    "",
    `::::question{id=${courseQuestion} type=choice difficulty=1 knowledge="合成独立考点"}`,
    "1 + 1 等于多少？",
    "",
    "- [ ] 1",
    "- [x] 2",
    "::::",
  ].join("\n");
  const imported = await status(
    await call("/api/teacher/import/commit", teacher, "POST", {
      courseId,
      markdown,
      filename: "P4-独立练习.md",
    }),
    200,
  );
  const { id: unitId } = (await imported.json()).data.units[0];
  const courseDetail = await status(
    await call(`/api/teacher/courses/${courseId}`, teacher),
    200,
  );
  const { id: item } = (await courseDetail.json()).data.items.find(
    ({ refId }) => refId === unitId,
  );
  await status(
    await call(`/api/teacher/course-items/${item}`, teacher, "PATCH", {
      visible: true,
    }),
    200,
  );
  await status(
    await call(`/api/teacher/courses/${courseId}/members`, teacher, "POST", {
      studentIds: [world.studentId],
    }),
    200,
  );
  const courseStart = await status(
    await call(
      `/api/student/courses/${courseId}/units/${encodeURIComponent(unitId)}/attempts`,
      ownerCookie,
      "POST",
    ),
    201,
  );
  const { id: courseAttempt } = (await courseStart.json()).data;
  await status(
    await call(
      `/api/student/attempts/${courseAttempt}/answers/${courseQuestion}`,
      ownerCookie,
      "PUT",
      {
        answer: { kind: "choice", index: 0 },
      },
    ),
    200,
  );
  await status(
    await submitAttemptRequest(app, ownerCookie, courseAttempt),
    200,
  );
  const legacyCards = await list();
  assert.deepEqual(
    legacyCards.map(({ questionId }) => questionId),
    [courseQuestion, q1],
  );

  const assignment = await assignKernelFixture(app, world, {
    dueAt: future,
    answerRelease: "after_due",
  });
  const candidate = await open(assignment, [
    [q1, 1],
    [q2, 0],
  ]);
  const questionUrl = `/api/teacher/questions/${q2}`;
  const current = await status(await call(questionUrl, teacher), 200);
  const { sourceMd, version: frozenVersion } = (await current.json()).data;
  const edited = await status(
    await call(questionUrl, teacher, "PUT", {
      sourceMd: sourceMd
        .replace("2 × 4 等于多少？", "2 × 3 等于多少？")
        .replace("- [ ] 6", "- [x] 6")
        .replace("- [x] 8", "- [ ] 8")
        .replace("合成整数乘法", "当前修订考点"),
    }),
    200,
  );
  assert.equal((await edited.json()).data.version, frozenVersion + 1);
  dbRead((db) =>
    db.exec(`
    CREATE TRIGGER interrupt_wrong_projection BEFORE UPDATE OF status ON attempts
    WHEN NEW.status = 'graded'
    BEGIN SELECT RAISE(ABORT, 'interrupted wrong projection'); END
  `),
  );
  try {
    await status(await submitAttemptRequest(app, ownerCookie, candidate), 500);
  } finally {
    dbRead((db) => db.exec("DROP TRIGGER interrupt_wrong_projection"));
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

  await stop();
  const secondPid = await boot(false);
  assert.notEqual(firstPid, secondPid);
  assert.deepEqual(await list(), legacyCards);
  assert.deepEqual(await list("", otherCookie), []);
  await status(
    await call(`/api/teacher/assignments/${assignment}`, teacher, "PATCH", {
      dueAt: past,
    }),
    200,
  );
  const released = await list("includeResolved=true");
  console.log(
    JSON.stringify({
      firstPid,
      secondPid,
      legacyCards,
      released,
      host: host(),
      legacy,
      candidate,
    }),
  );
  assert.deepEqual(
    released.map(({ questionId }) => questionId),
    [q1, q2, courseQuestion],
  );
  const [resolved, wrong] = released;
  assert.equal(resolved.resolved, true);
  assert.deepEqual(
    resolved.rounds.map(({ attemptId, correct }) => [attemptId, correct]),
    [
      [legacy, false],
      [candidate, true],
    ],
  );
  assert.deepEqual(
    wrong.rounds.map(({ attemptId, correct, answered }) => [
      attemptId,
      correct,
      answered,
    ]),
    [
      [legacy, false, false],
      [candidate, false, true],
    ],
  );
  assert.equal(wrong.pendingCount, 0);
  assert.equal(wrong.wrongCount, 1);
  assert.deepEqual(
    (await list()).map(({ questionId }) => questionId),
    [q2, courseQuestion],
  );
  assert.deepEqual(await list("includeResolved=true"), released);
  assert.deepEqual(await list("", otherCookie), []);
  assert.deepEqual(
    await list(new URLSearchParams({ knowledge: "合成整数乘法" })),
    [wrong],
  );
  assert.deepEqual(host(), {
    status: "graded",
    score_auto: null,
    score_final: null,
  });

  assert.equal(wrong.stemMd, "2 × 4 等于多少？");
  assert.deepEqual(wrong.answers, { kind: "choice", index: 2 });
  assert.deepEqual(
    await list(new URLSearchParams({ knowledge: "当前修订考点" })),
    [],
  );
  const practice = (questionId, cookie = ownerCookie) =>
    call("/api/student/wrong-practice", cookie, "POST", {
      questionIds: [questionId],
    });
  const started = await status(await practice(q2), 201);
  const practiceBody = await started.json();
  assertNoLeak(practiceBody, { forbid: forbidden });
  const { id: practiceId } = wrongPracticeOkSchema.parse(practiceBody).data;
  const detail = await status(
    await call(`/api/student/attempts/${practiceId}`),
    200,
  );
  const detailBody = await detail.json();
  assertNoLeak(detailBody, { forbid: forbidden });
  const [frozen] = attemptDraftOkSchema
    .parse(detailBody)
    .data.units.flatMap(({ questions }) => questions);
  assert.equal(frozen.id, q2);
  assert.equal(frozen.questionVersion, frozenVersion);
  assert.equal(frozen.stemMd, wrong.stemMd);
  await status(await practice(q2, otherCookie), 400);

  const connection = await status(
    await call("/api/student/ai/connections", ownerCookie, "POST", {
      channel: "mcp",
    }),
    201,
  );
  const { token } = (await connection.json()).data.credential;
  const client = await connectMcpClientViaApp(
    app,
    "/mcp/student",
    token,
    "m04-wrong-rounds",
  );
  try {
    async function catalog(args) {
      const { data, isError } = await callToolJson(
        client,
        "list_my_wrong_questions",
        args,
      );
      assert.equal(isError, false);
      assertNoLeak(data, { forbid: [...forbidden, "answerText"] });
      return data;
    }
    const toolPractice = await callToolJson(client, "create_wrong_practice", {
      questionIds: [q2],
    });
    assert.equal(toolPractice.isError, false);
    assert.equal(toolPractice.data.includedCount, 1);
    assertNoLeak(toolPractice.data, { forbid: forbidden });
    const first = await catalog({ includeConquered: true, limit: 1 });
    const next = await catalog({ includeConquered: true, limit: 1, offset: 1 });
    assert.equal(first.total, 3);
    assert.equal(next.total, 3);
    assert.equal(first.questions[0].questionId, q1);
    assert.equal(first.questions[0].roundCount, 2);
    assert.equal(next.questions[0].questionId, q2);
    const courseOnly = await catalog({ courseId, sinceDays: 7 });
    assert.deepEqual(
      courseOnly.questions.map(({ questionId }) => questionId),
      [courseQuestion],
    );

    const kernelPath = join(dataDir, "learning-kernel.sqlite");
    const offlinePath = join(dataDir, "learning-kernel-offline.sqlite");
    renameSync(kernelPath, offlinePath);
    try {
      const unavailable = await status(
        await call("/api/student/wrong-questions"),
        503,
      );
      const error = await unavailable.json();
      assert.equal(error.error, "KERNEL_ATTEMPT_UNAVAILABLE");
      assert.ok(!Object.hasOwn(error, "data"));
      assert.deepEqual(
        await list(new URLSearchParams({ knowledge: "合成独立考点" })),
        [legacyCards.find(({ questionId }) => questionId === courseQuestion)],
      );
      assert.deepEqual(await catalog({ courseId, sinceDays: 7 }), courseOnly);
      await status(await practice(courseQuestion), 201);
      assert.deepEqual(await list("", otherCookie), []);
      await status(
        await call(`/api/teacher/assignments/${assignment}`, teacher, "PATCH", {
          dueAt: future,
        }),
        200,
      );
      assert.deepEqual(await list(), legacyCards);
      await status(await practice(q2), 400);
    } finally {
      renameSync(offlinePath, kernelPath);
    }
  } finally {
    await client.close();
  }
  assert.deepEqual(await list(), legacyCards);
  const logout = await status(
    await call("/api/student/logout", ownerCookie, "POST"),
    200,
  );
  assert.ok(logout.ok);
  await status(await call("/api/student/wrong-questions"), 401);
  assert.deepEqual(
    dbRead((db) =>
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM responses WHERE attempt_id = ? AND (answer_json IS NOT NULL OR auto_correct IS NOT NULL OR final_correct IS NOT NULL)",
        )
        .get(candidate),
    ),
    { n: 0 },
  );
  console.log(
    "错题轮次、冻结版本、目录分页、组卷、内核离线及重新收紧公布均通过",
  );
} finally {
  await service.close();
}
