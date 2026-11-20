import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ATTEMPT_SNAPSHOT_PROOF_HEADER,
  attemptDraftOkSchema,
  attemptResultOkSchema,
  attemptStartOkSchema,
  BACKUP_KERNEL_DATABASE,
  BACKUP_KERNEL_MANIFEST,
  backupKernelManifestSchema,
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
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { zipToBackupBuffer } from "../test/backup-fixtures.ts";
import { setupAssignment } from "../test/m04-p1/product-fixture.ts";

const whole = { workflowVersion: 1, feedbackMode: "after_attempt" };

function request(
  app: ReturnType<typeof createApp>,
  cookie: string,
  path: string,
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

async function setupCourse(app: ReturnType<typeof createApp>) {
  const world = await setupAssignment(app);
  const teacher = (path: string, method: string, body?: object) =>
    request(app, world.teacher, path, method, body);
  const created = await teacher("/api/teacher/courses", "POST", {
    title: "课程整卷开卷",
  });
  expect(created.status).toBe(201);
  const {
    data: { id: courseId },
  } = z
    .object({ data: z.object({ id: z.uuid() }) })
    .parse(await created.json());
  expect(
    (
      await teacher("/api/teacher/settings/practice-feedback", "PUT", {
        practiceFeedbackPolicy: "after_attempt",
      })
    ).status,
  ).toBe(200);
  const course = `/api/teacher/courses/${courseId}`;
  expect(
    (
      await teacher(`${course}/members`, "POST", {
        studentIds: [world.studentId],
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await teacher(`${course}/items`, "POST", {
        items: [{ kind: "unit", refId: world.unitId, visible: true }],
      })
    ).status,
  ).toBe(201);
  const unitPath = `/api/student/courses/${courseId}/units/${world.unitId}`;
  return { ...world, course, unitPath };
}

it("正常课程入口对不限时整卷绑定权威，续作冻结，完成后再开空卷", async () => {
  using data = mkdtempDisposableSync(join(tmpdir(), "ownclass-course-k25-"));
  const handle = createDbHandle(join(data.path, "tutor.db"), runMigrations);
  try {
    const appWith = (kernelCourseOpeningEnabled: boolean) => {
      const options = {
        db: handle.db,
        dbHandle: handle,
        dataDir: data.path,
        kernelCourseOpeningEnabled,
        isProduction: false,
        publicUrl: "http://localhost:8787",
        logger: pino({ enabled: false }),
      };
      return createApp(options);
    };
    let app = appWith(true);
    const { ownerCookie, otherCookie, studentId, unitPath, teacher, course } =
      await setupCourse(app);
    const owner = (path: string, method?: string, body?: object) =>
      request(app, ownerCookie, path, method, body);
    const open = async () => {
      const response = await owner(`${unitPath}/attempts`, "POST", whole);
      expect(response.status, await response.clone().text()).toBe(201);
      return attemptStartOkSchema.parse(await response.json()).data;
    };
    expect((await owner(unitPath)).status).toBe(200);
    const [first, replay] = await Promise.all([open(), open()]);
    expect(replay).toEqual(first);
    expect(first.attemptNo).toBe(1);
    expect(
      (
        await owner(`${unitPath}/attempts`, "POST", {
          ...whole,
          timeLimitMinutes: 5,
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await owner(`${unitPath}/attempts`, "POST", {
          ...whole,
          restartAttemptId: first.id,
        })
      ).status,
    ).toBe(503);
    const database = join(data.path, BACKUP_KERNEL_DATABASE);
    expect(existsSync(database), "正常开卷须在 K25 创建权威活动").toBe(true);
    const actor = { role: "student" as const, id: studentId };
    const readKernel = () => {
      const runtime = openLearningRuntime({ databasePath: database });
      try {
        const activity = runtime.read(actor, first.id);
        if (!("questionDeliveries" in activity))
          throw new Error("缺少题组交付");
        return activity;
      } finally {
        runtime.close();
      }
    };
    const initial = readKernel();
    expect(initial.status).toBe("active");
    expect(initial.questionDeliveryDrafts).toEqual([]);
    const path = `/api/student/attempts/${first.id}`;
    const getDraft = async () => {
      const response = await owner(path);
      expect(response.status, await response.clone().text()).toBe(200);
      const raw = await response.json();
      assertNoLeak(raw);
      return attemptDraftOkSchema.parse(raw).data;
    };
    const blank = await getDraft();
    const [oldQuestion] = blank.units.flatMap((unit) => unit.questions);
    if (!oldQuestion) throw new Error("没有题目");
    const questionPath = `/api/teacher/questions/${encodeURIComponent(oldQuestion.id)}`;
    const readQuestion = await request(app, teacher, questionPath);
    expect(readQuestion.status).toBe(200);
    const {
      data: { sourceMd },
    } = z
      .object({
        data: z.object({ sourceMd: z.string() }),
      })
      .parse(await readQuestion.json());
    const edit = (marker: string) =>
      request(app, teacher, questionPath, "PUT", {
        sourceMd: sourceMd.replace("\n", `\n${marker}`),
      });
    expect((await edit("空卷时改题。")).status).toBe(200);
    const oldClient = await app.request(`${unitPath}/attempts`, {
      method: "POST",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      body: JSON.stringify(whole),
    });
    expect(oldClient.status).toBe(201);
    expect(attemptStartOkSchema.parse(await oldClient.json()).data).toEqual(
      first,
    );
    const sql = handle.db.$client;
    sql.exec(`CREATE TRIGGER break_course_refreeze BEFORE UPDATE OF frozen_at ON attempts
      WHEN NEW.source_type = 'course' BEGIN SELECT RAISE(ABORT, '测试中断重冻投影'); END`);
    expect((await owner(`${unitPath}/attempts`, "POST", whole)).status).toBe(
      500,
    );
    const interrupted = readKernel();
    expect(interrupted.stepAttemptId).not.toBe(initial.stepAttemptId);
    const pending = sql
      .prepare(
        "SELECT operation_id, practice_version FROM kernel_attempt_refreezes WHERE attempt_id=?",
      )
      .get(first.id);
    expect(pending).toMatchObject({ practice_version: 2 });
    expect(
      sql
        .prepare(
          "SELECT practice_version FROM kernel_course_openings WHERE attempt_id=?",
        )
        .get(first.id),
    ).toEqual({
      practice_version: 1,
    });
    sql.exec("DROP TRIGGER break_course_refreeze");
    const changeMember = (method: string) =>
      request(app, teacher, `${course}/members`, method, {
        studentIds: [studentId],
      });
    expect((await changeMember("DELETE")).status).toBe(200);
    expect((await owner(path)).status).toBe(403);
    expect(
      sql
        .prepare(
          "SELECT operation_id, practice_version FROM kernel_attempt_refreezes WHERE attempt_id=?",
        )
        .get(first.id),
    ).toEqual(pending);
    expect(readKernel()).toEqual(interrupted);
    expect((await changeMember("POST")).status).toBe(200);
    const refreshed = await open();
    expect(refreshed.id).toBe(first.id);
    expect(
      sql
        .prepare("SELECT 1 FROM kernel_attempt_refreezes WHERE attempt_id=?")
        .get(first.id),
    ).toBeUndefined();
    expect(readKernel()).toEqual(interrupted);
    expect(refreshed.frozenAt).not.toBe(first.frozenAt);
    const questions = (await getDraft()).units.flatMap(
      (unit) => unit.questions,
    );
    expect(questions).toHaveLength(2);
    const [question] = questions;
    if (!question) throw new Error("没有新版题目");
    expect(question.questionRevisionId).not.toBe(
      oldQuestion.questionRevisionId,
    );
    expect(question.questionVersion).toBe(
      (oldQuestion.questionVersion ?? 0) + 1,
    );
    expect(readKernel().stepAttemptId).not.toBe(initial.stepAttemptId);
    const save = {
      answer: { kind: "choice", index: 0 },
      baseRevision: 0,
      mutationId: randomUUID(),
      expectedFrozenAt: refreshed.frozenAt,
      questionRevisionId: question.questionRevisionId,
    };
    expect(
      (await owner(`${path}/answers/${question.id}`, "PUT", save)).status,
    ).toBe(200);
    expect(readKernel().questionDeliveryDrafts).toHaveLength(1);
    const timedResume = await owner(`${unitPath}/attempts`, "POST", {
      ...whole,
      timeLimitMinutes: 5,
    });
    expect(timedResume.status).toBe(201);
    expect(
      attemptStartOkSchema.parse(await timedResume.json()).data,
    ).toMatchObject({
      id: first.id,
      timeLimitSec: null,
    });
    expect((await edit("激活后再改题。")).status).toBe(200);
    expect((await open()).frozenAt).toBe(refreshed.frozenAt);
    expect(readKernel().stepAttemptId).toBe(interrupted.stepAttemptId);
    expect((await getDraft()).units.flatMap((unit) => unit.questions)).toEqual(
      questions,
    );
    const records = async () =>
      studentRecordsOkSchema.parse(
        await (await owner("/api/student/records?sourceType=course")).json(),
      ).data.records;
    expect(
      (await records()).find((row) => row.attemptId === first.id)
        ?.answerProgress,
    ).toEqual({
      answeredCount: 1,
      totalCount: 2,
    });
    const policy = "/api/teacher/settings/practice-feedback";
    expect(
      (
        await request(app, teacher, policy, "PUT", {
          practiceFeedbackPolicy: "student_choice",
        })
      ).status,
    ).toBe(200);
    expect((await getDraft()).practiceWorkflow).toMatchObject({
      canChangeFeedback: false,
      canSubmitQuestion: false,
      allowedFeedbackModes: ["after_attempt"],
    });
    expect(
      (
        await owner(`${path}/workflow`, "PATCH", {
          feedbackMode: "per_question",
          workflowRevision: 0,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await owner(`${path}/workflow`, "PATCH", {
          feedbackMode: "after_attempt",
          workflowRevision: 0,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await owner(`${path}/workflow`, "PATCH", {
          feedbackMode: "after_attempt",
          workflowRevision: 0,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app, teacher, policy, "PUT", {
          practiceFeedbackPolicy: "after_attempt",
        })
      ).status,
    ).toBe(200);
    app = appWith(false);
    expect(await open()).toMatchObject({
      id: first.id,
      frozenAt: refreshed.frozenAt,
    });
    const saved = await getDraft();
    expect(saved.drafts).toEqual({ [question.id]: save.answer });
    expect((await request(app, otherCookie, path)).status).toBe(403);
    const submit = {
      revisions: questions.map((item) => ({
        questionId: item.id,
        questionRevisionId: item.questionRevisionId,
        expectedAnswerRevision: saved.draftRevisions?.[item.id] ?? 0,
      })),
    };
    const response = await owner(`${path}/submit`, "POST", submit);
    expect(response.status, await response.clone().text()).toBe(200);
    const result = attemptResultOkSchema.parse(await response.json()).data;
    expect(result.attempt.id).toBe(first.id);
    expect(result.answersReleased).toBe(true);
    const complete = readKernel();
    expect(complete.status).toBe("completed");
    expect(complete.questionDeliveries).toHaveLength(1);
    expect((await owner(`${path}/submit`, "POST", submit)).status).toBe(409);
    expect(readKernel()).toEqual(complete);
    const detail = await request(
      app,
      teacher,
      `/api/teacher/attempts/${first.id}`,
    );
    expect(detail.status, await detail.clone().text()).toBe(200);
    expect(
      teacherAttemptDetailOkSchema.parse(await detail.json()).data.attemptId,
    ).toBe(first.id);
    expect(
      handle.db.$client
        .prepare(
          "SELECT count(*) AS n FROM attempt_settlements WHERE attempt_id=?",
        )
        .get(first.id),
    ).toEqual({ n: 1 });
    app = appWith(true);
    const second = await open();
    expect(second.attemptNo).toBe(2);
    expect(second.id).not.toBe(first.id);
    const secondPath = `/api/student/attempts/${second.id}`;
    const secondDraft = attemptDraftOkSchema.parse(
      await (await owner(secondPath)).json(),
    ).data;
    expect(secondDraft.drafts).toEqual({});
    const secondSave = {
      ...save,
      expectedFrozenAt: second.frozenAt,
      mutationId: randomUUID(),
      questionRevisionId:
        secondDraft.units[0]?.questions[0]?.questionRevisionId,
    };
    expect(
      (await owner(`${secondPath}/answers/${question.id}`, "PUT", secondSave))
        .status,
    ).toBe(200);
    expect((await records()).some((row) => row.attemptId === second.id)).toBe(
      true,
    );
    expect(
      (
        await request(app, teacher, `${course}/members`, "DELETE", {
          studentIds: [studentId],
        })
      ).status,
    ).toBe(200);
    expect((await owner(`${unitPath}/attempts`, "POST", whole)).status).toBe(
      403,
    );
    expect((await owner(secondPath)).status).toBe(403);
    expect(
      (await owner(`${secondPath}/answers/${question.id}`, "PUT", save)).status,
    ).toBe(403);
    expect((await owner(`${secondPath}/submit`, "POST", submit)).status).toBe(
      403,
    );
    expect((await owner(path)).status).toBe(200);
    const afterRevocation = await records();
    expect(afterRevocation.some((row) => row.attemptId === second.id)).toBe(
      false,
    );
    expect(
      afterRevocation.find((row) => row.attemptId === first.id)?.score,
    ).toBe(result.attempt.scoreAuto);
  } finally {
    handle.close();
  }
});

it("开卷在内核提交后中断可重放，同代双库恢复且跨代拒绝", async () => {
  using data = mkdtempDisposableSync(
    join(tmpdir(), "ownclass-course-backup-k25-"),
  );
  const handle = createDbHandle(join(data.path, "tutor.db"), (db) => {
    runMigrations(db);
    runBackfills(db);
  });
  try {
    const appWith = (
      kernelCourseOpeningEnabled: boolean,
      backupOperatorId?: string,
    ) =>
      createApp({
        db: handle.db,
        dbHandle: handle,
        dataDir: data.path,
        backupOperatorId,
        kernelCourseOpeningEnabled,
        isProduction: false,
        publicUrl: "http://localhost:8787",
        logger: pino({ enabled: false }),
      });
    const app = appWith(true);
    const world = await setupCourse(app);
    const sql = handle.db.$client;
    sql.exec(`CREATE TRIGGER break_course_projection BEFORE INSERT ON attempts
      WHEN NEW.source_type = 'course' BEGIN SELECT RAISE(ABORT, '测试中断开卷投影'); END`);
    const open = (
      app: ReturnType<typeof createApp>,
      cookie = world.ownerCookie,
    ) => request(app, cookie, `${world.unitPath}/attempts`, "POST", whole);
    expect((await open(app)).status).toBe(500);
    expect(
      sql
        .prepare(
          "SELECT attempt_id, step_attempt_id FROM kernel_course_openings",
        )
        .all(),
    ).toEqual([{ attempt_id: null, step_attempt_id: null }]);
    const kernel = new DatabaseSync(join(data.path, BACKUP_KERNEL_DATABASE), {
      readOnly: true,
    });
    let originalId: string;
    try {
      const ids = z
        .array(z.object({ id: z.uuid() }))
        .parse(kernel.prepare("SELECT id FROM activities").all());
      expect(ids).toHaveLength(1);
      originalId = ids[0]?.id ?? "";
    } finally {
      kernel.close();
    }
    sql.exec("DROP TRIGGER break_course_projection");
    const profile = await request(app, world.teacher, "/api/teacher/me");
    const operator = teacherInfoOkSchema.parse(await profile.json()).data.id;
    const disabled = appWith(false, operator);
    const download = async () => {
      const response = await request(
        disabled,
        world.teacher,
        "/api/teacher/backup/download",
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return new Uint8Array(await response.arrayBuffer());
    };
    const preparedBackup = await download();
    const recovered = await open(disabled);
    expect(recovered.status, await recovered.clone().text()).toBe(201);
    expect(attemptStartOkSchema.parse(await recovered.json()).data.id).toBe(
      originalId,
    );
    expect(
      sql.prepare("SELECT attempt_id FROM kernel_course_openings").all(),
    ).toEqual([{ attempt_id: originalId }]);
    expect(
      (
        await request(app, world.teacher, `${world.course}/members`, "POST", {
          studentIds: [world.otherStudentId],
        })
      ).status,
    ).toBe(200);
    expect((await open(app, world.otherCookie)).status).toBe(201);
    const later = await download();
    const earlyEntries = readZipEntriesMap(Buffer.from(preparedBackup));
    const wrongGeneration = readZipEntriesMap(Buffer.from(later));
    const earlyKernel = earlyEntries.get(BACKUP_KERNEL_DATABASE);
    if (!earlyKernel) throw new Error("早一代 ZIP 缺少内核库");
    const manifest = backupKernelManifestSchema.parse(
      JSON.parse(
        wrongGeneration.get(BACKUP_KERNEL_MANIFEST)?.toString() ?? "null",
      ),
    );
    wrongGeneration.set(BACKUP_KERNEL_DATABASE, earlyKernel);
    wrongGeneration.set(
      BACKUP_KERNEL_MANIFEST,
      Buffer.from(
        JSON.stringify({
          ...manifest,
          kernelSha256: createHash("sha256").update(earlyKernel).digest("hex"),
        }),
      ),
    );
    const stream = new ZipArchive();
    const mixed = zipToBackupBuffer({ stream, filename: "mixed.zip" });
    for (const [name, bytes] of wrongGeneration) stream.append(bytes, { name });
    await stream.finalize();
    const restore = (bytes: Uint8Array<ArrayBuffer>) => {
      const body = new FormData();
      body.set("zip", new File([bytes], "tutor-backup.zip"));
      body.set("password", "teacher-pass-8");
      return disabled.request("/api/teacher/backup/restore", {
        method: "POST",
        headers: { cookie: world.teacher },
        body,
      });
    };
    const denied = await restore(new Uint8Array(await mixed));
    expect(denied.status, await denied.clone().text()).toBe(400);
    expect(await denied.json()).toMatchObject({
      error: "BACKUP_ZIP_INVALID",
      message: expect.stringContaining("开卷记录与内核实际作答不一致"),
    });
    expect(
      sql.prepare("SELECT count(*) AS n FROM kernel_course_openings").get(),
    ).toEqual({ n: 2 });
    const restored = await restore(preparedBackup);
    expect(restored.status, await restored.clone().text()).toBe(200);
    const again = await open(disabled);
    expect(again.status, await again.clone().text()).toBe(201);
    expect(attemptStartOkSchema.parse(await again.json()).data.id).toBe(
      originalId,
    );
    expect(
      handle.db.$client
        .prepare("SELECT attempt_id FROM kernel_course_openings")
        .all(),
    ).toEqual([{ attempt_id: originalId }]);
  } finally {
    handle.close();
  }
});

it("先前无绑定草稿继续宿主续作，教师允许选择时不分配内核", async () => {
  using data = mkdtempDisposableSync(join(tmpdir(), "ownclass-course-legacy-"));
  const handle = createDbHandle(join(data.path, "tutor.db"), runMigrations);
  try {
    const appWith = (kernelCourseOpeningEnabled: boolean) =>
      createApp({
        db: handle.db,
        dbHandle: handle,
        dataDir: data.path,
        kernelCourseOpeningEnabled,
        isProduction: false,
        publicUrl: "http://localhost:8787",
        logger: pino({ enabled: false }),
      });
    const off = appWith(false);
    const world = await setupCourse(off);
    const start = async (
      app: ReturnType<typeof createApp>,
      cookie = world.ownerCookie,
    ) => {
      const response = await request(
        app,
        cookie,
        `${world.unitPath}/attempts`,
        "POST",
        whole,
      );
      expect(response.status, await response.clone().text()).toBe(201);
      return attemptStartOkSchema.parse(await response.json()).data;
    };
    const original = await start(off);
    const live = appWith(true);
    expect(await start(live)).toEqual(original);
    const sql = handle.db.$client;
    expect(
      sql.prepare("SELECT count(*) AS n FROM kernel_course_openings").get(),
    ).toEqual({ n: 0 });
    expect(
      (
        await request(live, world.teacher, `${world.course}/members`, "POST", {
          studentIds: [world.otherStudentId],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          live,
          world.teacher,
          "/api/teacher/settings/practice-feedback",
          "PUT",
          { practiceFeedbackPolicy: "student_choice" },
        )
      ).status,
    ).toBe(200);
    const free = await start(live, world.otherCookie);
    expect(
      (
        await request(
          live,
          world.otherCookie,
          `/api/student/attempts/${free.id}/workflow`,
          "PATCH",
          { feedbackMode: "per_question", workflowRevision: 0 },
        )
      ).status,
    ).toBe(200);
    expect(
      sql.prepare("SELECT count(*) AS n FROM kernel_course_openings").get(),
    ).toEqual({ n: 0 });
    expect(existsSync(join(data.path, BACKUP_KERNEL_DATABASE))).toBe(false);
    sql
      .prepare(`INSERT INTO kernel_attempt_refreezes (
      attempt_id, operation_id, step_attempt_id, expected_practice_version,
      practice_version, frozen_at, publication_json, responses_json
    ) VALUES (?, ?, ?, 1, 2, ?, '{}', '[]')`)
      .run(original.id, randomUUID(), randomUUID(), original.startedAt);
    expect(
      (
        await request(
          live,
          world.ownerCookie,
          `${world.unitPath}/attempts`,
          "POST",
          whole,
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await request(
          live,
          world.ownerCookie,
          `/api/student/attempts/${original.id}`,
        )
      ).status,
    ).toBe(503);
    expect(existsSync(join(data.path, BACKUP_KERNEL_DATABASE))).toBe(false);
  } finally {
    handle.close();
  }
});

it("明确选择限时或逐题的新课程请求沿原策略处理", async () => {
  using data = mkdtempDisposableSync(join(tmpdir(), "ownclass-course-modes-"));
  const handle = createDbHandle(join(data.path, "tutor.db"), runMigrations);
  try {
    const app = createApp({
      db: handle.db,
      dbHandle: handle,
      dataDir: data.path,
      kernelCourseOpeningEnabled: true,
      isProduction: false,
      publicUrl: "http://localhost:8787",
      logger: pino({ enabled: false }),
    });
    const world = await setupCourse(app);
    const start = async (cookie: string, options: object) => {
      const opened = await request(
        app,
        cookie,
        `${world.unitPath}/attempts`,
        "POST",
        options,
      );
      expect(opened.status, await opened.clone().text()).toBe(201);
      return attemptStartOkSchema.parse(await opened.json()).data;
    };
    const timed = await start(world.ownerCookie, {
      ...whole,
      timeLimitMinutes: 5,
    });
    expect(timed).toMatchObject({ timeLimitSec: 300, phase: "active" });
    const restarted = await start(world.ownerCookie, {
      ...whole,
      restartAttemptId: timed.id,
    });
    expect(restarted.attemptNo).toBe(2);
    expect(restarted.id).not.toBe(timed.id);
    const added = await request(
      app,
      world.teacher,
      `${world.course}/members`,
      "POST",
      {
        studentIds: [world.otherStudentId],
      },
    );
    expect(added.status).toBe(200);
    const requestedPerQuestion = await start(world.otherCookie, {
      ...whole,
      feedbackMode: "per_question",
    });
    const draft = await request(
      app,
      world.otherCookie,
      `/api/student/attempts/${requestedPerQuestion.id}`,
    );
    expect(
      attemptDraftOkSchema.parse(await draft.json()).data.practiceWorkflow
        ?.feedbackMode,
    ).toBe("after_attempt");
    expect(
      handle.db.$client
        .prepare("SELECT count(*) AS n FROM kernel_course_openings")
        .get(),
    ).toEqual({
      n: 0,
    });
    expect(existsSync(join(data.path, BACKUP_KERNEL_DATABASE))).toBe(false);
  } finally {
    handle.close();
  }
});
