import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { attemptDraftOkSchema, attemptStartOkSchema } from "@tutor/contract";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";

const cleanup = new Set<() => void>();
afterEach(() => {
  for (const close of cleanup) close();
  cleanup.clear();
});

async function fixture() {
  const dataDir = createTestDir();
  const path = join(dataDir, "product.sqlite");
  const template = createTestDb();
  writeFileSync(path, template.$client.serialize());
  template.$client.close();
  let db = createDb(path);
  cleanup.add(() => db.$client.close());
  const mount = (enabled: boolean, dbConnection = db) =>
    createApp({
      db: dbConnection,
      dataDir,
      isProduction: false,
      publicUrl: "http://localhost:8787",
      logger: pino({ enabled: false }),
      kernelAssignmentCreationEnabled: enabled,
      questionProcessEnabled: true,
    });
  let app = mount(true);
  const world = await setupAssignment(app);
  const teacherRequest = (path: string, method: string, body: object) =>
    app.request(`/api/teacher/${path}`, {
      method,
      headers: { cookie: world.teacher, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const assigned = await teacherRequest("assignments", "POST", {
    title: "P2 单选",
    unitIds: [world.unitId],
    studentIds: [world.studentId, world.otherStudentId],
    executionBackend: "kernel",
    allowRedo: false,
  });
  expect(assigned.status).toBe(201);
  const ids = z.object({
    data: z.object({ assignments: z.array(z.object({ id: z.uuid() })) }),
  });
  const [id] = ids
    .parse(await assigned.json())
    .data.assignments.map((row) => row.id);
  if (!id) throw new Error("作业创建缺少 ID");

  const ownedRequest = (
    attemptId: string,
    suffix = "",
    method = "GET",
    body?: object,
    cookie = world.ownerCookie,
  ) =>
    app.request(`/api/student/attempts/${attemptId}${suffix}`, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const open = async (cookie = world.ownerCookie) => {
    const response = await postAssignment(app, id, cookie);
    expect(response.status, await response.clone().text()).toBe(200);
    return attemptStartOkSchema.parse(await response.json()).data;
  };
  const detail = async (attemptId: string, cookie = world.ownerCookie) => {
    const response = await ownedRequest(
      attemptId,
      "",
      "GET",
      undefined,
      cookie,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json();
    assertNoLeak(body, { forbid: ["keyRef", "scoringKey", "acceptedChoices"] });
    expect(JSON.stringify(body)).not.toContain("合成详解");
    return attemptDraftOkSchema.parse(body).data;
  };
  const kernel = () => {
    const connection = new DatabaseSync(
      join(dataDir, "learning-kernel.sqlite"),
      { readOnly: true },
    );
    cleanup.add(() => connection.close());
    return connection;
  };
  return {
    ...world,
    id,
    dataDir,
    teacherRequest,
    open,
    detail,
    ownedRequest,
    kernel,
    post: (cookie: string) => postAssignment(app, id, cookie),
    plainPost: (assignmentId: string, cookie: string, options?: object) =>
      app.request(`/api/student/assignments/${assignmentId}/attempt`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        ...(options === undefined ? {} : { body: JSON.stringify(options) }),
      }),
    restart: () => {
      db.$client.close();
      db = createDb(path);
      app = mount(false);
    },
    independentApp: () => {
      const connection = createDb(path);
      cleanup.add(() => connection.$client.close());
      return mount(false, connection);
    },
    database: () => db.$client,
  };
}

it("普通 HTTP 开卷和重开共用权威卷、冻结行与当前作业名单", async () => {
  const world = await fixture();
  const old = await world.plainPost(world.assignmentId, world.ownerCookie, {
    timeLimitMinutes: 90,
  });
  expect(old.status).toBe(200);
  expect(attemptStartOkSchema.parse(await old.json()).data).toMatchObject({
    phase: "active",
    timeLimitSec: 5400,
  });
  const [first, repeated] = await Promise.all([world.open(), world.open()]);
  expect(repeated).toEqual(first);
  expect(first.phase).toBe("opened");
  const stable = await world.detail(first.id);
  expect(stable.units.flatMap((unit) => unit.questions)).toHaveLength(2);
  expect(
    (
      await world.ownedRequest(
        first.id,
        "",
        "GET",
        undefined,
        world.otherCookie,
      )
    ).status,
  ).toBe(403);
  world.restart();
  expect(await world.open()).toEqual(first);
  const oldClient = await world.plainPost(world.id, world.ownerCookie);
  expect(oldClient.status).toBe(200);
  expect(attemptStartOkSchema.parse(await oldClient.json()).data).toEqual(
    first,
  );
  expect(await world.detail(first.id)).toEqual(stable);
  const bindings = world
    .database()
    .prepare(
      "SELECT attempt_id, assignment_id, practice_version, step_attempt_id FROM kernel_attempt_bindings",
    )
    .all();
  expect(bindings).toEqual([
    {
      attempt_id: first.id,
      assignment_id: world.id,
      practice_version: 1,
      step_attempt_id: expect.any(String),
    },
  ]);
  const removed = await world.teacherRequest(
    `assignments/${world.id}`,
    "PATCH",
    { removeStudentIds: [world.studentId] },
  );
  expect(removed.status).toBe(200);
  expect((await world.post(world.ownerCookie)).status).toBe(403);
  expect(await world.detail(first.id)).toEqual(stable);
  expect(world.kernel().prepare("SELECT id FROM activities").all()).toEqual([
    { id: first.id },
  ]);
});

it("教师重导后，两名学生的开卷各指向自己真正冻结的版本", async () => {
  const world = await fixture();
  const old = await world.open();
  const previous = await world.detail(old.id);
  const markdown = readFileSync(
    new URL("../test/m04-p1/fixtures/P0-单选夹具.md", import.meta.url),
    "utf8",
  ).replace("2 + 3 等于多少？", "新版：2 + 3 的结果是多少？");
  const imported = await world.teacherRequest("import/commit", "POST", {
    filename: "M04P0.md",
    markdown,
  });
  expect(imported.status).toBe(200);
  const next = await world.open(world.otherCookie);
  expect(next.id).not.toBe(old.id);
  const revised = await world.detail(next.id, world.otherCookie);
  expect(previous.units[0]?.questions[0]?.stemMd).toContain("2 + 3 等于多少？");
  expect(revised.units[0]?.questions[0]?.stemMd).toContain(
    "新版：2 + 3 的结果是多少？",
  );
  expect(revised.units[0]?.questions[0]?.questionRevisionId).not.toBe(
    previous.units[0]?.questions[0]?.questionRevisionId,
  );
  expect(await world.open()).toEqual(old);
  expect(await world.detail(old.id)).toEqual(previous);
  expect(
    world
      .kernel()
      .prepare(
        "SELECT id, practice_id, practice_version FROM activities ORDER BY practice_version",
      )
      .all(),
  ).toEqual([
    { id: old.id, practice_id: world.id, practice_version: 1 },
    { id: next.id, practice_id: world.id, practice_version: 2 },
  ]);
});

it("内核卷的逐题和批次入口均拒绝旧写入", async () => {
  const world = await fixture();
  const { id } = await world.open();
  const detail = await world.detail(id);
  const question = detail.units[0]?.questions[0];
  if (!question) throw new Error("冻结题缺失");
  const requests = [
    [
      "/settlements",
      "POST",
      {
        workflowVersion: 1,
        workflowRevision: 0,
        mutationId: randomUUID(),
        questions: [
          {
            questionId: question.id,
            questionRevisionId: question.questionRevisionId,
            expectedAnswerRevision: 0,
            evidence: { questionId: question.id, state: "none" },
          },
        ],
      },
    ],
    [
      `/questions/${question.id}/submit`,
      "POST",
      {
        workflowVersion: 1,
        workflowRevision: 1,
        questionRevisionId: question.questionRevisionId,
        expectedAnswerRevision: 0,
        submissionMutationId: randomUUID(),
        evidence: { questionId: question.id, state: "none" },
      },
    ],
    ["/submit-batches", "POST", { batchCount: 2 }],
    [`/submit-batches/${randomUUID()}/finish`, "POST", {}],
  ] as const;
  for (const [suffix, method, body] of requests) {
    const response = await world.ownedRequest(id, suffix, method, body);
    expect(response.status, `${suffix}: ${await response.clone().text()}`).toBe(
      503,
    );
    expect(await response.json()).toMatchObject({
      error: "KERNEL_ATTEMPT_WRITE_UNAVAILABLE",
    });
  }
  expect(
    world
      .database()
      .prepare(
        "SELECT status, score_auto, score_final, activated_at FROM attempts WHERE id=?",
      )
      .get(id),
  ).toEqual({
    status: "draft",
    score_auto: null,
    score_final: null,
    activated_at: null,
  });
  expect(
    world
      .database()
      .prepare("SELECT answer_json FROM responses WHERE attempt_id=?")
      .pluck()
      .all(id),
  ).toEqual([null, null]);
  expect(
    world.kernel().prepare("SELECT COUNT(*) AS count FROM submissions").get(),
  ).toEqual({ count: 0 });
});

it("90 分钟内核卷立即激活，权威库暂缺时旧路由补不出第二份卷", async () => {
  const world = await fixture();
  const start = await world.plainPost(world.id, world.ownerCookie, {
    timeLimitMinutes: 90,
  });
  expect(start.status).toBe(200);
  const first = attemptStartOkSchema.parse(await start.json()).data;
  expect(first).toMatchObject({
    phase: "active",
    timeLimitSec: 5400,
    activatedAt: first.startedAt,
    deadlineAt: new Date(Date.parse(first.startedAt) + 5400_000).toISOString(),
  });
  const another = await world.teacherRequest("assignments", "POST", {
    title: "同一权威库的第二份作业",
    unitIds: [world.unitId],
    studentIds: [world.otherStudentId],
    executionBackend: "kernel",
    allowRedo: false,
  });
  expect(another.status).toBe(201);
  const assignments = z.object({
    data: z.object({ assignments: z.array(z.object({ id: z.uuid() })) }),
  });
  const nextAssignment = assignments.parse(await another.json()).data
    .assignments[0]?.id;
  if (!nextAssignment) throw new Error("作业创建缺少 ID");
  const path = join(world.dataDir, "learning-kernel.sqlite");
  const backup = join(world.dataDir, "learning-kernel.held");
  renameSync(path, backup);
  try {
    world.restart();
    for (const denied of [
      await world.post(world.ownerCookie),
      await world.ownedRequest(first.id),
      await world.plainPost(nextAssignment, world.otherCookie),
    ]) {
      expect(denied.status).toBe(503);
      expect(await denied.json()).toMatchObject({
        error: "KERNEL_ATTEMPT_UNAVAILABLE",
      });
    }
    expect(existsSync(path)).toBe(false);
    expect(
      world
        .database()
        .prepare("SELECT id FROM attempts WHERE assignment_id=?")
        .all(world.id),
    ).toEqual([{ id: first.id }]);
  } finally {
    renameSync(backup, path);
  }
  expect(await world.open()).toEqual(first);
});

it("跨库中断后原请求恢复旧卷，另一学生按导入后的顺序与版本开新卷", async () => {
  const world = await fixture();
  const openIntent = { timeLimitMinutes: 90 };
  world.database().exec(`
    CREATE TRIGGER fail_kernel_attempt_projection
    BEFORE INSERT ON kernel_attempt_bindings
    BEGIN SELECT RAISE(ABORT, 'forced kernel attempt projection failure'); END
  `);
  const failed = await world.plainPost(world.id, world.ownerCookie, openIntent);
  expect(failed.status).toBe(500);
  const activityRows = () =>
    world
      .kernel()
      .prepare(
        "SELECT id, student_id, practice_id, practice_version, start_operation_id, started_at FROM activities ORDER BY practice_version",
      )
      .all();
  const firstFacts = activityRows();
  expect(firstFacts).toEqual([
    {
      id: expect.any(String),
      student_id: world.studentId,
      practice_id: world.id,
      practice_version: 1,
      start_operation_id: `open:${world.id}`,
      started_at: expect.any(String),
    },
  ]);
  const first = z
    .object({ id: z.uuid(), started_at: z.iso.datetime() })
    .parse(firstFacts[0]);
  expect(
    world.database().prepare("SELECT COUNT(*) FROM attempts").pluck().get(),
  ).toBe(0);
  expect(
    world.database().prepare("SELECT COUNT(*) FROM responses").pluck().get(),
  ).toBe(0);
  expect(
    world
      .database()
      .prepare("SELECT COUNT(*) FROM kernel_attempt_bindings")
      .pluck()
      .get(),
  ).toBe(0);
  const pending = () =>
    world
      .database()
      .prepare(
        "SELECT assignment_id, student_id, practice_version FROM kernel_assignment_openings",
      )
      .all();
  const originalIntent = [
    {
      assignment_id: world.id,
      student_id: world.studentId,
      practice_version: 1,
    },
  ];
  expect(pending()).toEqual(originalIntent);
  expect((await world.ownedRequest(first.id)).status).toBe(404);
  world.database().exec("DROP TRIGGER fail_kernel_attempt_projection");
  world.restart();

  const markdown = readFileSync(
    new URL("../test/m04-p1/fixtures/P0-单选夹具.md", import.meta.url),
    "utf8",
  );
  const firstQuestion = markdown.indexOf("::::question{id=m04-p0-q1");
  const secondQuestion = markdown.indexOf("::::question{id=m04-p0-q2");
  expect(firstQuestion).toBeGreaterThan(0);
  expect(secondQuestion).toBeGreaterThan(firstQuestion);
  const revised =
    markdown.slice(0, firstQuestion) +
    markdown.slice(secondQuestion).trimEnd() +
    "\n\n" +
    markdown
      .slice(firstQuestion, secondQuestion)
      .replace("2 + 3 等于多少？", "恢复试验新版：2 + 3 是多少？")
      .trimEnd() +
    "\n";
  const imported = await world.teacherRequest("import/commit", "POST", {
    filename: "M04P0.md",
    markdown: revised,
  });
  expect(imported.status).toBe(200);

  const remove = await world.teacherRequest(
    `assignments/${world.id}`,
    "PATCH",
    { removeStudentIds: [world.studentId] },
  );
  expect(remove.status).toBe(200);
  expect(
    (await world.plainPost(world.id, world.ownerCookie, openIntent)).status,
  ).toBe(403);
  expect(activityRows()).toEqual(firstFacts);
  expect(pending()).toEqual(originalIntent);

  const other = await world.open(world.otherCookie);
  const otherDetail = await world.detail(other.id, world.otherCookie);
  const otherQuestions = otherDetail.units.flatMap((unit) => unit.questions);
  expect(otherQuestions.map((question) => question.id)).toEqual([
    "m04-p0-q2",
    "m04-p0-q1",
  ]);
  expect(otherQuestions[1]?.stemMd).toContain("恢复试验新版");
  expect(
    (
      await world.ownedRequest(
        first.id,
        "",
        "GET",
        undefined,
        world.otherCookie,
      )
    ).status,
  ).toBe(404);

  const restore = await world.teacherRequest(
    `assignments/${world.id}`,
    "PATCH",
    { addStudentIds: [world.studentId] },
  );
  expect(restore.status).toBe(200);
  const recovered = await world.plainPost(
    world.id,
    world.ownerCookie,
    openIntent,
  );
  expect(recovered.status, await recovered.clone().text()).toBe(200);
  const recoveredStart = attemptStartOkSchema.parse(
    await recovered.json(),
  ).data;
  expect(recoveredStart).toMatchObject({
    id: first.id,
    startedAt: first.started_at,
    frozenAt: first.started_at,
    activatedAt: first.started_at,
    phase: "active",
    timeLimitSec: 5400,
    deadlineAt: new Date(Date.parse(first.started_at) + 5400_000).toISOString(),
  });
  const oldDetail = await world.detail(first.id);
  const oldQuestions = oldDetail.units.flatMap((unit) => unit.questions);
  expect(oldQuestions.map((question) => question.id)).toEqual([
    "m04-p0-q1",
    "m04-p0-q2",
  ]);
  expect(oldQuestions[0]?.stemMd).toContain("2 + 3 等于多少？");
  expect(oldQuestions[0]?.questionRevisionId).not.toBe(
    otherQuestions[1]?.questionRevisionId,
  );
  expect(
    (
      await world.ownedRequest(
        first.id,
        "",
        "GET",
        undefined,
        world.otherCookie,
      )
    ).status,
  ).toBe(403);

  world.restart();
  expect(await world.open()).toEqual(recoveredStart);
  expect(await world.open(world.otherCookie)).toEqual(other);
  const independent = world.independentApp();
  for (const [cookie, expected] of [
    [world.ownerCookie, recoveredStart],
    [world.otherCookie, other],
  ] as const) {
    const response = await postAssignment(independent, world.id, cookie);
    expect(response.status).toBe(200);
    expect(attemptStartOkSchema.parse(await response.json()).data).toEqual(
      expected,
    );
  }
  expect(pending()).toEqual([]);
  const ownerRestart = await world.detail(first.id);
  const otherRestart = await world.detail(other.id, world.otherCookie);
  expect(ownerRestart.units).toEqual(oldDetail.units);
  expect(otherRestart.units).toEqual(otherDetail.units);
  const frozenQuestions = world
    .database()
    .prepare(
      "SELECT question_id, question_version FROM responses WHERE attempt_id=? ORDER BY rowid",
    );
  expect(frozenQuestions.all(first.id)).toEqual([
    { question_id: "m04-p0-q1", question_version: 1 },
    { question_id: "m04-p0-q2", question_version: 1 },
  ]);
  const newerFrozen = z
    .array(z.object({ question_id: z.string(), question_version: z.int() }))
    .parse(frozenQuestions.all(other.id));
  expect(newerFrozen.map(({ question_id }) => question_id)).toEqual([
    "m04-p0-q2",
    "m04-p0-q1",
  ]);
  expect(newerFrozen[1]?.question_version).toBeGreaterThan(1);
  expect(
    world
      .kernel()
      .prepare(
        "SELECT version, json_extract(definition, '$.questions[0].id') AS first_question FROM practices WHERE id=? ORDER BY version",
      )
      .all(world.id),
  ).toEqual([
    { version: 1, first_question: "m04-p0-q1" },
    { version: 2, first_question: "m04-p0-q2" },
  ]);
  expect(activityRows()).toEqual([
    firstFacts[0],
    {
      id: other.id,
      student_id: world.otherStudentId,
      practice_id: world.id,
      practice_version: 2,
      start_operation_id: `open:${world.id}`,
      started_at: other.startedAt,
    },
  ]);
  expect(
    world
      .database()
      .prepare(
        "SELECT attempt_id, practice_version FROM kernel_attempt_bindings ORDER BY practice_version",
      )
      .all(),
  ).toEqual([
    { attempt_id: first.id, practice_version: 1 },
    { attempt_id: other.id, practice_version: 2 },
  ]);
  expect(
    world
      .database()
      .prepare(
        "SELECT COUNT(*) AS total, COUNT(score_auto) AS auto, COUNT(score_final) AS final FROM attempts",
      )
      .get(),
  ).toEqual({ total: 2, auto: 0, final: 0 });
  expect(
    world
      .database()
      .prepare(
        "SELECT COUNT(*) AS total, COUNT(answer_json) AS answers, COUNT(auto_correct) AS auto, COUNT(final_correct) AS final FROM responses",
      )
      .get(),
  ).toEqual({ total: 4, answers: 0, auto: 0, final: 0 });
  expect(
    world.kernel().prepare("SELECT COUNT(*) FROM submissions").get(),
  ).toEqual({ "COUNT(*)": 0 });
});
