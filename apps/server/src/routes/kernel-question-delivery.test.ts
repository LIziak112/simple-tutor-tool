import { createHash, randomUUID } from "node:crypto";
import { mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTEMPT_SNAPSHOT_PROOF_HEADER,
  attemptDraftOkSchema,
  attemptResultOkSchema,
  attemptStartOkSchema,
  BACKUP_KERNEL_DATABASE,
  BACKUP_KERNEL_MANIFEST,
  backupKernelManifestSchema,
  importCommitDataSchema,
  lessonStartOkSchema,
  pendingMarkListDataSchema,
  studentRecordsOkSchema,
  teacherAttemptDetailOkSchema,
  teacherInfoOkSchema,
} from "@tutor/contract";
import { ZipArchive } from "archiver";
import { openLearningRuntime } from "learning-kernel";
import pino from "pino";
import { expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../app.ts";
import { runBackfills } from "../db/backfill.ts";
import { createDbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { readZipEntriesMap } from "../lib/zip-read.ts";
import { purgeOpenedAttempts } from "../services/attempt-opened-purge.ts";
import { zipToBackupBuffer } from "../test/backup-fixtures.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import { gzipJson, makeNotePng, putNoteForm } from "../test/note-fixtures.ts";

const choices = [
  "::::question{id=k17-one type=choice}",
  "第一道合成题。",
  "- [x] 第一项",
  "- [ ] 第二项",
  "::::",
  "",
  "::::question{id=k17-two type=judge}",
  "合成判断。[[正确]]",
  "::::",
  "",
  "::::question{id=k17-three type=multi}",
  "合成多选。",
  "- [x] 甲",
  "- [ ] 乙",
  "- [x] 丙",
  "::::",
  "",
  "::::question{id=k17-four type=choice}",
  "第四道合成题。",
  "- [x] 第一项",
  "- [ ] 第二项",
  "::::",
  "",
];
const wire = <Schema extends z.ZodType>(schema: Schema) =>
  z.object({ data: schema });
const keyRow = z.object({
  operation_id: z.string(),
  step_attempt_id: z.uuid(),
  slot_id: z.string(),
});

function openInstance(dataDir: string) {
  let handle = createDbHandle(join(dataDir, "tutor.db"), (db) => {
    runMigrations(db);
    runBackfills(db);
  });
  const reopen = () => {
    handle.close();
    handle = createDbHandle(join(dataDir, "tutor.db"), (db) => {
      runMigrations(db);
      runBackfills(db);
    });
  };
  const open = (lesson: boolean, operator?: string) =>
    createApp({
      db: handle.db,
      dbHandle: handle,
      dataDir,
      backupOperatorId: operator,
      kernelAssignmentCreationEnabled: true,
      kernelLessonEnabled: lesson,
      isProduction: false,
      logger: pino({ enabled: false }),
      publicUrl: "http://localhost:8787",
    });
  return { reopen, open, db: () => handle.db, close: () => handle.close() };
}

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

async function importQuestions(
  app: ReturnType<typeof createApp>,
  teacher: string,
  courseId?: string,
  questions = choices,
) {
  const kind = courseId ? "lesson" : "practice";
  const markdown = [
    "---",
    "kind: " + kind,
    "unit: 合成共用交付",
    "---",
    "",
    ...(courseId ? ["# 第1讲 合成共用交付", ""] : []),
    ...questions,
  ].join("\n");
  const response = await jsonCall(
    app,
    "/api/teacher/import/commit",
    teacher,
    "POST",
    {
      markdown,
      filename: "K17-共用交付.md",
      ...(courseId && { addToCourse: { courseId, visible: true } }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return wire(importCommitDataSchema).parse(await response.json()).data;
}

async function finishedResult(
  app: ReturnType<typeof createApp>,
  path: string,
  cookie: string,
) {
  const result = await jsonCall(app, path, cookie);
  expect(result.status, await result.clone().text()).toBe(200);
  return attemptResultOkSchema.parse(await result.json()).data;
}

it("混合普通作业只有一份权威整卷确认，公布前隐藏键并保留原判断文字、空选和缺答", async () => {
  using data = mkdtempDisposableSync(join(tmpdir(), "k17-host-a-"));
  const instance = openInstance(data.path);
  try {
    let app = instance.open(false);
    const world = await setupAssignment(app);
    const {
      units: [unit],
    } = await importQuestions(app, world.teacher);
    if (!unit) throw new Error("未导入混合题");
    const assignment = await assignKernelFixture(
      app,
      { ...world, unitId: unit.id },
      {
        answerRelease: "after_due",
        dueAt: "2099-01-01T00:00:00Z",
      },
    );
    const opened = await postAssignment(app, assignment, world.ownerCookie);
    const attempt = attemptStartOkSchema.parse(await opened.json()).data;
    const path = "/api/student/attempts/" + attempt.id;
    const draft = async () =>
      attemptDraftOkSchema.parse(
        await (await jsonCall(app, path, world.ownerCookie)).json(),
      ).data;
    const draftView = await draft();
    const answer = {
      "k17-one": { kind: "choice", index: 0 },
      "k17-two": { kind: "judge", value: "  待判  " },
      "k17-three": { kind: "multi", indexes: [] },
    };
    const byId = new Map(
      draftView.units
        .flatMap((unit) => unit.questions)
        .map((q) => [q.id, q.questionRevisionId]),
    );
    for (const [id, value] of Object.entries(answer)) {
      expect(
        (
          await jsonCall(
            app,
            path + "/answers/" + id,
            world.ownerCookie,
            "PUT",
            {
              answer: value,
              baseRevision: 0,
              mutationId: randomUUID(),
              expectedFrozenAt: attempt.frozenAt,
              questionRevisionId: byId.get(id),
            },
          )
        ).status,
      ).toBe(200);
    }
    const saved = await draft();
    expect(saved.drafts).toEqual(answer);
    const payload = {
      revisions: [...byId].map(([questionId, questionRevisionId]) => ({
        questionId,
        questionRevisionId,
        expectedAnswerRevision: saved.draftRevisions?.[questionId] ?? 0,
      })),
    };
    const hidden = attemptResultOkSchema.parse(
      await (
        await jsonCall(
          app,
          path + "/submit",
          world.ownerCookie,
          "POST",
          payload,
        )
      ).json(),
    ).data;
    expect(hidden.answersReleased).toBe(false);
    expect(
      hidden.units
        .flatMap((unit) => unit.questions)
        .map((q) => [q.answers, q.finalCorrect, q.solutionMd]),
    ).toEqual(Array.from({ length: 4 }, () => [null, null, null]));
    expect(
      instance
        .db()
        .$client.prepare(
          "SELECT count(*) n FROM kernel_question_deliveries WHERE attempt_id=? AND receipt_id IS NOT NULL",
        )
        .get(attempt.id),
    ).toEqual({ n: 1 });
    instance.reopen();
    app = instance.open(false);
    const queue = wire(pendingMarkListDataSchema).parse(
      await (
        await jsonCall(
          app,
          "/api/teacher/pending-marks?assignmentId=" + assignment,
          world.teacher,
        )
      ).json(),
    ).data;
    expect(queue.marks).toHaveLength(1);
    expect(queue.marks[0]).toMatchObject({
      questionId: "k17-two",
      answerText: "  待判  ",
    });
    expect(
      (
        await jsonCall(
          app,
          "/api/teacher/assignments/" + assignment,
          world.teacher,
          "PATCH",
          { answerRelease: "on_submit" },
        )
      ).status,
    ).toBe(200);
    const released = await finishedResult(app, path, world.ownerCookie);
    expect(released.summary).toMatchObject({
      answered: 2,
      unanswered: 2,
      pendingCount: 1,
      scoreFinal: null,
    });
    expect(
      released.units
        .flatMap((unit) => unit.questions)
        .map((q) => [q.answer, q.finalCorrect]),
    ).toEqual([
      [answer["k17-one"], true],
      [answer["k17-two"], null],
      [answer["k17-three"], false],
      [null, false],
    ]);
    expect(
      (
        await jsonCall(
          app,
          "/api/teacher/assignments/" + assignment,
          world.teacher,
          "PATCH",
          { answerRelease: "after_due", dueAt: "2099-01-01T00:00:00Z" },
        )
      ).status,
    ).toBe(200);
    const revoked = await finishedResult(app, path, world.ownerCookie);
    expect(revoked.answersReleased).toBe(false);
    expect(revoked.summary.pendingCount).toBeNull();
    expect(
      revoked.units
        .flatMap((unit) => unit.questions)
        .every((q) => q.answers === null && q.finalCorrect === null),
    ).toBe(true);

    expect(
      (
        await jsonCall(
          app,
          path + "/submit",
          world.ownerCookie,
          "POST",
          payload,
        )
      ).status,
    ).toBe(409);
  } finally {
    instance.close();
  }
});

it.each([false, true])(
  "普通整卷保留填空位置和空稿，自评开启=%s",
  async (selfReview) => {
    using data = mkdtempDisposableSync(join(tmpdir(), "k18-fill-"));
    const instance = openInstance(data.path);
    try {
      const app = instance.open(false);
      const world = await setupAssignment(app);
      const fillIds = ["extra", "blank", "empty", "missing"].map(
        (name) => "k18-" + name,
      );
      const {
        units: [unit],
      } = await importQuestions(app, world.teacher, undefined, [
        ...choices,
        ...fillIds.flatMap((id) => [
          "::::question{id=" + id + " type=fill}",
          "合成填空 [[甲|乙]]，另有 [[丙]]。",
          "::::",
          "",
        ]),
      ]);
      if (!unit) throw new Error("未导入合成填空题");
      expect(
        (
          await jsonCall(
            app,
            "/api/teacher/settings/practice-feedback",
            world.teacher,
            "PUT",
            {
              studentSelfReviewEnabled: selfReview,
            },
          )
        ).status,
      ).toBe(200);
      const assignment = await assignKernelFixture(
        app,
        { ...world, unitId: unit.id },
        {
          answerRelease: "after_due",
          dueAt: "2099-01-01T00:00:00Z",
        },
      );
      const opened = await postAssignment(app, assignment, world.ownerCookie);
      const attempt = attemptStartOkSchema.parse(await opened.json()).data;
      const path = "/api/student/attempts/" + attempt.id;
      const draft = async () =>
        attemptDraftOkSchema.parse(
          await (await jsonCall(app, path, world.ownerCookie)).json(),
        ).data;
      const initial = await draft();
      const written = new Map([
        ["k17-one", { kind: "choice", index: 0 }],
        ["k18-extra", { kind: "fill", values: [" 甲 ", "", "  保留  "] }],
        ["k18-blank", { kind: "fill", values: [" ", "\t"] }],
        ["k18-empty", { kind: "fill", values: [] }],
      ]);
      const questions = initial.units.flatMap((group) => group.questions);
      for (const question of questions) {
        const answer = written.get(question.id);
        if (!answer) continue;
        const saved = await jsonCall(
          app,
          path + "/answers/" + question.id,
          world.ownerCookie,
          "PUT",
          {
            answer,
            mutationId: randomUUID(),
            baseRevision: 0,
            expectedFrozenAt: attempt.frozenAt,
            questionRevisionId: question.questionRevisionId,
          },
        );
        expect(saved.status, await saved.clone().text()).toBe(200);
      }
      const saved = await draft();
      expect(saved.drafts).toEqual(Object.fromEntries(written));
      const payload = {
        revisions: questions.map(({ id, questionRevisionId }) => ({
          questionId: id,
          questionRevisionId,
          expectedAnswerRevision: saved.draftRevisions?.[id] ?? 0,
        })),
      };
      const submit = await jsonCall(
        app,
        path + "/submit",
        world.ownerCookie,
        "POST",
        payload,
      );
      expect(submit.status, await submit.clone().text()).toBe(200);
      const hidden = attemptResultOkSchema.parse(await submit.json()).data;
      expect(hidden.answersReleased).toBe(false);
      expect(
        hidden.units
          .flatMap((group) => group.questions)
          .map((question) => [
            question.answer,
            question.answers,
            question.solutionMd,
            question.gradingPolicy,
            question.autoCorrect,
          ]),
      ).toEqual(
        questions.map(({ id }) => [
          written.get(id) ?? null,
          null,
          null,
          null,
          null,
        ]),
      );
      const studentRecord = async () =>
        studentRecordsOkSchema
          .parse(
            await (
              await jsonCall(app, "/api/student/records", world.ownerCookie)
            ).json(),
          )
          .data.records.find((record) => record.attemptId === attempt.id);
      expect(await studentRecord()).toMatchObject({
        pendingSelfReviewCount: null,
        resultCounts: null,
      });
      const publish = await jsonCall(
        app,
        "/api/teacher/assignments/" + assignment,
        world.teacher,
        "PATCH",
        {
          answerRelease: "on_submit",
        },
      );
      expect(publish.status).toBe(200);
      const result = await finishedResult(app, path, world.ownerCookie);
      const rows = result.units.flatMap((group) => group.questions);
      expect(
        rows.find((question) => question.questionId === "k17-one")?.autoCorrect,
      ).toBe(true);
      expect(
        rows
          .filter((question) => fillIds.includes(question.questionId))
          .map((question) => [
            question.questionId,
            question.answer,
            question.answered,
            question.answers,
            question.gradingPolicy,
            question.autoCorrect,
            question.finalCorrect,
          ]),
      ).toEqual(
        fillIds.map((id, index) => [
          id,
          written.get(id) ?? null,
          index === 0,
          { kind: "fill", blanks: [["甲", "乙"], ["丙"]] },
          selfReview ? "reference_self" : "manual_only",
          null,
          null,
        ]),
      );
      expect(result.summary).toMatchObject({
        answered: 2,
        pendingCount: selfReview ? 0 : 4,
      });
      expect(await studentRecord()).toMatchObject({
        pendingSelfReviewCount: selfReview ? 4 : 0,
      });
      const teacherView = teacherAttemptDetailOkSchema.parse(
        await (
          await jsonCall(
            app,
            "/api/teacher/attempts/" + attempt.id,
            world.teacher,
          )
        ).json(),
      ).data;
      expect(teacherView).toMatchObject({
        pendingCount: selfReview ? 0 : 4,
        selfReviewPendingCount: selfReview ? 4 : 0,
        resultCounts: { pendingSelfReviewCount: selfReview ? 4 : 0 },
      });
      expect(
        (
          await jsonCall(
            app,
            path + "/submit",
            world.ownerCookie,
            "POST",
            payload,
          )
        ).status,
      ).toBe(409);
    } finally {
      instance.close();
    }
  },
);

function inkForm(firstPointX = 10) {
  const form = new FormData();
  form.set(
    "strokes",
    new Blob([
      gzipJson({
        version: 1,
        engine: "atrament",
        data: {
          width: 1000,
          strokes: [
            {
              tool: "pen",
              color: "#1f2328",
              weight: 4,
              points: [
                { x: firstPointX, y: 20, p: 0.5, t: 0 },
                { x: 30, y: 40, p: 0.7, t: 25 },
              ],
            },
          ],
        },
        updatedAt: 1727392800000,
      }),
    ]),
    "strokes.json.gz",
  );
  form.set("snapshot", new Blob([makeNotePng()]), "snapshot.png");
  return form;
}

async function zipBytes(entries: Map<string, Buffer>) {
  const stream = new ZipArchive();
  const result = zipToBackupBuffer({ stream, filename: "paired.zip" });
  for (const [name, data] of entries) stream.append(data, { name });
  await stream.finalize();
  return new Uint8Array(await result);
}

it("讲练逐题故障后保持题级权限，原回执与余题在同卷过备份、重开及早收尾", async () => {
  using data = mkdtempDisposableSync(join(tmpdir(), "k17-host-b-"));
  const instance = openInstance(data.path);
  try {
    let app = instance.open(true);
    const world = await setupAssignment(app);
    const teacher = teacherInfoOkSchema.parse(
      await (await jsonCall(app, "/api/teacher/me", world.teacher)).json(),
    ).data;
    app = instance.open(true, teacher.id);
    const course = wire(z.object({ id: z.uuid() })).parse(
      await (
        await jsonCall(app, "/api/teacher/courses", world.teacher, "POST", {
          title: "合成讲练班",
        })
      ).json(),
    ).data;
    expect(
      (
        await jsonCall(
          app,
          "/api/teacher/courses/" + course.id + "/members",
          world.teacher,
          "POST",
          { studentIds: [world.studentId] },
        )
      ).status,
    ).toBe(200);
    const {
      lectures: [lecture],
    } = await importQuestions(app, world.teacher, course.id);
    if (!lecture) throw new Error("未生成讲练");
    const lesson = "/api/student/lectures/" + lecture.id + "/lesson";
    const start = () =>
      jsonCall(
        app,
        lesson + "/start?courseId=" + course.id,
        world.ownerCookie,
        "POST",
      );
    const startView = async () =>
      lessonStartOkSchema.parse(await (await start()).json()).data;
    const view = await startView();
    const id = view.attempt.id,
      path = "/api/student/attempts/" + id;
    expect(
      instance
        .db()
        .$client.prepare(
          "SELECT count(*) n FROM kernel_lesson_openings WHERE attempt_id=?",
        )
        .get(id),
    ).toEqual({ n: 1 });
    purgeOpenedAttempts(instance.db(), {
      enabled: true,
      days: 1,
      now: new Date(Date.now() + 172800000),
    });
    expect((await startView()).attempt.id).toBe(id);
    const frozen = new Map(
      view.questions.map((q) => [q.id, q.questionRevisionId]),
    );
    for (const [questionId, answer] of [
      ["k17-one", { kind: "choice", index: 0 }],
      ["k17-three", { kind: "multi", indexes: [2, 0] }],
    ] as const)
      expect(
        (
          await jsonCall(
            app,
            path + "/answers/" + questionId,
            world.ownerCookie,
            "PUT",
            {
              answer,
              questionRevisionId: frozen.get(questionId),
              expectedFrozenAt: view.attempt.frozenAt,
              baseRevision: 0,
              mutationId: randomUUID(),
            },
          )
        ).status,
      ).toBe(200);

    const oldNoteMutation = randomUUID();
    const oldNote = await app.request(path + "/notes/k17-one", {
      method: "PUT",
      headers: { cookie: world.ownerCookie },
      body: putNoteForm(1, { mutationId: oldNoteMutation }),
    });
    expect(oldNote.status, await oldNote.clone().text()).toBe(200);
    const oldVersion = wire(z.object({ versionId: z.uuid() })).parse(
      await oldNote.json(),
    ).data.versionId;
    const archive = async () => {
      const reply = await jsonCall(
        app,
        "/api/teacher/backup/download",
        world.teacher,
      );
      expect(reply.status, await reply.clone().text()).toBe(200);
      return new Uint8Array(await reply.arrayBuffer());
    };
    const before = await archive();
    const q1 = {
      questionRevisionId: frozen.get("k17-one"),
      expectedAnswerRevision: 1,
      evidence: {
        questionId: "k17-one",
        state: "frozen",
        versionId: oldVersion,
        revision: 1,
      },
    };
    const q1Path = path + "/questions/k17-one/submit";
    expect(
      (await jsonCall(app, q1Path, world.otherCookie, "POST", q1)).status,
    ).toBe(403);
    expect(
      (
        await jsonCall(app, q1Path, world.ownerCookie, "POST", {
          ...q1,
          questionRevisionId: randomUUID(),
        })
      ).status,
    ).toBe(409);
    instance
      .db()
      .$client.exec(
        "CREATE TEMP TRIGGER stop_host_projection BEFORE UPDATE OF receipt_id ON kernel_question_deliveries BEGIN SELECT RAISE(ABORT,'中断投影'); END",
      );
    expect(
      (await jsonCall(app, q1Path, world.ownerCookie, "POST", q1)).status,
    ).toBe(500);
    const row = keyRow.parse(
      instance
        .db()
        .$client.prepare(
          "SELECT operation_id,step_attempt_id,slot_id FROM kernel_question_deliveries WHERE attempt_id=? AND receipt_id IS NULL",
        )
        .get(id),
    );
    expect(
      instance
        .db()
        .$client.prepare(
          "SELECT submitted_at FROM responses WHERE attempt_id=? AND question_id='k17-one'",
        )
        .get(id),
    ).toEqual({ submitted_at: null });
    const actor = { role: "student", id: world.studentId } as const;
    const key = {
      protocolVersion: 1,
      operationId: row.operation_id,
      stepAttemptId: row.step_attempt_id,
    } as const;
    const k = openLearningRuntime({
      databasePath: join(data.path, BACKUP_KERNEL_DATABASE),
      authorizeConfirmationRecovery: (receipt) =>
        receipt.studentId === world.studentId &&
        receipt.activityId === id &&
        receipt.operationId === row.operation_id,
    });
    let receiptId: string;
    try {
      expect(k.read(actor, id)).toMatchObject({ status: "active" });
      expect(() =>
        k.recoverQuestionDelivery(
          { role: "student", id: world.otherStudentId },
          id,
          key,
        ),
      ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
      receiptId = k.recoverQuestionDelivery(actor, id, key).receipt.id;
    } finally {
      k.close();
    }

    instance.reopen();
    app = instance.open(false, teacher.id);
    const oldNoteReplay = await app.request(path + "/notes/k17-one", {
      method: "PUT",
      headers: { cookie: world.ownerCookie },
      body: putNoteForm(1, { mutationId: oldNoteMutation }),
    });
    expect(oldNoteReplay.status).toBe(200);
    expect(
      wire(z.object({ versionId: z.uuid() })).parse(await oldNoteReplay.json())
        .data.versionId,
    ).toBe(oldVersion);
    for (const [resource, form] of [
      ["notes", putNoteForm(2, { baseRevision: 1 })],
      ["ink", inkForm()],
    ] as const) {
      const blocked = await app.request(path + "/" + resource + "/k17-one", {
        method: "PUT",
        headers: { cookie: world.ownerCookie },
        body: form,
      });
      expect(
        blocked.status,
        resource + " " + (await blocked.clone().text()),
      ).toBe(409);
    }
    const pendingArchive = await archive();
    const restore = (bytes: Uint8Array<ArrayBuffer>) => {
      const form = new FormData();
      form.set(
        "zip",
        new File([bytes], "同代备份.zip", { type: "application/zip" }),
      );
      form.set("password", "teacher-pass-8");
      return app.request("/api/teacher/backup/restore", {
        method: "POST",
        headers: { cookie: world.teacher },
        body: form,
      });
    };
    const early = readZipEntriesMap(Buffer.from(before));
    const late = readZipEntriesMap(Buffer.from(pendingArchive));
    const lateKernel = late.get(BACKUP_KERNEL_DATABASE),
      manifest = early.get(BACKUP_KERNEL_MANIFEST);
    if (!lateKernel || !manifest) throw new Error("归档缺少配对表");
    early.set(BACKUP_KERNEL_DATABASE, lateKernel);
    early.set(
      BACKUP_KERNEL_MANIFEST,
      Buffer.from(
        JSON.stringify({
          ...backupKernelManifestSchema.parse(
            JSON.parse(manifest.toString("utf8")),
          ),
          kernelSha256: createHash("sha256").update(lateKernel).digest("hex"),
        }),
      ),
    );
    const earlyKernel = readZipEntriesMap(Buffer.from(before)).get(
      BACKUP_KERNEL_DATABASE,
    );
    expect((await restore(await zipBytes(early))).status).toBe(400);
    expect((await restore(pendingArchive)).status).toBe(200);
    expect(
      (
        await app.request(path + "/notes/k17-three", {
          method: "PUT",
          headers: { cookie: world.ownerCookie },
          body: putNoteForm(),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(path + "/ink/k17-three", {
          method: "PUT",
          headers: { cookie: world.ownerCookie },
          body: inkForm(),
        })
      ).status,
    ).toBe(200);
    const reopened = await startView();
    expect(reopened.attempt.id).toBe(id);
    expect(reopened.attempt.status).toBe("draft");
    expect(Object.keys(reopened.released)).toEqual(["k17-one"]);
    expect(reopened.drafts["k17-three"]).toEqual({
      kind: "multi",
      indexes: [2, 0],
    });
    expect(
      instance
        .db()
        .$client.prepare(
          "SELECT receipt_id FROM kernel_question_deliveries WHERE operation_id=?",
        )
        .get(row.operation_id),
    ).toEqual({ receipt_id: receiptId });
    expect(
      (await jsonCall(app, q1Path, world.ownerCookie, "POST", q1)).status,
    ).toBe(409);
    const empty = {
      questionRevisionId: frozen.get("k17-two"),
      expectedAnswerRevision: 0,
      evidence: { questionId: "k17-two", state: "none" },
    };
    expect(
      (
        await jsonCall(
          app,
          path + "/questions/k17-two/submit",
          world.ownerCookie,
          "POST",
          empty,
        )
      ).status,
    ).toBe(200);
    const half = await startView();
    expect(half.released["k17-two"]).toMatchObject({
      answered: true,
      studentFlag: "unsure",
      answer: null,
      finalCorrect: false,
    });
    const records = async () =>
      studentRecordsOkSchema
        .parse(
          await (
            await jsonCall(app, "/api/student/records", world.ownerCookie)
          ).json(),
        )
        .data.records.filter((item) => item.attemptId === id);
    expect(await records()).toHaveLength(1);
    expect((await records())[0]?.status).toBe("draft");
    const notes = instance
      .db()
      .$client.prepare(
        "SELECT v.id,v.revision FROM note_versions v JOIN notes n ON n.id=v.note_id WHERE n.attempt_id=? AND n.question_id='k17-three'",
      );
    const neighbor = z
      .object({ id: z.uuid(), revision: z.number() })
      .parse(notes.get(id));
    const payload = {
      revisions: half.questions.map((q) => ({
        questionId: q.id,
        questionRevisionId: q.questionRevisionId,
        expectedAnswerRevision: half.draftRevisions?.[q.id] ?? 0,
      })),
      evidence: [
        {
          questionId: "k17-three",
          state: "frozen",
          versionId: neighbor.id,
          revision: neighbor.revision,
        },
        { questionId: "k17-four", state: "none" },
      ],
    };
    expect(
      (
        await jsonCall(
          app,
          path + "/submit",
          world.ownerCookie,
          "POST",
          payload,
        )
      ).status,
    ).toBe(200);
    const final = await finishedResult(app, path, world.ownerCookie);
    const lateProduct = readZipEntriesMap(Buffer.from(await archive()));
    const lateManifest = lateProduct.get(BACKUP_KERNEL_MANIFEST);
    if (!earlyKernel || !lateManifest) throw new Error("缺少反向混档基线");
    lateProduct.set(BACKUP_KERNEL_DATABASE, earlyKernel);
    lateProduct.set(
      BACKUP_KERNEL_MANIFEST,
      Buffer.from(
        JSON.stringify({
          ...backupKernelManifestSchema.parse(
            JSON.parse(lateManifest.toString("utf8")),
          ),
          kernelSha256: createHash("sha256").update(earlyKernel).digest("hex"),
        }),
      ),
    );
    expect((await restore(await zipBytes(lateProduct))).status).toBe(400);
    expect(await finishedResult(app, path, world.ownerCookie)).toEqual(final);
    expect(final.summary).toMatchObject({
      answered: 3,
      unanswered: 1,
      scoreFinal: 50,
    });
    expect((await records())[0]).toMatchObject({ status: "graded", score: 50 });
    expect(
      (
        await jsonCall(
          app,
          path + "/submit",
          world.ownerCookie,
          "POST",
          payload,
        )
      ).status,
    ).toBe(409);
    const queue = wire(pendingMarkListDataSchema).parse(
      await (
        await jsonCall(
          app,
          "/api/teacher/pending-marks?studentId=" + world.studentId,
          world.teacher,
        )
      ).json(),
    ).data;
    expect(queue.marks.filter((mark) => mark.attemptId === id)).toEqual([]);
    const restart = { expectedAttemptId: id, operationId: randomUUID() };
    expect(
      (
        await jsonCall(
          app,
          lesson + "/restart",
          world.ownerCookie,
          "POST",
          restart,
        )
      ).status,
    ).toBe(409);
    app = instance.open(true, teacher.id);
    const next = await jsonCall(
      app,
      lesson + "/restart",
      world.ownerCookie,
      "POST",
      restart,
    );
    expect(next.status, await next.clone().text()).toBe(201);
    const nextData = lessonStartOkSchema.parse(await next.json()).data;
    expect(nextData.attempt).toMatchObject({ attemptNo: 2, status: "draft" });
    expect((await startView()).attempt.id).toBe(nextData.attempt.id);
    app = instance.open(false, teacher.id);
    expect((await startView()).attempt.id).toBe(nextData.attempt.id);
    app = instance.open(true, teacher.id);
    const question = nextData.questions.find((item) => item.id === "k17-one");
    if (!question) throw new Error("重开缺少原题");
    const competing = await Promise.all(
      [0, 1].map((index) =>
        jsonCall(
          app,
          "/api/student/attempts/" +
            nextData.attempt.id +
            "/answers/" +
            question.id,
          world.ownerCookie,
          "PUT",
          {
            answer: { kind: "choice", index },
            baseRevision: 0,
            mutationId: randomUUID(),
            questionRevisionId: question.questionRevisionId,
            expectedFrozenAt: nextData.attempt.frozenAt,
          },
        ),
      ),
    );
    expect(competing.map((r) => r.status).sort()).toEqual([200, 409]);
    const repeat = await jsonCall(
      app,
      lesson + "/restart",
      world.ownerCookie,
      "POST",
      restart,
    );
    expect(lessonStartOkSchema.parse(await repeat.json()).data.attempt.id).toBe(
      nextData.attempt.id,
    );
    expect(await finishedResult(app, path, world.ownerCookie)).toEqual(final);
    expect(
      (
        await jsonCall(
          app,
          "/api/teacher/courses/" + course.id + "/members",
          world.teacher,
          "DELETE",
          { studentIds: [world.studentId] },
        )
      ).status,
    ).toBe(200);
    expect((await start()).status).toBe(403);
    expect((await jsonCall(app, path, world.ownerCookie)).status).toBe(403);
    expect(await records()).toEqual([]);
  } finally {
    instance.close();
  }
});

it("普通整卷解答题恢复最终文本及正式笔迹，权威确认后拒绝晚写", async () => {
  using data = mkdtempDisposableSync(join(tmpdir(), "m05-solve-host-"));
  const instance = openInstance(data.path);
  try {
    let app = instance.open(false);
    const world = await setupAssignment(app);
    const teacher = teacherInfoOkSchema.parse(
      await (await jsonCall(app, "/api/teacher/me", world.teacher)).json(),
    ).data;
    app = instance.open(false, teacher.id);
    const solveIds = ["m05-raw", "m05-empty", "m05-ink", "m05-missing"];
    const {
      units: [unit],
    } = await importQuestions(app, world.teacher, undefined, [
      ...choices,
      ...solveIds.flatMap((id) => [
        `::::question{id=${id} type=solve}`,
        "写出计算结果。",
        ...(id === "m05-missing" ? [] : [":::answer", "解答参考", ":::"]),
        ":::solution",
        "冻结的原详解。",
        ":::",
        "::::",
        "",
      ]),
    ]);
    if (!unit) throw new Error("未导入解答题");
    const assignment = await assignKernelFixture(
      app,
      { ...world, unitId: unit.id },
      {
        answerRelease: "after_due",
        dueAt: "2099-01-01T00:00:00Z",
      },
    );
    const opened = await postAssignment(app, assignment, world.ownerCookie);
    const attempt = attemptStartOkSchema.parse(await opened.json()).data;
    const path = "/api/student/attempts/" + attempt.id;
    const readDraft = async () =>
      attemptDraftOkSchema.parse(
        await (await jsonCall(app, path, world.ownerCookie)).json(),
      ).data;
    const questions = (await readDraft()).units.flatMap(
      (group) => group.questions,
    );
    const proof = (questionId: string) => ({
      questionRevisionId: questions.find((q) => q.id === questionId)
        ?.questionRevisionId,
      expectedFrozenAt: attempt.frozenAt,
    });
    const raw = { kind: "final", finalAnswer: "  原答案\n\t" };
    const empty = { kind: "final", finalAnswer: "" };
    for (const [id, answer] of [
      ["m05-raw", raw],
      ["m05-empty", empty],
    ] as const) {
      const saved = await jsonCall(
        app,
        path + "/answers/" + id,
        world.ownerCookie,
        "PUT",
        {
          ...proof(id),
          answer,
          mutationId: randomUUID(),
          baseRevision: 0,
        },
      );
      expect(saved.status, await saved.clone().text()).toBe(200);
    }
    const putInk = (
      id: string,
      baseRevision: number,
      cookie = world.ownerCookie,
    ) => {
      const body = inkForm(baseRevision === 0 ? 10 : 11);
      body.set(
        "meta",
        JSON.stringify({
          ...proof(id),
          baseRevision,
          mutationId: randomUUID(),
        }),
      );
      return app.request(path + "/ink/" + id, {
        method: "PUT",
        headers: { cookie },
        body,
      });
    };
    const inkPath = path + "/ink/m05-ink";
    const uploaded = await putInk("m05-ink", 0);
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    const inkId = wire(
      z.object({ inkId: z.uuid(), revision: z.literal(1) }),
    ).parse(await uploaded.json()).data.inkId;
    expect((await jsonCall(app, inkPath, world.otherCookie)).status).toBe(403);
    const storedBefore = await readDraft();
    expect(storedBefore.drafts).toEqual({ "m05-raw": raw, "m05-empty": empty });
    expect(storedBefore.draftRevisions).toMatchObject({
      "m05-raw": 1,
      "m05-empty": 1,
    });
    const submitBody = {
      revisions: questions.map(({ id, questionRevisionId }) => ({
        questionId: id,
        questionRevisionId,
        expectedAnswerRevision: storedBefore.draftRevisions?.[id] ?? 0,
      })),
      evidence: questions.map(({ id }) => ({ questionId: id, state: "none" })),
    };
    const sql = () => instance.db().$client;
    sql().exec(
      "CREATE TEMP TRIGGER stop_solve_projection BEFORE UPDATE OF receipt_id ON kernel_question_deliveries BEGIN SELECT RAISE(ABORT,'中断解答题投影'); END",
    );
    const interrupted = await jsonCall(
      app,
      path + "/submit",
      world.ownerCookie,
      "POST",
      submitBody,
    );
    expect(interrupted.status, await interrupted.clone().text()).toBe(500);
    expect(
      sql().prepare("SELECT status FROM attempts WHERE id=?").get(attempt.id),
    ).toEqual({ status: "draft" });
    const ticket = keyRow.parse(
      sql()
        .prepare(
          "SELECT operation_id,step_attempt_id,slot_id FROM kernel_question_deliveries WHERE attempt_id=? AND receipt_id IS NULL",
        )
        .get(attempt.id),
    );
    const runtime = openLearningRuntime({
      databasePath: join(data.path, BACKUP_KERNEL_DATABASE),
      authorizeConfirmationRecovery: (receipt) =>
        receipt.operationId === ticket.operation_id &&
        receipt.activityId === attempt.id &&
        receipt.studentId === world.studentId,
    });
    const receipt = (() => {
      try {
        return runtime.recoverQuestionDelivery(
          { role: "student", id: world.studentId },
          attempt.id,
          {
            protocolVersion: 1,
            operationId: ticket.operation_id,
            stepAttemptId: ticket.step_attempt_id,
          },
        ).receipt;
      } finally {
        runtime.close();
      }
    })();
    for (const [id, base] of [
      ["m05-ink", 1],
      ["m05-missing", 0],
    ] as const) {
      const late = await putInk(id, base);
      expect(late.status, await late.clone().text()).toBe(409);
      expect(await late.json()).toMatchObject({ error: "ALREADY_SUBMITTED" });
    }
    instance.reopen();
    app = instance.open(false, teacher.id);
    const hidden = await finishedResult(app, path, world.ownerCookie);
    expect(hidden.answersReleased).toBe(false);
    expect(
      hidden.units
        .flatMap((group) => group.questions)
        .filter((question) => solveIds.includes(question.questionId))
        .map((question) => [
          question.questionId,
          question.answer,
          question.answered,
          question.answers,
          question.solutionMd,
          question.autoCorrect,
        ]),
    ).toEqual([
      ["m05-raw", raw, true, null, null, null],
      ["m05-empty", empty, false, null, null, null],
      ["m05-ink", null, true, null, null, null],
      ["m05-missing", null, false, null, null, null],
    ]);
    expect(
      sql()
        .prepare(
          "SELECT receipt_id FROM kernel_question_deliveries WHERE operation_id=?",
        )
        .get(ticket.operation_id),
    ).toEqual({ receipt_id: receipt.id });
    expect(
      sql()
        .prepare(
          "SELECT count(*) n FROM attempt_settlements WHERE attempt_id=? AND kind='final'",
        )
        .get(attempt.id),
    ).toEqual({ n: 1 });
    expect(
      (
        await jsonCall(
          app,
          path + "/submit",
          world.ownerCookie,
          "POST",
          submitBody,
        )
      ).status,
    ).toBe(409);
    const png = await jsonCall(app, inkPath + ".png", world.ownerCookie);
    expect(png.status).toBe(200);
    expect(Buffer.from(await png.arrayBuffer())).toEqual(
      Buffer.from(makeNotePng()),
    );
    const before = await jsonCall(
      app,
      "/api/teacher/ink/" + inkId + ".json.gz",
      world.teacher,
    );
    expect(before.status).toBe(200);
    const original = Buffer.from(await before.arrayBuffer());
    const publish = await jsonCall(
      app,
      "/api/teacher/assignments/" + assignment,
      world.teacher,
      "PATCH",
      { answerRelease: "on_submit" },
    );
    expect(publish.status, await publish.clone().text()).toBe(200);
    const released = await finishedResult(app, path, world.ownerCookie);
    expect(released.answersReleased).toBe(true);
    expect(
      released.units
        .flatMap((group) => group.questions)
        .find((question) => question.questionId === "m05-raw"),
    ).toMatchObject({
      answer: raw,
      answers: { kind: "final", answer: "解答参考" },
      solutionMd: "冻结的原详解。",
      autoCorrect: null,
      finalCorrect: null,
    });
    const archive = await jsonCall(
      app,
      "/api/teacher/backup/download",
      world.teacher,
    );
    expect(archive.status, await archive.clone().text()).toBe(200);
    const entries = readZipEntriesMap(Buffer.from(await archive.arrayBuffer()));
    const restore = async () => {
      const form = new FormData();
      form.set(
        "zip",
        new File([await zipBytes(entries)], "解答题备份.zip", {
          type: "application/zip",
        }),
      );
      form.set("password", "teacher-pass-8");
      return app.request("/api/teacher/backup/restore", {
        method: "POST",
        headers: { cookie: world.teacher },
        body: form,
      });
    };
    const entry = [...entries].find(
      ([name, bytes]) => name.endsWith(".json.gz") && bytes.equals(original),
    );
    if (!entry) throw new Error("找不到正式笔迹归档");
    entries.set(entry[0], Buffer.from("损坏的正式笔迹"));
    const rejected = await restore();
    expect(rejected.status, await rejected.clone().text()).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: "BACKUP_ZIP_INVALID",
    });
    entries.delete(entry[0]);
    const missing = await restore();
    expect(missing.status, await missing.clone().text()).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "BACKUP_ZIP_INVALID" });
    entries.set(entry[0], original);
    const restored = await restore();
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect((await finishedResult(app, path, world.ownerCookie)).units).toEqual(
      released.units,
    );
  } finally {
    instance.close();
  }
});

it.each([
  { type: "apply", selfReview: false },
  { type: "find-error", selfReview: true },
])(
  "普通整卷 $type 合成最终文本和正式笔迹经权威确认恢复",
  async ({ type, selfReview }) => {
    using data = mkdtempDisposableSync(
      join(tmpdir(), "m05-handwritten-final-"),
    );
    const instance = openInstance(data.path);
    try {
      let app = instance.open(false);
      const world = await setupAssignment(app);
      const ids = [
        "m05-final-raw",
        "m05-final-ink",
        "m05-final-both",
        "m05-final-missing",
      ];
      const [textOnly, inkOnly, both, missing] = ids;
      if (!textOnly || !inkOnly || !both || !missing)
        throw new Error("缺少合成题");
      const {
        units: [unit],
      } = await importQuestions(
        app,
        world.teacher,
        undefined,
        ids.flatMap((id) => [
          `::::question{id=${id} type=${type}}`,
          "说明算式的问题并写出正确结果。",
          ":::answer",
          "合成参考",
          ":::",
          ":::solution",
          "合成冻结详解。",
          ":::",
          "::::",
          "",
        ]),
      );
      if (!unit) throw new Error("未导入手写题");
      const setReview = (enabled: boolean) =>
        jsonCall(
          app,
          "/api/teacher/settings/practice-feedback",
          world.teacher,
          "PUT",
          {
            studentSelfReviewEnabled: enabled,
          },
        );
      expect((await setReview(selfReview)).status).toBe(200);
      const assignment = await assignKernelFixture(
        app,
        { ...world, unitId: unit.id },
        {
          answerRelease: "after_due",
          dueAt: "2099-01-01T00:00:00Z",
        },
      );
      const opened = await postAssignment(app, assignment, world.ownerCookie);
      const attempt = attemptStartOkSchema.parse(await opened.json()).data;
      expect((await setReview(!selfReview)).status).toBe(200);
      const path = `/api/student/attempts/${attempt.id}`;
      const draft = async () =>
        attemptDraftOkSchema.parse(
          await (await jsonCall(app, path, world.ownerCookie)).json(),
        ).data;
      const initial = await draft();
      const questions = initial.units.flatMap((group) => group.questions);
      expect(
        questions.map((question) => [
          question.id,
          question.type,
          question.options,
        ]),
      ).toEqual(ids.map((id) => [id, type, undefined]));
      expect(initial.drafts).toEqual({});
      const text = { kind: "final", finalAnswer: "  结论\n\t" };
      const proof = (id: string) => ({
        questionRevisionId: questions.find((question) => question.id === id)
          ?.questionRevisionId,
        expectedFrozenAt: attempt.frozenAt,
        baseRevision: 0,
        mutationId: randomUUID(),
      });
      for (const id of [textOnly, both]) {
        const saved = await jsonCall(
          app,
          `${path}/answers/${id}`,
          world.ownerCookie,
          "PUT",
          { ...proof(id), answer: text },
        );
        expect(saved.status, await saved.clone().text()).toBe(200);
      }
      const uploadedInk = new Map<
        string,
        { inkId: string; vector: Buffer; png: Buffer }
      >();
      for (const [index, id] of [inkOnly, both].entries()) {
        const body = inkForm(15 + index);
        const vector = body.get("strokes"),
          png = body.get("snapshot");
        if (!(vector instanceof Blob && png instanceof Blob))
          throw new Error("缺少合成笔迹文件");
        body.set("meta", JSON.stringify(proof(id)));
        const saved = await app.request(`${path}/ink/${id}`, {
          method: "PUT",
          headers: { cookie: world.ownerCookie },
          body,
        });
        expect(saved.status, await saved.clone().text()).toBe(200);
        const { inkId } = wire(
          z.object({ inkId: z.uuid(), revision: z.literal(1) }),
        ).parse(await saved.json()).data;
        uploadedInk.set(id, {
          inkId,
          vector: Buffer.from(await vector.arrayBuffer()),
          png: Buffer.from(await png.arrayBuffer()),
        });
      }
      const stored = await draft();
      expect(stored.drafts).toEqual({ [textOnly]: text, [both]: text });
      const request = {
        revisions: questions.map((question) => ({
          questionId: question.id,
          questionRevisionId: question.questionRevisionId,
          expectedAnswerRevision: stored.draftRevisions?.[question.id] ?? 0,
        })),
        evidence: questions.map((question) => ({
          questionId: question.id,
          state: "none",
        })),
      };
      const submit = await jsonCall(
        app,
        `${path}/submit`,
        world.ownerCookie,
        "POST",
        request,
      );
      expect(submit.status, await submit.clone().text()).toBe(200);
      const hidden = attemptResultOkSchema.parse(await submit.json()).data;
      expect(hidden.answersReleased).toBe(false);
      expect(
        hidden.units
          .flatMap((group) => group.questions)
          .map((question) => [
            question.questionId,
            question.answer,
            question.answered,
            question.answers,
            question.solutionMd,
            question.gradingPolicy,
            question.autoCorrect,
            question.finalCorrect,
          ]),
      ).toEqual([
        [textOnly, text, true, null, null, null, null, null],
        [inkOnly, null, true, null, null, null, null, null],
        [both, text, true, null, null, null, null, null],
        [missing, null, false, null, null, null, null, null],
      ]);
      const sql = () => instance.db().$client;
      const delivery = () =>
        sql()
          .prepare(
            `SELECT receipt_id, intent_json FROM kernel_question_deliveries WHERE attempt_id=?`,
          )
          .all(attempt.id);
      const [storedDelivery] = z
        .array(
          z.object({ receipt_id: z.string().min(1), intent_json: z.string() }),
        )
        .length(1)
        .parse(delivery());
      if (!storedDelivery) throw new Error("缺少权威确认");
      const anchor = z
        .object({
          formalInk: z.array(
            z.object({
              questionId: z.string(),
              ink: z
                .object({
                  inkId: z.uuid(),
                  revision: z.literal(1),
                  strokes: z.object({ sha256: z.string() }),
                  png: z.object({ sha256: z.string() }),
                })
                .nullable(),
            }),
          ),
        })
        .parse(JSON.parse(storedDelivery.intent_json));
      expect(
        anchor.formalInk.map(({ questionId, ink }) => [
          questionId,
          ink?.inkId ?? null,
        ]),
      ).toEqual([
        [textOnly, null],
        [inkOnly, uploadedInk.get(inkOnly)?.inkId],
        [both, uploadedInk.get(both)?.inkId],
        [missing, null],
      ]);
      for (const { questionId, ink } of anchor.formalInk) {
        if (!ink) continue;
        const bytes = uploadedInk.get(questionId);
        if (!bytes) throw new Error("冻结笔迹找不到原件");
        expect(ink.strokes.sha256).toBe(
          createHash("sha256").update(bytes.vector).digest("hex"),
        );
        expect(ink.png.sha256).toBe(
          createHash("sha256").update(bytes.png).digest("hex"),
        );
      }
      instance.reopen();
      app = instance.open(false);
      expect((await jsonCall(app, path, world.otherCookie)).status).toBe(403);
      const publish = await jsonCall(
        app,
        `/api/teacher/assignments/${assignment}`,
        world.teacher,
        "PATCH",
        { answerRelease: "on_submit" },
      );
      expect(publish.status, await publish.clone().text()).toBe(200);
      const released = await finishedResult(app, path, world.ownerCookie);
      expect(released.answersReleased).toBe(true);
      const rows = released.units.flatMap((group) => group.questions);
      for (const [index, row] of rows.entries()) {
        expect(row).toMatchObject({
          questionId: ids[index],
          answers: { kind: "final", answer: "合成参考" },
          solutionMd: "合成冻结详解。",
          answer: index === 0 || index === 2 ? text : null,
          answered: index !== 3,
          gradingPolicy: selfReview ? "reference_self" : "manual_only",
          autoCorrect: null,
          finalCorrect: null,
        });
      }
      for (const [id, ink] of uploadedInk) {
        const own = await jsonCall(
          app,
          `${path}/ink/${id}.png`,
          world.ownerCookie,
        );
        expect(own.status).toBe(200);
        expect(Buffer.from(await own.arrayBuffer())).toEqual(ink.png);
        const teacher = await jsonCall(
          app,
          `/api/teacher/ink/${ink.inkId}.json.gz`,
          world.teacher,
        );
        expect(teacher.status).toBe(200);
        expect(Buffer.from(await teacher.arrayBuffer())).toEqual(ink.vector);
      }
      expect(delivery()).toEqual([storedDelivery]);
      expect(
        sql()
          .prepare(
            `SELECT count(*) n FROM attempt_settlements WHERE attempt_id=? AND kind='final'`,
          )
          .get(attempt.id),
      ).toEqual({ n: 1 });
    } finally {
      instance.close();
    }
  },
);
