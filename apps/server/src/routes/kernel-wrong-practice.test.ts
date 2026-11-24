import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ATTEMPT_SNAPSHOT_PROOF_HEADER,
  adminTeacherCreateOkSchema,
  attemptDraftOkSchema,
  attemptResultOkSchema,
  attemptStartOkSchema,
  BACKUP_KERNEL_ARTIFACT,
  BACKUP_KERNEL_DATABASE,
  BACKUP_KERNEL_MANIFEST,
  backupKernelManifestSchema,
  importCommitOkSchema,
  studentRecordsOkSchema,
  teacherAttemptDetailOkSchema,
  teacherAttemptListDataSchema,
  teacherInfoOkSchema,
  wrongPracticeOkSchema,
  wrongQuestionsOkSchema,
} from "@tutor/contract";
import { ZipArchive } from "archiver";
import { openLearningRuntime } from "learning-kernel";
import pino from "pino";
import { expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../app.ts";
import { createDbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { readZipEntriesMap } from "../lib/zip-read.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { zipToBackupBuffer } from "../test/backup-fixtures.ts";
import {
  assignFixture,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import { extractSessionToken } from "../test/note-world.ts";
import {
  fetchSubmitRevisions,
  submitAttemptRequest,
} from "../test/submit-revisions.ts";

const questionId = "m04-p0-q1";
const listPath = "/api/student/wrong-questions?includeResolved=true";
const wrongPath = "/api/student/wrong-practice";

const wholeSelection = () => ({
  questionIds: [questionId, "m04-p0-q2"],
  scope: { kind: "selection", questionCount: 2 },
  operationId: randomUUID(),
  workflowVersion: 1,
  feedbackMode: "after_attempt",
});

function jsonCall(
  app: ReturnType<typeof createApp>,
  path: string,
  cookie: string,
  method = "GET",
  body?: object,
) {
  return app.request(path, {
    method,
    headers: {
      cookie,
      [ATTEMPT_SNAPSHOT_PROOF_HEADER]: "1",
      ...(body && { "content-type": "application/json" }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
}

async function saveChoice(
  app: ReturnType<typeof createApp>,
  cookie: string,
  id: string,
  index: number,
  targetQuestion = questionId,
) {
  const path = `/api/student/attempts/${id}`;
  const result = await jsonCall(app, path, cookie);
  expect(result.status).toBe(200);
  const payload: unknown = await result.json();
  assertNoLeak(payload);
  const draft = attemptDraftOkSchema.parse(payload).data;
  const question = draft.units
    .flatMap(({ questions }) => questions)
    .find(({ id }) => id === targetQuestion);
  expect(question).toBeDefined();
  return jsonCall(app, `${path}/answers/${targetQuestion}`, cookie, "PUT", {
    answer: { kind: "choice", index },
    baseRevision: 0,
    mutationId: randomUUID(),
    expectedFrozenAt: draft.attempt.frozenAt,
    questionRevisionId: question?.questionRevisionId,
  });
}

async function seedPublishedWrongChoice(app: ReturnType<typeof createApp>) {
  const world = await setupAssignment(app);
  const settings = await jsonCall(
    app,
    "/api/teacher/settings/practice-feedback",
    world.teacher,
    "PUT",
    { practiceFeedbackPolicy: "after_attempt" },
  );
  expect(settings.status).toBe(200);
  const started = await postAssignment(
    app,
    world.assignmentId,
    world.ownerCookie,
  );
  const sourceId = attemptStartOkSchema.parse(await started.json()).data.id;
  expect((await saveChoice(app, world.ownerCookie, sourceId, 0)).status).toBe(
    200,
  );
  expect(
    (await submitAttemptRequest(app, world.ownerCookie, sourceId)).status,
  ).toBe(200);
  return { ...world, sourceId };
}

it("本人已公布的单选错题在整卷试点由内核开卷并正式结算", async () => {
  const db = createTestDb();
  const dataDir = createTestDir();
  const open = (kernelWrongPracticeEnabled: boolean) => {
    return createApp({
      kernelWrongPracticeEnabled,
      db,
      dataDir,
      isProduction: false,
      logger: pino({ enabled: false }),
      publicUrl: "http://localhost:8787",
    });
  };
  const app = open(true);
  const { sourceId, ownerCookie, otherCookie, teacher } =
    await seedPublishedWrongChoice(app);
  const cards = wrongQuestionsOkSchema.parse(
    await (await jsonCall(app, listPath, ownerCookie)).json(),
  );
  expect(cards.data.questions.map((card) => card.questionId)).toEqual([
    questionId,
  ]);

  const body = wholeSelection();
  const start = (current = app, cookie = ownerCookie, input = body) =>
    jsonCall(current, wrongPath, cookie, "POST", input);
  expect((await start(app, otherCookie)).status).toBe(400);
  const created = await start();
  expect(created.status).toBe(201);
  const payload: unknown = await created.json();
  assertNoLeak(payload);
  const { data: wrong } = wrongPracticeOkSchema.parse(payload);
  expect(wrong).toMatchObject({
    sourceType: "wrong",
    assignmentId: null,
    courseId: null,
    unitId: null,
    attemptNo: 1,
  });
  const disabled = open(false);
  const replay = await start(disabled);
  expect(replay.status).toBe(201);
  expect(wrongPracticeOkSchema.parse(await replay.json()).data.id).toBe(
    wrong.id,
  );
  expect(
    (
      await start(app, ownerCookie, {
        ...body,
        questionIds: [questionId],
        scope: { kind: "selection", questionCount: 1 },
      })
    ).status,
  ).toBe(409);
  const path = `/api/student/attempts/${wrong.id}`;
  expect((await jsonCall(app, path, otherCookie)).status).toBe(403);
  for (const suffix of ["/context", "/paper"]) {
    const view = await jsonCall(app, path + suffix, ownerCookie);
    expect(view.status).toBe(200);
    assertNoLeak(await view.json());
    expect((await jsonCall(app, path + suffix, otherCookie)).status).toBe(403);
  }

  const kernelPath = join(dataDir, "learning-kernel.sqlite");
  const activities = existsSync(kernelPath)
    ? (() => {
        const kernel = new DatabaseSync(kernelPath, { readOnly: true });
        try {
          return kernel
            .prepare("SELECT id FROM activities")
            .all()
            .map(({ id }) => id);
        } finally {
          kernel.close();
        }
      })()
    : [];
  expect(activities).toEqual([wrong.id]);
  const { operationId: _operationId, ...withoutKey } = body;
  const oldRequest = await jsonCall(
    app,
    wrongPath,
    ownerCookie,
    "POST",
    withoutKey,
  );
  expect(oldRequest.status).toBe(201);
  expect(
    wrongPracticeOkSchema.parse(await oldRequest.json()).data.attemptNo,
  ).toBe(2);
  expect(
    db.$client.prepare("SELECT count(*) AS n FROM kernel_wrong_openings").get(),
  ).toEqual({ n: 1 });
  const flag = await jsonCall(
    app,
    `${path}/flags/${questionId}`,
    ownerCookie,
    "PUT",
    {
      flag: null,
      expectedFrozenAt: wrong.frozenAt,
    },
  );
  expect(flag.status).toBe(200);

  expect(
    (
      await jsonCall(
        app,
        "/api/teacher/settings/practice-feedback",
        teacher,
        "PUT",
        {
          practiceFeedbackPolicy: "student_choice",
        },
      )
    ).status,
  ).toBe(200);
  const changeMode = (id: string) =>
    jsonCall(
      app,
      `/api/student/attempts/${id}/workflow`,
      ownerCookie,
      "PATCH",
      {
        feedbackMode: "per_question",
        workflowRevision: 0,
      },
    );
  const fixed = await changeMode(wrong.id);
  expect(fixed.status).toBe(400);
  expect(await fixed.json()).toMatchObject({
    error: "WORKFLOW_MODE_NOT_ALLOWED",
  });
  const legacy = await start(app, ownerCookie, wholeSelection());
  expect(legacy.status).toBe(201);
  const legacyId = wrongPracticeOkSchema.parse(await legacy.json()).data.id;
  expect((await changeMode(legacyId)).status).toBe(200);

  expect((await saveChoice(disabled, ownerCookie, wrong.id, 1)).status).toBe(
    200,
  );
  const submitted = await submitAttemptRequest(disabled, ownerCookie, wrong.id);
  expect(submitted.status).toBe(200);
  expect((await submitAttemptRequest(app, ownerCookie, wrong.id)).status).toBe(
    409,
  );
  const settledReplay = await start(disabled);
  expect(settledReplay.status).toBe(201);
  expect(
    wrongPracticeOkSchema.parse(await settledReplay.json()).data,
  ).toMatchObject({
    id: wrong.id,
    status: "graded",
    scoreAuto: 100,
  });
  const result = await jsonCall(disabled, path, ownerCookie);
  const detail = attemptResultOkSchema.parse(await result.json()).data;
  expect(detail.units.flatMap(({ questions }) => questions)).toMatchObject([
    { questionId, autoCorrect: true },
  ]);
  const history = wrongQuestionsOkSchema.parse(
    await (await jsonCall(disabled, listPath, ownerCookie)).json(),
  );
  expect(
    history.data.questions[0]?.rounds.map(({ attemptId, correct }) => ({
      attemptId,
      correct,
    })),
  ).toEqual([
    { attemptId: sourceId, correct: false },
    { attemptId: wrong.id, correct: true },
  ]);
  const records = await jsonCall(
    disabled,
    "/api/student/records?sourceType=wrong",
    ownerCookie,
  );
  const wrongRecord = studentRecordsOkSchema
    .parse(await records.json())
    .data.records.find(({ attemptId }) => attemptId === wrong.id);
  expect(wrongRecord).toMatchObject({
    score: 100,
    resultCounts: { correctCount: 1 },
  });

  const otherTeacherName = "错题重练异域教师";
  const createdTeacher = await jsonCall(
    app,
    "/api/admin/teachers",
    teacher,
    "POST",
    {
      loginName: otherTeacherName,
    },
  );
  expect(createdTeacher.status).toBe(201);
  const { initialPassword } = adminTeacherCreateOkSchema.parse(
    await createdTeacher.json(),
  ).data;
  const foreignLogin = await jsonCall(
    app,
    "/api/public/teacher/login",
    "",
    "POST",
    {
      loginName: otherTeacherName,
      password: initialPassword,
    },
  );
  expect(foreignLogin.status).toBe(200);
  const foreignTeacher = `tutor_session=${extractSessionToken(foreignLogin)}`;
  const teacherPath = `/api/teacher/attempts/${wrong.id}`;
  const teacherListPath =
    "/api/teacher/attempts?sourceType=wrong&status=graded";
  const teacherView = await jsonCall(disabled, teacherPath, teacher);
  expect(teacherView.status).toBe(200);
  expect((await jsonCall(disabled, teacherPath, foreignTeacher)).status).toBe(
    404,
  );
  const teacherList = async (cookie: string) => {
    const view = await jsonCall(disabled, teacherListPath, cookie);
    expect(view.status).toBe(200);
    return z
      .object({ data: teacherAttemptListDataSchema })
      .parse(await view.json()).data.attempts;
  };
  expect(await teacherList(foreignTeacher)).toEqual([]);
  const single = teacherAttemptDetailOkSchema.parse(
    await teacherView.json(),
  ).data;
  const listed = (await teacherList(teacher)).find(
    ({ attemptId }) => attemptId === wrong.id,
  );
  expect({ single, listed }).toMatchObject({
    single: { scoreAuto: 100, questions: [{ questionId, finalCorrect: true }] },
    listed: { scoreAuto: 100, resultCounts: { correctCount: 1 } },
  });
});

it("冻结题 ID 超出 K27 发布范围时仍能通过旧宿主组卷", async () => {
  const db = createTestDb();
  const dataDir = createTestDir();
  const app = createApp({
    db,
    dataDir,
    kernelWrongPracticeEnabled: true,
    isProduction: false,
    logger: pino({ enabled: false }),
    publicUrl: "http://localhost:8787",
  });
  const { teacher, studentId, ownerCookie } =
    await seedPublishedWrongChoice(app);
  const longId = "q".repeat(129);
  const imported = await jsonCall(
    app,
    "/api/teacher/import/commit",
    teacher,
    "POST",
    {
      filename: "历史长题号.md",
      markdown: `---\nkind: practice\nunit: 历史长题号\n---\n\n::::question{id=${longId} type=choice}\n合成选择题。\n\n- [x] 甲\n- [ ] 乙\n::::\n`,
    },
  );
  expect(imported.status).toBe(200);
  const [unit] = importCommitOkSchema.parse(await imported.json()).data.units;
  if (!unit) throw new Error("缺少长题号题目来源");
  const assignmentId = await assignFixture(app, teacher, unit.id, studentId);
  const source = await postAssignment(app, assignmentId, ownerCookie);
  const sourceId = attemptStartOkSchema.parse(await source.json()).data.id;
  expect((await saveChoice(app, ownerCookie, sourceId, 1, longId)).status).toBe(
    200,
  );
  expect((await submitAttemptRequest(app, ownerCookie, sourceId)).status).toBe(
    200,
  );
  const start = await jsonCall(app, wrongPath, ownerCookie, "POST", {
    questionIds: [longId],
    operationId: randomUUID(),
    workflowVersion: 1,
    feedbackMode: "after_attempt",
  });
  expect(start.status).toBe(201);
  const { data: attempt } = wrongPracticeOkSchema.parse(await start.json());
  expect(
    db.$client.prepare("SELECT count(*) AS n FROM kernel_wrong_openings").get(),
  ).toEqual({ n: 0 });
  expect(existsSync(join(dataDir, BACKUP_KERNEL_DATABASE))).toBe(false);
  expect(
    (await saveChoice(app, ownerCookie, attempt.id, 0, longId)).status,
  ).toBe(200);
  expect(
    (await submitAttemptRequest(app, ownerCookie, attempt.id)).status,
  ).toBe(200);
});

async function rezip(entries: ReadonlyMap<string, Buffer>) {
  const stream = new ZipArchive();
  const bytes = zipToBackupBuffer({ stream, filename: "wrong-test.zip" });
  for (const [name, content] of entries) stream.append(content, { name });
  await stream.finalize();
  return new Uint8Array(await bytes);
}

it("错题独立双库恢复覆盖开卷两侧中断和交卷投影，拒绝缺库与跨代包", async () => {
  const dataDir = createTestDir();
  const handle = createDbHandle(join(dataDir, "tutor.db"), runMigrations);
  const kernelPath = join(dataDir, BACKUP_KERNEL_DATABASE);
  const appWith = (
    kernelWrongPracticeEnabled: boolean,
    backupOperatorId?: string,
  ) =>
    createApp({
      db: handle.db,
      dbHandle: handle,
      dataDir,
      backupOperatorId,
      kernelWrongPracticeEnabled,
      isProduction: false,
      logger: pino({ enabled: false }),
      publicUrl: "http://localhost:8787",
    });
  function kernelQuery(statement: string) {
    using kernel = new DatabaseSync(kernelPath, { readOnly: true });
    return kernel.prepare(statement).all();
  }
  function kernelExec(statement: string) {
    using kernel = new DatabaseSync(kernelPath);
    kernel.exec(statement);
  }

  try {
    const app = appWith(true);
    const { ownerCookie, otherCookie, teacher, sourceId } =
      await seedPublishedWrongChoice(app);
    const profile = await jsonCall(app, "/api/teacher/me", teacher);
    const operator = teacherInfoOkSchema.parse(await profile.json()).data.id;
    const disabled = appWith(false, operator);
    const body = wholeSelection();
    const open = (current: ReturnType<typeof createApp>, input = body) =>
      jsonCall(current, wrongPath, ownerCookie, "POST", input);
    const product = () => handle.db.$client;
    const openings = () =>
      product()
        .prepare<[], { attempt_id: string | null }>(
          "SELECT id, attempt_no, attempt_id, step_attempt_id FROM kernel_wrong_openings ORDER BY attempt_no",
        )
        .all();
    const activities = () =>
      kernelQuery(
        "SELECT id, started_at, initial_prepared_step_attempt_id AS step FROM activities ORDER BY rowid",
      );
    const download = async () => {
      const zip = await jsonCall(
        disabled,
        "/api/teacher/backup/download",
        teacher,
      );
      expect(zip.status, await zip.clone().text()).toBe(200);
      return new Uint8Array(await zip.arrayBuffer());
    };
    const restore = (bytes: Uint8Array<ArrayBuffer>) => {
      const form = new FormData();
      form.set("zip", new File([bytes], "wrong-test.zip"));
      form.set("password", "teacher-pass-8");
      return disabled.request("/api/teacher/backup/restore", {
        method: "POST",
        headers: { cookie: teacher },
        body: form,
      });
    };
    const assertRestored = async (bytes: Uint8Array<ArrayBuffer>) => {
      const response = await restore(bytes);
      expect(response.status, await response.clone().text()).toBe(200);
    };
    const assertRejected = async (
      entries: ReadonlyMap<string, Buffer>,
      message: string,
    ) => {
      const response = await restore(await rezip(entries));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "BACKUP_ZIP_INVALID",
        message: expect.stringContaining(message),
      });
    };

    openLearningRuntime({ databasePath: kernelPath }).close();
    kernelExec(`CREATE TRIGGER stop_wrong_prepare BEFORE INSERT ON activities
      BEGIN SELECT RAISE(ABORT, '测试开卷在宿主提交后中断'); END`);
    const preKernel = await open(app);
    expect(preKernel.status).toBe(500);
    expect(openings()).toMatchObject([
      { attempt_no: 1, attempt_id: null, step_attempt_id: null },
    ]);
    expect(activities()).toEqual([]);
    kernelExec("DROP TRIGGER stop_wrong_prepare");
    const productOnlyCut = await download();
    const productOnly = readZipEntriesMap(Buffer.from(productOnlyCut));
    expect(productOnly.has(BACKUP_KERNEL_DATABASE)).toBe(true);
    const noKernel = new Map(productOnly);
    for (const name of [
      BACKUP_KERNEL_DATABASE,
      BACKUP_KERNEL_MANIFEST,
      BACKUP_KERNEL_ARTIFACT,
    ])
      noKernel.delete(name);
    await assertRejected(noKernel, "备份缺少内核数据库");

    await assertRestored(productOnlyCut);
    product().exec(`CREATE TEMP TRIGGER stop_wrong_projection BEFORE INSERT ON attempts
      WHEN NEW.source_type='wrong' BEGIN SELECT RAISE(ABORT, '测试内核开卷后中断投影'); END`);
    expect((await open(disabled)).status).toBe(500);
    const [prepared] = activities();
    expect(activities()).toHaveLength(1);
    expect(openings()).toMatchObject([
      { attempt_id: null, step_attempt_id: null },
    ]);
    product().exec("DROP TRIGGER stop_wrong_projection");
    const preparedCut = await download();
    await assertRestored(preparedCut);
    const opened = await open(disabled);
    expect(opened.status).toBe(201);
    const { data: first } = wrongPracticeOkSchema.parse(await opened.json());
    expect(first).toMatchObject({
      id: prepared?.id,
      startedAt: prepared?.started_at,
      attemptNo: 1,
    });
    expect(openings()).toMatchObject([
      { attempt_id: prepared?.id, step_attempt_id: prepared?.step },
    ]);
    expect(activities()).toEqual([prepared]);
    expect(
      (
        await jsonCall(
          disabled,
          `/api/student/attempts/${first.id}`,
          otherCookie,
        )
      ).status,
    ).toBe(403);

    const secondId = wrongPracticeOkSchema.parse(
      await (await open(app, wholeSelection())).json(),
    ).data.id;
    expect(secondId).not.toBe(first.id);
    expect(openings()).toMatchObject([
      { attempt_no: 1, attempt_id: first.id },
      { attempt_no: 2, attempt_id: secondId },
    ]);
    const later = readZipEntriesMap(Buffer.from(await download()));
    const oldKernel = productOnly.get(BACKUP_KERNEL_DATABASE);
    if (!oldKernel) throw new Error("开卷前备份缺少内核库");
    const manifest = backupKernelManifestSchema.parse(
      JSON.parse(later.get(BACKUP_KERNEL_MANIFEST)?.toString() ?? "null"),
    );
    later.set(BACKUP_KERNEL_DATABASE, oldKernel);
    later.set(
      BACKUP_KERNEL_MANIFEST,
      Buffer.from(
        JSON.stringify({
          ...manifest,
          kernelSha256: createHash("sha256").update(oldKernel).digest("hex"),
        }),
      ),
    );
    await assertRejected(later, "开卷记录与内核实际作答不一致");
    expect(openings().map((row) => row.attempt_id)).toEqual([
      first.id,
      secondId,
    ]);

    expect((await saveChoice(disabled, ownerCookie, first.id, 1)).status).toBe(
      200,
    );
    const path = `/api/student/attempts/${first.id}`;
    const revisions = await fetchSubmitRevisions(
      disabled,
      ownerCookie,
      first.id,
    );
    const submit = () =>
      jsonCall(disabled, `${path}/submit`, ownerCookie, "POST", { revisions });
    product().exec(`CREATE TEMP TRIGGER stop_wrong_confirmation BEFORE UPDATE OF receipt_id ON kernel_question_deliveries
      BEGIN SELECT RAISE(ABORT, '测试内核交卷后中断结算'); END`);
    expect((await submit()).status).toBe(500);
    const receipts = () =>
      product()
        .prepare(
          "SELECT step_attempt_id, operation_id, receipt_id FROM kernel_question_deliveries",
        )
        .all();
    expect(receipts()).toMatchObject([
      { step_attempt_id: prepared?.step, receipt_id: null },
    ]);
    const completed = kernelQuery(
      "SELECT activity_id, submission_id FROM completions",
    );
    expect(completed).toMatchObject([{ activity_id: first.id }]);
    product().exec("DROP TRIGGER stop_wrong_confirmation");
    const confirmedCut = await download();
    await assertRestored(confirmedCut);
    expect(receipts()).toMatchObject([{ receipt_id: null }]);

    const lateFlag = await jsonCall(
      disabled,
      `${path}/flags/${questionId}`,
      ownerCookie,
      "PUT",
      { flag: "unsure", expectedFrozenAt: first.frozenAt },
    );
    expect(lateFlag.status).toBe(409);
    expect(await lateFlag.json()).toMatchObject({ error: "ALREADY_SUBMITTED" });
    await assertRestored(confirmedCut);
    expect(receipts()).toMatchObject([{ receipt_id: null }]);
    const history = wrongQuestionsOkSchema.parse(
      await (await jsonCall(disabled, listPath, ownerCookie)).json(),
    );
    expect(
      history.data.questions[0]?.rounds.map(({ attemptId, correct }) => ({
        attemptId,
        correct,
      })),
    ).toEqual([
      { attemptId: sourceId, correct: false },
      { attemptId: first.id, correct: true },
    ]);
    expect((await submit()).status).toBe(409);
    const lateSave = await jsonCall(
      disabled,
      `${path}/answers/${questionId}`,
      ownerCookie,
      "PUT",
      {
        answer: { kind: "choice", index: 0 },
        baseRevision: 1,
        mutationId: randomUUID(),
        questionRevisionId: revisions[0]?.questionRevisionId,
        expectedFrozenAt: first.frozenAt,
      },
    );
    expect(lateSave.status).toBe(409);
    expect(activities()).toHaveLength(2);
    expect(
      kernelQuery("SELECT activity_id, submission_id FROM completions"),
    ).toEqual(completed);
    const confirmations = kernelQuery(
      "SELECT id, step_attempt_id, operation_id FROM submissions",
    );
    expect(confirmations).toHaveLength(1);
    expect(receipts()).toMatchObject([
      {
        receipt_id: confirmations[0]?.id,
        operation_id: confirmations[0]?.operation_id,
        step_attempt_id: confirmations[0]?.step_attempt_id,
      },
    ]);
    expect(
      product()
        .prepare("SELECT kind FROM attempt_settlements WHERE attempt_id=?")
        .all(first.id),
    ).toEqual([{ kind: "final" }]);
    expect(
      product()
        .prepare(
          "SELECT answer_json, auto_correct FROM responses WHERE attempt_id=?",
        )
        .all(first.id),
    ).toEqual([{ answer_json: null, auto_correct: null }]);
  } finally {
    handle.close();
  }
});
