import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ATTEMPT_SNAPSHOT_PROOF_HEADER,
  attemptDraftOkSchema,
  attemptStartOkSchema,
  noteVersionReceiptSchema,
} from "@tutor/contract";
import { openLearningRuntime } from "learning-kernel";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { reserveSubmissionOriginals } from "../services/attempt-original-reservation.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import { gzipJson, noteDoc, putNoteBodyForm } from "../test/note-fixtures.ts";

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
      headers:
        body instanceof FormData
          ? { cookie }
          : { cookie, "content-type": "application/json" },
      ...(body === undefined
        ? {}
        : { body: body instanceof FormData ? body : JSON.stringify(body) }),
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
    noteDocument: (versionId: string) =>
      app.request(`/api/student/note-versions/${versionId}/document`, {
        headers: { cookie: world.ownerCookie },
      }),
    kernel,
    post: (cookie: string) => postAssignment(app, id, cookie),
    proofPost: (assignmentId: string, cookie: string) =>
      postAssignment(app, assignmentId, cookie),
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

function reversedFixture(firstStem: string): string {
  const markdown = readFileSync(
    new URL("../test/m04-p1/fixtures/P0-单选夹具.md", import.meta.url),
    "utf8",
  );
  const firstQuestion = markdown.indexOf("::::question{id=m04-p0-q1");
  const secondQuestion = markdown.indexOf("::::question{id=m04-p0-q2");
  if (firstQuestion < 0 || secondQuestion <= firstQuestion)
    throw new Error("夹具缺少两道单选");
  const sections = [
    markdown.slice(0, firstQuestion).trimEnd(),
    markdown.slice(secondQuestion).trimEnd(),
    markdown
      .slice(firstQuestion, secondQuestion)
      .replace("2 + 3 等于多少？", firstStem)
      .trimEnd(),
  ];
  return `${sections.join("\n\n")}\n`;
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
  const olderClient = await world.plainPost(world.id, world.ownerCookie);
  expect(olderClient.status).toBe(200);
  expect(attemptStartOkSchema.parse(await olderClient.json()).data).toEqual(
    old,
  );
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

it("90 分钟内核卷立即激活，权威库暂缺时保留原稿且禁止补卷", async () => {
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
  const enabled = await world.teacherRequest(
    "settings/capability-profile",
    "PUT",
    { enabledCapabilities: ["ink"] },
  );
  expect(enabled.status).toBe(200);
  const noteForm = putNoteBodyForm(gzipJson(noteDoc()));
  if (!first.frozenAt) throw new Error("缺少原冻结凭据");
  noteForm.set("expectedFrozenAt", first.frozenAt);
  const saved = await world.ownedRequest(
    first.id,
    "/notes/m04-p0-q1",
    "PUT",
    noteForm,
  );
  expect(saved.status).toBe(200);
  const { data: note } = z
    .object({ data: noteVersionReceiptSchema })
    .parse(await saved.json());
  const before = await world.noteDocument(note.versionId);
  expect(before.status).toBe(200);
  const original = Buffer.from(await before.arrayBuffer());
  expect(original.length).toBeGreaterThan(0);
  const changed = await world.teacherRequest("import/commit", "POST", {
    filename: "M04P0.md",
    markdown: reversedFixture("计时原稿试验新版：2 + 3 是多少？"),
  });
  expect(changed.status).toBe(200);
  expect(await world.open()).toEqual(first);
  const stillOld = await world.detail(first.id);
  expect(stillOld.units[0]?.questions[0]?.stemMd).toContain("2 + 3 等于多少？");
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
    const retained = await world.noteDocument(note.versionId);
    expect(retained.status).toBe(200);
    expect(Buffer.from(await retained.arrayBuffer())).toEqual(original);
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

  const imported = await world.teacherRequest("import/commit", "POST", {
    filename: "M04P0.md",
    markdown: reversedFixture("恢复试验新版：2 + 3 是多少？"),
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

it("现代旧卷和 K9 卷都同 ID 换序重冻，无凭据时保留旧版", async () => {
  const world = await fixture();
  const legacyOpen = await world.plainPost(
    world.assignmentId,
    world.ownerCookie,
  );
  expect(legacyOpen.status).toBe(200);
  const legacyBefore = attemptStartOkSchema.parse(await legacyOpen.json()).data;
  const kernelBefore = await world.open();
  expect(legacyBefore.phase).toBe("opened");
  expect(kernelBefore.phase).toBe("opened");
  const legacyBeforeView = await world.detail(legacyBefore.id);
  const kernelBeforeView = await world.detail(kernelBefore.id);
  const oldQuestion = legacyBeforeView.units[0]?.questions[0];
  if (!oldQuestion) throw new Error("缺少原冻结题");

  const reimport = await world.teacherRequest("import/commit", "POST", {
    filename: "M04P0.md",
    markdown: reversedFixture("凭据试验新版：2 + 3 的结果是多少？"),
  });
  expect(reimport.status).toBe(200);
  expect(await world.detail(legacyBefore.id)).toEqual(legacyBeforeView);
  expect(await world.detail(kernelBefore.id)).toEqual(kernelBeforeView);
  expect(
    (
      await world.ownedRequest(
        kernelBefore.id,
        "",
        "GET",
        undefined,
        world.otherCookie,
      )
    ).status,
  ).toBe(403);

  for (const previous of [legacyBefore, kernelBefore]) {
    const id = previous.id === legacyBefore.id ? world.assignmentId : world.id;
    const oldClient = await world.plainPost(id, world.ownerCookie);
    expect(oldClient.status).toBe(200);
    expect(attemptStartOkSchema.parse(await oldClient.json()).data).toEqual(
      previous,
    );
  }

  const refreshed = await world.proofPost(
    world.assignmentId,
    world.ownerCookie,
  );
  expect(refreshed.status).toBe(200);
  const legacyAfter = attemptStartOkSchema.parse(await refreshed.json()).data;
  expect(legacyAfter).toMatchObject({
    id: legacyBefore.id,
    startedAt: legacyBefore.startedAt,
    phase: "opened",
  });
  expect(Date.parse(legacyAfter.frozenAt ?? "")).toBeGreaterThan(
    Date.parse(legacyBefore.frozenAt ?? ""),
  );
  const legacyAfterView = await world.detail(legacyAfter.id);
  const reordered = legacyAfterView.units.flatMap((unit) => unit.questions);
  expect(reordered.map((question) => question.id)).toEqual([
    "m04-p0-q2",
    "m04-p0-q1",
  ]);
  expect(reordered[1]?.stemMd).toContain("凭据试验新版");
  expect(reordered[1]?.questionRevisionId).not.toBe(
    oldQuestion.questionRevisionId,
  );
  const repeated = await world.proofPost(world.assignmentId, world.ownerCookie);
  expect(repeated.status).toBe(200);
  expect(attemptStartOkSchema.parse(await repeated.json()).data).toEqual(
    legacyAfter,
  );
  expect(await world.detail(legacyAfter.id)).toEqual(legacyAfterView);

  const answer = { kind: "choice", index: 1 };
  const url = `/answers/${oldQuestion.id}`;
  for (const [proof, error] of [
    [{ expectedFrozenAt: legacyBefore.frozenAt }, "ATTEMPT_SNAPSHOT_CHANGED"],
    [
      { questionRevisionId: oldQuestion.questionRevisionId },
      "QUESTION_REVISION_STALE",
    ],
  ] as const) {
    const refused = await world.ownedRequest(legacyAfter.id, url, "PUT", {
      answer,
      ...proof,
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error });
  }
  const accepted = await world.ownedRequest(legacyAfter.id, url, "PUT", {
    answer,
    expectedFrozenAt: legacyAfter.frozenAt,
    questionRevisionId: reordered[1]?.questionRevisionId,
  });
  expect(accepted.status).toBe(200);

  const kernelAfter = await world.open();
  expect(kernelAfter).toMatchObject({
    id: kernelBefore.id,
    startedAt: kernelBefore.startedAt,
    phase: "opened",
  });
  expect(Date.parse(kernelAfter.frozenAt ?? "")).toBeGreaterThan(
    Date.parse(kernelBefore.frozenAt ?? ""),
  );
  const own = await world.detail(kernelAfter.id);
  const latest = own.units.flatMap((unit) => unit.questions);
  expect(latest.map(({ id }) => id)).toEqual(["m04-p0-q2", "m04-p0-q1"]);
  expect(latest[1]?.stemMd).toContain("凭据试验新版");
  expect(latest[1]?.questionRevisionId).not.toBe(
    kernelBeforeView.units[0]?.questions[0]?.questionRevisionId,
  );
  expect(await world.open()).toEqual(kernelAfter);
  expect(await world.detail(kernelAfter.id)).toEqual(own);
  expect(
    world.kernel().prepare("SELECT id, practice_version FROM activities").all(),
  ).toEqual([{ id: kernelBefore.id, practice_version: 2 }]);
});

async function faultAfterKernelRefreeze(
  world: Awaited<ReturnType<typeof fixture>>,
) {
  const first = await world.open();
  const draft = await world.detail(first.id);
  const row = draft.units[0]?.questions[0];
  if (!row || !first.frozenAt) throw new Error("缺少原冻结题凭据");
  const imported = await world.teacherRequest("import/commit", "POST", {
    filename: "M04P0.md",
    markdown: reversedFixture("权威已换版：2 + 3 是多少？"),
  });
  expect(imported.status).toBe(200);
  world.database().exec(`
    CREATE TRIGGER fail_kernel_refreeze_projection
    BEFORE UPDATE OF step_attempt_id ON kernel_attempt_bindings
    BEGIN SELECT RAISE(ABORT, 'forced refreeze projection failure'); END
  `);
  const interrupted = await world.post(world.ownerCookie);
  expect(interrupted.status, await interrupted.clone().text()).toBe(500);
  expect(
    world
      .database()
      .prepare(
        "SELECT practice_version FROM kernel_attempt_bindings WHERE attempt_id=?",
      )
      .get(first.id),
  ).toEqual({ practice_version: 1 });
  expect(
    world
      .kernel()
      .prepare("SELECT id, practice_version FROM activities WHERE id=?")
      .get(first.id),
  ).toEqual({ id: first.id, practice_version: 2 });
  const pending = () =>
    world
      .database()
      .prepare(
        "SELECT operation_id FROM kernel_attempt_refreezes WHERE attempt_id=?",
      )
      .get(first.id);
  expect(pending()).toEqual({ operation_id: expect.any(String) });
  world.database().exec("DROP TRIGGER fail_kernel_refreeze_projection");
  return { first, draft, row, frozenAt: first.frozenAt, pending };
}

it("K 已换版但 P 未投影时独立连接拒绝旧写入，授权读恢复同一回执", async () => {
  const world = await fixture();
  const { first, draft, row, frozenAt, pending } =
    await faultAfterKernelRefreeze(world);
  const proof = {
    expectedFrozenAt: frozenAt,
    questionRevisionId: row.questionRevisionId,
  };
  world.restart();
  const competing = world.independentApp();
  const ownPath = `/api/student/attempts/${first.id}`;
  const noteForm = putNoteBodyForm(gzipJson(noteDoc()));
  noteForm.set("expectedFrozenAt", frozenAt);
  const operations = [
    [
      "PUT",
      `/answers/${row.id}`,
      { answer: { kind: "choice", index: 1 }, ...proof },
    ],
    ["PUT", `/flags/${row.id}`, { flag: "unsure", expectedFrozenAt: frozenAt }],
    ["PUT", `/notes/${row.id}`, noteForm],
    ["POST", "/activate", { expectedFrozenAt: frozenAt }],
    [
      "POST",
      "/submit",
      {
        revisions: draft.units.flatMap((unit) =>
          unit.questions.map((question) => ({
            questionId: question.id,
            questionRevisionId: question.questionRevisionId,
            expectedAnswerRevision: 0,
          })),
        ),
      },
    ],
  ] as const;
  for (const [method, path, body] of operations) {
    const form = body instanceof FormData;
    const refused = await competing.request(`${ownPath}${path}`, {
      method,
      body: form ? body : JSON.stringify(body),
      headers: form
        ? { cookie: world.ownerCookie }
        : { cookie: world.ownerCookie, "content-type": "application/json" },
    });
    expect(refused.status, `${path}: ${await refused.clone().text()}`).toBe(
      503,
    );
    expect(await refused.json()).toMatchObject({
      error: "KERNEL_ATTEMPT_REFREEZE_PENDING",
    });
  }
  expect(
    world.database().prepare("SELECT COUNT(*) AS count FROM notes").get(),
  ).toEqual({ count: 0 });
  expect(
    world
      .database()
      .prepare(
        "SELECT COUNT(*) AS count FROM responses WHERE student_flag IS NOT NULL OR answer_json IS NOT NULL",
      )
      .get(),
  ).toEqual({ count: 0 });
  expect(
    world.kernel().prepare("SELECT COUNT(*) AS count FROM works").get(),
  ).toEqual({ count: 0 });
  expect(
    world.kernel().prepare("SELECT COUNT(*) AS count FROM submissions").get(),
  ).toEqual({ count: 0 });

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
  expect(pending()).toBeTruthy();
  const removed = await world.teacherRequest(
    `assignments/${world.id}`,
    "PATCH",
    { removeStudentIds: [world.studentId] },
  );
  expect(removed.status).toBe(200);
  expect((await world.post(world.ownerCookie)).status).toBe(403);
  expect(pending()).toBeTruthy();

  const recovered = await world.detail(first.id);
  const updated = recovered.units.flatMap((unit) => unit.questions);
  expect(updated.map((question) => question.id)).toEqual([
    "m04-p0-q2",
    "m04-p0-q1",
  ]);
  expect(updated[1]?.stemMd).toContain("权威已换版");
  expect(updated[1]?.questionRevisionId).not.toBe(row.questionRevisionId);
  expect(pending()).toBeUndefined();
  expect(
    world
      .kernel()
      .prepare(
        "SELECT COUNT(*) AS count FROM prepared_activity_version_changes",
      )
      .get(),
  ).toEqual({ count: 1 });
  world.restart();
  expect(await world.detail(first.id)).toEqual(recovered);
  const refused = await world.ownedRequest(
    first.id,
    `/answers/${row.id}`,
    "PUT",
    { answer: { kind: "choice", index: 1 }, ...proof },
  );
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    error: "QUESTION_REVISION_STALE",
  });
});

it("K 先落草稿而 P 激活失败仍保留原冻结版本和答案", async () => {
  const world = await fixture();
  const first = await world.open();
  const original = await world.detail(first.id);
  const row = original.units[0]?.questions[0];
  if (!row) throw new Error("缺少原冻结题");
  world.database().exec(`
    CREATE TRIGGER fail_kernel_activity_projection
    BEFORE UPDATE OF activated_at ON attempts
    BEGIN SELECT RAISE(ABORT, 'forced activation projection failure'); END
  `);
  const saved = await world.ownedRequest(
    first.id,
    `/answers/${row.id}`,
    "PUT",
    {
      answer: { kind: "choice", index: 1 },
      questionRevisionId: row.questionRevisionId,
      expectedFrozenAt: first.frozenAt,
    },
  );
  expect(saved.status).toBe(500);
  expect(
    world
      .database()
      .prepare("SELECT activated_at FROM attempts WHERE id=?")
      .get(first.id),
  ).toEqual({ activated_at: null });
  expect(
    world.kernel().prepare("SELECT COUNT(*) AS count FROM works").get(),
  ).toEqual({ count: 1 });
  world.database().exec("DROP TRIGGER fail_kernel_activity_projection");
  const changed = await world.teacherRequest("import/commit", "POST", {
    filename: "M04P0.md",
    markdown: reversedFixture("有 K 草稿后改题"),
  });
  expect(changed.status).toBe(200);
  const recovered = await world.open();
  expect(recovered).toMatchObject({
    id: first.id,
    frozenAt: first.frozenAt,
    phase: "active",
  });
  expect(await world.detail(first.id)).toMatchObject({
    units: original.units,
    drafts: { [row.id]: { kind: "choice", index: 1 } },
  });
  expect(
    world.kernel().prepare("SELECT id, practice_version FROM activities").all(),
  ).toEqual([{ id: first.id, practice_version: 1 }]);
  expect(
    world
      .database()
      .prepare("SELECT COUNT(*) AS count FROM kernel_attempt_refreezes")
      .get(),
  ).toEqual({ count: 0 });
});

it("K 已从 v2 返回 v1 时拒绝把历史换版回执投影成当前卷", async () => {
  const world = await fixture();
  const { first, pending } = await faultAfterKernelRefreeze(world);
  const runtime = openLearningRuntime({
    databasePath: join(world.dataDir, "learning-kernel.sqlite"),
  });
  const owner = { role: "student", id: world.studentId } as const;
  try {
    const present = z
      .object({ stepAttemptId: z.uuid(), practiceVersion: z.literal(2) })
      .parse(runtime.read(owner, first.id));
    const reversed = runtime.replacePreparedActivityVersion(owner, first.id, {
      protocolVersion: 1,
      operationId: "separate-host-aba",
      stepAttemptId: present.stepAttemptId,
      expectedPracticeVersion: 2,
      practiceVersion: 1,
    });
    expect(reversed.stepAttemptId).not.toBe(present.stepAttemptId);
  } finally {
    runtime.close();
  }
  world.restart();
  for (const request of [
    await world.post(world.ownerCookie),
    await world.ownedRequest(first.id),
  ]) {
    expect(request.status).toBe(503);
    expect(await request.json()).toMatchObject({
      error: "KERNEL_ATTEMPT_UNAVAILABLE",
    });
  }
  expect(pending()).toBeTruthy();
  expect(
    world
      .database()
      .prepare("SELECT frozen_at FROM attempts WHERE id=?")
      .get(first.id),
  ).toEqual({ frozen_at: first.frozenAt });
  expect(
    world.kernel().prepare("SELECT id, practice_version FROM activities").all(),
  ).toEqual([{ id: first.id, practice_version: 1 }]);
});

it("空正文可能待补图且已预留、另一卷已标旗时继续使用各自原版", async () => {
  const world = await fixture();
  const first = await world.open();
  const second = await world.open(world.otherCookie);
  const before = await world.detail(first.id);
  const q1 = before.units[0]?.questions[0];
  if (!first.frozenAt || !second.frozenAt || !q1)
    throw new Error("缺少原冻结凭据");
  const enabled = await world.teacherRequest(
    "settings/capability-profile",
    "PUT",
    { enabledCapabilities: ["ink"] },
  );
  expect(enabled.status).toBe(200);

  const form = putNoteBodyForm(gzipJson(noteDoc(0)));
  form.set("expectedFrozenAt", first.frozenAt);
  const created = await world.ownedRequest(
    first.id,
    `/notes/${q1.id}`,
    "PUT",
    form,
  );
  expect(created.status).toBe(200);
  const { data: note } = z
    .object({ data: noteVersionReceiptSchema })
    .parse(await created.json());
  expect(
    world
      .database()
      .prepare("SELECT activated_at FROM attempts WHERE id=?")
      .get(first.id),
  ).toEqual({ activated_at: null });
  const original = await world.noteDocument(note.versionId);
  expect(original.status).toBe(200);
  const originalBytes = Buffer.from(await original.arrayBuffer());
  const product = createDb(join(world.dataDir, "product.sqlite"));
  try {
    const reserved = reserveSubmissionOriginals(product, world.dataDir, {
      operationId: randomUUID(),
      attemptId: first.id,
      studentId: world.studentId,
      originals: [
        {
          questionId: q1.id,
          versionId: note.versionId,
          revision: note.revision,
        },
      ],
    });
    expect(reserved).toHaveLength(1);
  } finally {
    product.$client.close();
  }
  const flagged = await world.ownedRequest(
    second.id,
    `/flags/${q1.id}`,
    "PUT",
    {
      flag: "unsure",
      expectedFrozenAt: second.frozenAt,
    },
    world.otherCookie,
  );
  expect(flagged.status).toBe(200);

  const changed = await world.teacherRequest("import/commit", "POST", {
    filename: "M04P0.md",
    markdown: reversedFixture("有原稿和旗标时改题"),
  });
  expect(changed.status).toBe(200);
  expect(await world.open()).toEqual(first);
  expect(await world.open(world.otherCookie)).toMatchObject({
    id: second.id,
    frozenAt: second.frozenAt,
    phase: "active",
  });
  expect((await world.detail(first.id)).units).toEqual(before.units);
  const retained = await world.noteDocument(note.versionId);
  expect(retained.status).toBe(200);
  expect(Buffer.from(await retained.arrayBuffer())).toEqual(originalBytes);
  expect(
    world
      .database()
      .prepare("SELECT pending_version_id FROM attempt_original_reservations")
      .get(),
  ).toEqual({ pending_version_id: note.versionId });
  expect(
    world
      .database()
      .prepare(
        "SELECT student_flag FROM responses WHERE attempt_id=? AND question_id=?",
      )
      .get(second.id, q1.id),
  ).toEqual({ student_flag: "unsure" });
  expect(
    world
      .kernel()
      .prepare(
        "SELECT COUNT(*) AS count FROM prepared_activity_version_changes",
      )
      .get(),
  ).toEqual({ count: 0 });
});

async function requestFromAnotherProcess(
  dataDir: string,
  path: string,
  cookie: string,
  method: string,
  body: object,
) {
  const script = `
    import pino from "pino";
    import { join } from "node:path";
    import { createApp } from ${JSON.stringify(new URL("../app.ts", import.meta.url).href)};
    import { createDb } from ${JSON.stringify(new URL("../db/client.ts", import.meta.url).href)};
    const input = JSON.parse(process.env.OWNCLASS_REFREEZE_HTTP_INPUT);
    const db = createDb(join(input.dataDir, "product.sqlite"));
    try {
      const app = createApp({
        db, dataDir: input.dataDir, isProduction: false,
        publicUrl: "http://localhost:8787", logger: pino({ enabled: false }),
      });
      const response = await app.request(input.path, {
        method: input.method, body: JSON.stringify(input.body),
        headers: { cookie: input.cookie, "content-type": "application/json",
          [input.proofHeader]: "1" },
      });
      process.stdout.write(JSON.stringify({ status: response.status, payload: await response.json() }));
    } finally {
      db.$client.close();
    }
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      windowsHide: true,
      timeout: 25000,
      env: {
        ...process.env,
        OWNCLASS_REFREEZE_HTTP_INPUT: JSON.stringify({
          dataDir,
          path,
          cookie,
          method,
          body,
          proofHeader: ATTEMPT_SNAPSHOT_PROOF_HEADER,
        }),
      },
    },
  );
  return z
    .object({ status: z.int(), payload: z.unknown() })
    .parse(JSON.parse(stdout));
}

it("两个独立 Node 进程竞争恢复只向产品投影一份冻结卷", async () => {
  const world = await fixture();
  const { first, row, frozenAt, pending } =
    await faultAfterKernelRefreeze(world);
  const flag = await requestFromAnotherProcess(
    world.dataDir,
    `/api/student/attempts/${first.id}/flags/${row.id}`,
    world.ownerCookie,
    "PUT",
    { flag: "unsure", expectedFrozenAt: frozenAt },
  );
  expect(flag).toMatchObject({
    status: 503,
    payload: { error: "KERNEL_ATTEMPT_REFREEZE_PENDING" },
  });
  const reopen = () =>
    requestFromAnotherProcess(
      world.dataDir,
      `/api/student/assignments/${world.id}/attempt`,
      world.ownerCookie,
      "POST",
      {},
    );
  const [firstProcess, secondProcess] = await Promise.all([reopen(), reopen()]);
  expect(firstProcess.status).toBe(200);
  expect(secondProcess).toEqual(firstProcess);
  const accepted = attemptStartOkSchema.parse(firstProcess.payload).data;
  expect(accepted.id).toBe(first.id);
  expect(accepted.frozenAt).not.toBe(frozenAt);
  expect(pending()).toBeUndefined();
  expect(
    world
      .kernel()
      .prepare(
        "SELECT COUNT(*) AS count FROM prepared_activity_version_changes",
      )
      .get(),
  ).toEqual({ count: 1 });
  expect(
    world
      .database()
      .prepare(
        "SELECT COUNT(*) AS count FROM responses WHERE attempt_id=? AND student_flag IS NULL",
      )
      .get(first.id),
  ).toEqual({ count: 2 });
}, 45000);

it.each(["无凭据重开", "撤名单后本人读卷"])(
  "P 已登记但 K 未换时，%s可恢复原凭据",
  async (mode) => {
    const world = await fixture();
    const first = await world.open();
    const original = await world.detail(first.id);
    const question = original.units[0]?.questions[0];
    if (!question) throw new Error("缺少冻结题");
    const changed = await world.teacherRequest("import/commit", "POST", {
      filename: "M04P0.md",
      markdown: reversedFixture("K 尚未换版时导入新版"),
    });
    expect(changed.status).toBe(200);
    const kernelPath = join(world.dataDir, "learning-kernel.sqlite");
    const kernelWriter = new DatabaseSync(kernelPath);
    try {
      kernelWriter.exec(`
        CREATE TRIGGER fail_before_kernel_refreeze
        BEFORE INSERT ON practices WHEN NEW.version = 2
        BEGIN SELECT RAISE(ABORT, 'forced publication failure before refreeze'); END
      `);
      const failed = await world.post(world.ownerCookie);
      expect(failed.status).toBe(500);
      expect(
        kernelWriter
          .prepare("SELECT id, practice_version FROM activities")
          .all(),
      ).toEqual([{ id: first.id, practice_version: 1 }]);
      expect(
        kernelWriter
          .prepare(
            "SELECT COUNT(*) AS count FROM prepared_activity_version_changes",
          )
          .get(),
      ).toEqual({ count: 0 });
      kernelWriter.exec("DROP TRIGGER fail_before_kernel_refreeze");
    } finally {
      kernelWriter.close();
    }

    const pending = () =>
      world
        .database()
        .prepare(
          "SELECT operation_id FROM kernel_attempt_refreezes WHERE attempt_id=?",
        )
        .get(first.id);
    expect(pending()).toBeTruthy();
    world.restart();
    const temporarilyHeld = join(world.dataDir, "learning.held");
    renameSync(kernelPath, temporarilyHeld);
    try {
      expect((await world.ownedRequest(first.id)).status).toBe(503);
      expect(pending()).toBeTruthy();
    } finally {
      renameSync(temporarilyHeld, kernelPath);
    }

    if (mode === "无凭据重开") {
      const old = await world.plainPost(world.id, world.ownerCookie);
      expect(old.status, await old.clone().text()).toBe(200);
      expect(attemptStartOkSchema.parse(await old.json()).data).toEqual(first);
    } else {
      const removed = await world.teacherRequest(
        `assignments/${world.id}`,
        "PATCH",
        { removeStudentIds: [world.studentId] },
      );
      expect(removed.status).toBe(200);
      expect((await world.post(world.ownerCookie)).status).toBe(403);
      expect(await world.detail(first.id)).toEqual(original);
    }
    expect(pending()).toBeUndefined();
    expect(await world.detail(first.id)).toEqual(original);
    const oldWrite = await world.ownedRequest(
      first.id,
      `/answers/${question.id}`,
      "PUT",
      {
        answer: { kind: "choice", index: 1 },
      },
    );
    expect(oldWrite.status, await oldWrite.clone().text()).toBe(200);
    expect(
      world
        .kernel()
        .prepare("SELECT id, practice_version FROM activities")
        .all(),
    ).toEqual([{ id: first.id, practice_version: 1 }]);
    expect(
      world
        .kernel()
        .prepare(
          "SELECT COUNT(*) AS count FROM prepared_activity_version_changes",
        )
        .get(),
    ).toEqual({ count: 0 });
  },
);

it("旧的未投影开卷意图缺准备标志时继续得到历史不可换版卷", async () => {
  const world = await fixture();
  world.database().exec(`
    CREATE TRIGGER old_opening_draft_format
    AFTER INSERT ON kernel_assignment_openings
    BEGIN
      UPDATE kernel_assignment_openings SET draft_json=json_remove(draft_json, '$.prepared')
      WHERE assignment_id=NEW.assignment_id AND student_id=NEW.student_id;
    END
  `);
  const first = await world.open();
  expect(first.phase).toBe("opened");
  const old = await world.detail(first.id);
  world.database().exec("DROP TRIGGER old_opening_draft_format");
  const changed = await world.teacherRequest("import/commit", "POST", {
    filename: "M04P0.md",
    markdown: reversedFixture("旧开卷不换版"),
  });
  expect(changed.status).toBe(200);
  world.restart();
  expect(await world.open()).toEqual(first);
  expect(await world.detail(first.id)).toEqual(old);
  expect(
    world
      .kernel()
      .prepare(
        "SELECT id, practice_version, initial_prepared_practice_version AS prepared FROM activities",
      )
      .all(),
  ).toEqual([{ id: first.id, practice_version: 1, prepared: null }]);
});
