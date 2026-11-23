import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import {
  assignmentCreateOkSchema,
  attemptStartOkSchema,
  learningPackPreviewOkSchema,
  learningPackSchema,
  learningPackV2Schema,
} from "@tutor/contract";
import { createDb } from "../../db/client.ts";
import { callToolJson, connectMcpClientViaApp } from "../mcp-test-utils.ts";
import {
  makeNotePng,
  postNoteImage,
  putNoteReceipt,
} from "../note-fixtures.ts";
import { extractSessionToken } from "../note-world.ts";
import { submitAttemptRequest } from "../submit-revisions.ts";
import { unzipEntries } from "../unzip.ts";
import { postAssignment, setupAssignment } from "./product-fixture.ts";
import { createRealServiceFixture } from "./real-service-fixture.mjs";

const service = await createRealServiceFixture();
const { app, dataDir, boot, stop } = service;
const path = "/api/teacher/export/learning-pack";
const far = "2099-01-01T00:00:00.000Z";
const first = "m04-p0-q1";
const second = "m04-p0-q2";
const png = Buffer.from(makeNotePng());
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
const byVersion = (value, version) =>
  (version === 2 ? learningPackV2Schema : learningPackSchema).parse(value);
function observed(pack) {
  return {
    summaries: pack.attempts?.summaries?.map((row) => [
      row.status,
      row.scoreAuto,
      row.scoreFinal,
      row.questionCount,
      row.correctCount,
      row.wrongCount,
      row.pendingCount,
    ]),
    answers: pack.attempts?.responses?.map((row) => [
      row.no,
      row.answerText,
      row.autoCorrect,
      row.finalCorrect,
    ]),
  };
}

try {
  const firstPid = await boot(true);
  const world = await setupAssignment(app);
  const { teacher, ownerCookie, otherCookie } = world;
  const call = (url, cookie, method, body) =>
    app.request(url, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function assignment(title, kernel) {
    const courseResponse = await status(
      await call("/api/teacher/courses", teacher, "POST", { title }),
      201,
    );
    const { id: courseId } = (await courseResponse.json()).data;
    const studentIds = [world.studentId, world.otherStudentId];
    await status(
      await call(`/api/teacher/courses/${courseId}/members`, teacher, "POST", {
        studentIds,
      }),
      200,
    );
    const response = await status(
      await call("/api/teacher/assignments", teacher, "POST", {
        title,
        courseId,
        studentIds,
        unitIds: [world.unitId],
        dueAt: far,
        answerRelease: "after_due",
        allowRedo: false,
        ...(kernel ? { executionBackend: "kernel" } : {}),
      }),
      201,
    );
    const { assignments } = assignmentCreateOkSchema.parse(
      await response.json(),
    ).data;
    return { courseId, assignmentId: assignments[0].id };
  }
  async function open(scope, cookie) {
    const response = await status(
      await postAssignment(app, scope.assignmentId, cookie),
      200,
    );
    return attemptStartOkSchema.parse(await response.json()).data.id;
  }
  async function fill(scope) {
    const id = await open(scope, ownerCookie);
    for (const [question, index] of [
      [first, 1],
      [second, 0],
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
    await putNoteReceipt(app, ownerCookie, id, second);
    const v2 = await putNoteReceipt(app, ownerCookie, id, second, 2, {
      baseRevision: 1,
    });
    await status(
      await postNoteImage(app, "student", v2.versionId, png, ownerCookie),
      200,
    );
    return {
      id,
      v2,
      submit: () =>
        submitAttemptRequest(app, ownerCookie, id, [
          { questionId: first, state: "none" },
          {
            questionId: second,
            state: "frozen",
            versionId: v2.versionId,
            revision: 2,
          },
        ]),
    };
  }
  const legacyScope = await assignment("整卷学情旧课", false);
  const kernelScope = await assignment("整卷学情内核课", true);
  const legacy = await fill(legacyScope);
  await status(await legacy.submit(), 200);
  const candidate = await fill(kernelScope);
  const trueDraft = await open(kernelScope, otherCookie);
  await status(
    await call(
      `/api/student/attempts/${trueDraft}/answers/${first}`,
      otherCookie,
      "PUT",
      {
        answer: { kind: "choice", index: 0 },
      },
    ),
    200,
  );
  const beforeConfirmation = new Date().toISOString();
  withProduct((db) =>
    db.exec(`
    CREATE TRIGGER interrupt_learning_pack_projection BEFORE UPDATE OF status ON attempts
    WHEN NEW.status = 'graded'
    BEGIN SELECT RAISE(ABORT, 'interrupted learning pack projection'); END
  `),
  );
  try {
    await status(await candidate.submit(), 500);
  } finally {
    withProduct((db) =>
      db.exec("DROP TRIGGER interrupt_learning_pack_projection"),
    );
  }
  const host = () =>
    withProduct((db) =>
      db
        .prepare(
          "SELECT status,submitted_at,score_auto,score_final FROM attempts WHERE id=?",
        )
        .get(candidate.id),
    );
  assert.equal(host().status, "draft");
  const outside = await status(
    await call("/api/public/teacher/register", "", "POST", {
      loginName: "整卷包他老师",
      password: "other-teacher-8",
    }),
    200,
  );
  const otherTeacher = `tutor_session=${extractSessionToken(outside)}`;
  await stop();
  const secondPid = await boot(false);
  assert.notEqual(firstPid, secondPid);

  function request(scope, version, overrides = {}) {
    return {
      ...(version === 2 ? { packVersion: 2 } : {}),
      scope: { ...scope, days: "all" },
      goal: "diagnose-weakness",
      modules: {
        questions: "solution",
        responses: true,
        summaries: true,
        traces: true,
        ...(version === 2 ? { evidence: true } : {}),
      },
      privacy: { anonymize: true },
      ...overrides,
    };
  }
  async function preview(requestBody) {
    const response = await status(
      await call(`${path}/preview`, teacher, "POST", requestBody),
      200,
    );
    return learningPackPreviewOkSchema.parse(await response.json()).data;
  }
  async function download(body, version) {
    const response = await status(await call(path, teacher, "POST", body), 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "application/zip");
    const entries = unzipEntries(new Uint8Array(await response.arrayBuffer()));
    return {
      entries,
      pack: byVersion(
        JSON.parse(entries.get("pack.json").toString("utf8")),
        version,
      ),
    };
  }
  async function sdk(cookie, args) {
    const tokenResponse = await status(
      await call("/api/teacher/api-token", cookie, "POST"),
      200,
    );
    const client = await connectMcpClientViaApp(
      app,
      "/mcp",
      (await tokenResponse.json()).data.token,
      "whole-pack-acceptance",
    );
    try {
      return await callToolJson(client, "get_student_learning_pack", args);
    } finally {
      await client.close();
    }
  }

  const kernelV2 = request(kernelScope, 2);
  // 教师预览是重启后第一次读取原卷。
  const firstPreview = await preview(kernelV2);
  const firstHost = host();
  const expected = [];
  const actual = [];
  const fromSdk = [];
  for (const version of [1, 2]) {
    expected.push(await download(request(legacyScope, version), version));
    actual.push(
      await download(
        {
          ...request(kernelScope, version),
          asOf: firstPreview.asOf,
        },
        version,
      ),
    );
    const tool = await sdk(teacher, {
      ...kernelScope,
      studentId: world.studentId,
      days: "all",
      ...(version === 2 ? { packVersion: 2, modules: { evidence: true } } : {}),
    });
    assert.equal(tool.isError, false);
    fromSdk.push(byVersion(tool.data, version));
  }
  console.log(
    JSON.stringify({
      firstPid,
      secondPid,
      firstHost,
      previewEvidence: firstPreview.evidenceImages.length,
      legacy: expected.map(({ pack }) => observed(pack)),
      candidate: actual.map(({ pack }) => observed(pack)),
      sdk: fromSdk.map(observed),
    }),
  );
  const truth = {
    summaries: [["graded", 50, 50, 2, 1, 1, 0]],
    answers: [
      [1, "B", true, true],
      [2, "A", false, false],
    ],
  };
  assert.deepEqual(firstHost, {
    status: "graded",
    submitted_at: firstHost.submitted_at,
    score_auto: null,
    score_final: null,
  });
  assert.ok(firstHost.submitted_at >= beforeConfirmation);
  for (const pack of [
    ...expected.map((item) => item.pack),
    ...actual.map((item) => item.pack),
    ...fromSdk,
  ]) {
    assert.deepEqual(observed(pack), truth);
    assert.equal(pack.summary.overall.attemptCount, 1);
    assert.equal(pack.summary.overall.pendingCount, 0);
    assert.equal(
      pack.traces.questions.filter((row) => row.changeCount === 1).length,
      2,
    );
    assert.equal(pack.attempts.summaries[0].studentId, world.studentId);
    assert.equal(pack.attempts.summaries[0].attemptId === trueDraft, false);
  }
  const [wholeV1, wholeV2] = actual;
  for (const { pack, entries } of [wholeV1, wholeV2]) {
    assert.deepEqual(
      pack.students.map(({ name }) => name),
      ["学生A"],
    );
    assert.ok(!entries.get("pack.json").includes(Buffer.from("合成甲")));
    assert.match(entries.get("映射.txt").toString("utf8"), /学生A = 合成甲/u);
  }
  assert.deepEqual(
    fromSdk[0].students.map(({ name }) => name),
    ["合成甲"],
  );
  assert.equal(wholeV1.pack.evidence, undefined);
  const frozen = wholeV2.pack.evidence.find(({ state }) => state === "frozen");
  assert.equal(frozen.version.versionId, candidate.v2.versionId);
  assert.equal(
    fromSdk[1].evidence.find(({ state }) => state === "frozen").version
      .versionId,
    candidate.v2.versionId,
  );
  const ready = firstPreview.evidenceImages.find(
    ({ state }) => state === "ready",
  );
  assert.ok(ready.downloadUrl.includes(candidate.v2.versionId));
  assert.deepEqual(wholeV2.entries.get(ready.file), png);
  assert.equal(wholeV2.pack.meta.to, firstPreview.asOf);
  assert.equal(
    wholeV2.pack.attempts.responses.some(({ evidenceRefs }) =>
      evidenceRefs?.includes(frozen.ref),
    ),
    true,
  );

  const cutoff = await download({ ...kernelV2, asOf: beforeConfirmation }, 2);
  assert.deepEqual(cutoff.pack.attempts.responses, []);
  assert.deepEqual(cutoff.pack.evidence, []);
  const modulesOnly = await download(
    {
      ...kernelV2,
      modules: { summaries: true },
      asOf: firstHost.submitted_at,
    },
    2,
  );
  assert.equal(modulesOnly.pack.attempts.responses, undefined);
  assert.equal(modulesOnly.pack.evidence, undefined);
  assert.equal(modulesOnly.pack.content, undefined);
  assert.equal(modulesOnly.pack.attempts.summaries[0].scoreFinal, 50);
  await status(
    await call(`${path}/preview`, otherTeacher, "POST", kernelV2),
    404,
    "COURSE_NOT_FOUND",
  );
  await status(
    await call(
      path,
      otherTeacher,
      "POST",
      request({ studentIds: [world.studentId] }, 1),
    ),
    404,
    "STUDENT_NOT_FOUND",
  );
  const outsideTool = await sdk(otherTeacher, {
    assignmentId: kernelScope.assignmentId,
  });
  assert.equal(outsideTool.isError, true);
  assert.equal(outsideTool.data.error, "ASSIGNMENT_NOT_FOUND");

  const kernelPath = join(dataDir, "learning-kernel.sqlite");
  const offline = `${kernelPath}.held`;
  renameSync(kernelPath, offline);
  try {
    await status(
      await call(`${path}/preview`, teacher, "POST", kernelV2),
      503,
      "KERNEL_ATTEMPT_UNAVAILABLE",
    );
    const outsideDate = await download(
      {
        ...kernelV2,
        scope: { ...kernelScope, days: 1 },
        asOf: new Date(
          Date.parse(firstHost.submitted_at) + 172800000,
        ).toISOString(),
      },
      2,
    );
    assert.deepEqual(outsideDate.pack.attempts.responses, []);
    const onlyDraft = await download(
      request(
        {
          ...kernelScope,
          studentIds: [world.otherStudentId],
        },
        2,
      ),
      2,
    );
    assert.deepEqual(onlyDraft.pack.attempts.responses, []);
    assert.deepEqual(
      observed((await download(request(legacyScope, 2), 2)).pack),
      truth,
    );
  } finally {
    renameSync(offline, kernelPath);
  }
  await status(await submitAttemptRequest(app, otherCookie, trueDraft), 200);
  const pinned = await download({ ...kernelV2, asOf: firstPreview.asOf }, 2);
  assert.deepEqual(observed(pinned.pack), truth);
  const latest = await download(kernelV2, 2);
  assert.deepEqual(
    new Set(latest.pack.attempts.summaries.map(({ attemptId }) => attemptId)),
    new Set([candidate.id, trueDraft]),
  );

  const raw = withProduct((db) =>
    db
      .prepare(
        "SELECT count(*) AS n FROM responses WHERE attempt_id=? AND (answer_json IS NOT NULL OR auto_correct IS NOT NULL OR final_correct IS NOT NULL)",
      )
      .get(candidate.id),
  );
  assert.deepEqual(raw, { n: 0 });
  console.log("整卷 v1/v2、SDK、冻结图片与范围过滤均通过");
} finally {
  await service.close();
}
