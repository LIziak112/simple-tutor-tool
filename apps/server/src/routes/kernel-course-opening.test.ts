import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempDisposableSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ATTEMPT_SNAPSHOT_PROOF_HEADER,
  ATTEMPT_TIME_UP_GRACE_SEC,
  attemptDraftOkSchema,
  attemptResultOkSchema,
  attemptStartOkSchema,
  BACKUP_KERNEL_DATABASE,
  BACKUP_KERNEL_MANIFEST,
  backupKernelManifestSchema,
  noteHeadDataSchema,
  studentCourseDetailOkSchema,
  studentCourseListOkSchema,
  studentRecordsOkSchema,
  studentUnitLandingOkSchema,
  teacherAttemptDetailOkSchema,
  teacherInfoOkSchema,
} from "@tutor/contract";
import { ZipArchive } from "archiver";
import { openLearningRuntime } from "learning-kernel";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp } from "../app.ts";
import { runBackfills } from "../db/backfill.ts";
import { createDbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { readZipEntriesMap } from "../lib/zip-read.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { zipToBackupBuffer } from "../test/backup-fixtures.ts";
import {
  loginAssignmentOwner,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import {
  gzipJson,
  makeNotePng,
  noteDoc,
  postNoteImage,
  putNoteForm,
  putNoteReceipt,
} from "../test/note-fixtures.ts";

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
    const openOldClient = () =>
      app.request(`${unitPath}/attempts`, {
        method: "POST",
        headers: { cookie: ownerCookie, "content-type": "application/json" },
        body: JSON.stringify(whole),
      });
    const oldClient = await openOldClient();
    expect(oldClient.status).toBe(201);
    expect(attemptStartOkSchema.parse(await oldClient.json()).data).toEqual(
      first,
    );
    const sql = handle.db.$client;
    const changeMember = (method: string) =>
      request(app, teacher, `${course}/members`, method, {
        studentIds: [studentId],
      });
    const pendingRefreeze = () =>
      sql
        .prepare(
          "SELECT operation_id, practice_version FROM kernel_attempt_refreezes WHERE attempt_id=?",
        )
        .get(first.id);
    const kernelDb = new DatabaseSync(database);
    try {
      kernelDb.exec(`CREATE TRIGGER break_before_course_step BEFORE UPDATE OF practice_version ON activities
        BEGIN SELECT RAISE(ABORT, '测试中断内核换版'); END`);
      expect((await owner(`${unitPath}/attempts`, "POST", whole)).status).toBe(
        500,
      );
      kernelDb.exec("DROP TRIGGER break_before_course_step");
    } finally {
      kernelDb.close();
    }
    const beforeTeacherRead = pendingRefreeze();
    expect(beforeTeacherRead).toMatchObject({ practice_version: 2 });
    expect(readKernel()).toEqual(initial);
    expect((await changeMember("DELETE")).status).toBe(200);
    const teacherWhileRemoved = await request(
      app,
      teacher,
      `/api/teacher/attempts/${first.id}`,
    );
    expect(
      teacherWhileRemoved.status,
      await teacherWhileRemoved.clone().text(),
    ).toBe(200);
    expect(
      teacherAttemptDetailOkSchema.parse(await teacherWhileRemoved.json()).data
        .attemptId,
    ).toBe(first.id);
    expect(readKernel()).toEqual(initial);
    expect(pendingRefreeze()).toEqual(beforeTeacherRead);
    expect((await changeMember("POST")).status).toBe(200);
    const pendingOldClient = await openOldClient();
    expect(pendingOldClient.status).toBe(201);
    expect(
      attemptStartOkSchema.parse(await pendingOldClient.json()).data,
    ).toEqual(first);
    expect(pendingRefreeze()).toEqual(beforeTeacherRead);
    expect(readKernel()).toEqual(initial);
    sql.exec(`CREATE TRIGGER break_course_refreeze BEFORE UPDATE OF frozen_at ON attempts
      WHEN NEW.source_type = 'course' BEGIN SELECT RAISE(ABORT, '测试中断重冻投影'); END`);
    expect((await owner(`${unitPath}/attempts`, "POST", whole)).status).toBe(
      500,
    );
    const interrupted = readKernel();
    expect(interrupted.stepAttemptId).not.toBe(initial.stepAttemptId);
    const pending = pendingRefreeze();
    expect(pending).toEqual(beforeTeacherRead);
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
      answer: { kind: "choice", index: 1 },
      baseRevision: 0,
      mutationId: randomUUID(),
      expectedFrozenAt: refreshed.frozenAt,
      questionRevisionId: question.questionRevisionId,
    };
    sql.exec(`CREATE TRIGGER break_course_activation BEFORE UPDATE OF activated_at ON attempts
      WHEN NEW.source_type = 'course' BEGIN SELECT RAISE(ABORT, '测试中断首次作答投影'); END`);
    expect(
      (await owner(`${path}/answers/${question.id}`, "PUT", save)).status,
    ).toBe(500);
    expect(readKernel().questionDeliveryDrafts).toHaveLength(1);
    sql.exec("DROP TRIGGER break_course_activation");
    const alreadySaved = await owner(`${unitPath}/attempts`, "POST", {
      ...whole,
      timeLimitMinutes: 5,
    });
    expect(alreadySaved.status).toBe(201);
    expect(attemptStartOkSchema.parse(await alreadySaved.json()).data).toEqual(
      refreshed,
    );
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
        await owner(`${unitPath}/attempts`, "POST", {
          restartAttemptId: first.id,
        })
      ).status,
    ).toBe(503);
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
    expect(result.attempt.scoreAuto).toBe(50);
    const counts = {
      correctCount: 1,
      totalCount: 2,
      pendingCount: 0,
      pendingSelfReviewCount: 0,
    };
    const landing = studentUnitLandingOkSchema.parse(
      await (await owner(unitPath)).json(),
    ).data;
    expect(landing.attempts).toEqual([
      expect.objectContaining({
        attemptId: first.id,
        score: 50,
        resultCounts: counts,
      }),
    ]);
    const summary = {
      firstScore: 50,
      latestScore: 50,
      bestScore: 50,
      firstResultCounts: counts,
      latestResultCounts: counts,
      bestResultCounts: counts,
    };
    expect(landing.summary).toMatchObject(summary);
    const coursePath = unitPath.split("/units/")[0] ?? "";
    const directory = studentCourseDetailOkSchema.parse(
      await (await owner(coursePath)).json(),
    ).data;
    expect(
      directory.items.find((item) => item.kind === "unit")?.attempt,
    ).toMatchObject(summary);
    const courses = studentCourseListOkSchema.parse(
      await (await owner("/api/student/courses")).json(),
    ).data.courses;
    expect(courses).toEqual([
      expect.objectContaining({ completedUnitCount: 1 }),
    ]);
    expect(
      sql
        .prepare("SELECT score_auto, score_final FROM attempts WHERE id=?")
        .get(first.id),
    ).toEqual({
      score_auto: null,
      score_final: null,
    });
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
    const restart = () =>
      owner(`${unitPath}/attempts`, "POST", {
        restartAttemptId: second.id,
        timeLimitMinutes: 5,
      });
    expect(
      (
        await owner(`${unitPath}/attempts`, "POST", {
          ...whole,
          restartAttemptId: second.id,
          feedbackMode: "per_question",
        })
      ).status,
    ).toBe(503);
    app = appWith(false);
    expect((await restart()).status).toBe(503);
    expect(await open()).toMatchObject({ id: second.id });
    app = appWith(true);
    const [firstRestart, repeatedRestart] = await Promise.all([
      restart(),
      restart(),
    ]);
    expect(firstRestart.status, await firstRestart.clone().text()).toBe(201);
    expect(repeatedRestart.status).toBe(409);
    expect(await repeatedRestart.json()).toMatchObject({
      error: "ATTEMPT_RESTART_STALE",
    });
    const restarted = await firstRestart.json();
    assertNoLeak(restarted, {
      forbid: ["restartAttemptId", "questions", "stemMd"],
    });
    const third = attemptStartOkSchema.parse(restarted).data;
    expect(third.id).not.toBe(second.id);
    expect(third).toMatchObject({
      attemptNo: 3,
      phase: "active",
      activatedAt: third.startedAt,
      timeLimitSec: 300,
      deadlineAt: new Date(Date.parse(third.startedAt) + 300_000).toISOString(),
    });
    expect(await open()).toEqual(third);
    const thirdPath = `/api/student/attempts/${third.id}`;
    const thirdRaw = await (await owner(thirdPath)).json();
    assertNoLeak(thirdRaw);
    const thirdDraft = attemptDraftOkSchema.parse(thirdRaw).data;
    expect(thirdDraft.drafts).toEqual({});
    expect(thirdDraft.timing?.phase).toBe("running");
    expect(thirdDraft.units[0]?.questions[0]?.questionRevisionId).not.toBe(
      secondSave.questionRevisionId,
    );
    for (const denied of [
      await owner(secondPath),
      await owner(`${secondPath}/answers/${question.id}`, "PUT", secondSave),
      await owner(`${secondPath}/submit`, "POST", { revisions: [] }),
    ]) {
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({ error: "ATTEMPT_ABANDONED" });
    }
    const runtime = openLearningRuntime({ databasePath: database });
    try {
      expect(runtime.read(actor, second.id)).toMatchObject({
        questionDeliveryDrafts: [
          expect.objectContaining({ questionId: question.id }),
        ],
        questionDeliveries: [],
      });
      expect(runtime.read(actor, third.id)).toMatchObject({
        questionDeliveryDrafts: [],
        questionDeliveries: [],
      });
    } finally {
      runtime.close();
    }
    expect(readKernel()).toEqual(complete);
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
    expect((await owner(thirdPath)).status).toBe(403);
    expect(
      (await owner(`${thirdPath}/answers/${question.id}`, "PUT", save)).status,
    ).toBe(403);
    expect((await owner(`${thirdPath}/submit`, "POST", submit)).status).toBe(
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
      options: object = whole,
    ) => request(app, cookie, `${world.unitPath}/attempts`, "POST", options);
    expect(
      (await open(app, world.ownerCookie, { ...whole, timeLimitMinutes: 5 }))
        .status,
    ).toBe(500);
    expect(
      sql
        .prepare(
          "SELECT attempt_id, step_attempt_id, json_extract(draft_json, '$.timeLimitMinutes') AS minutes FROM kernel_course_openings",
        )
        .all(),
    ).toEqual([{ attempt_id: null, step_attempt_id: null, minutes: 5 }]);
    const kernel = new DatabaseSync(join(data.path, BACKUP_KERNEL_DATABASE), {
      readOnly: true,
    });
    let original: { id: string; started_at: string; step_id: string };
    try {
      const activities = z
        .array(
          z.object({
            id: z.uuid(),
            started_at: z.iso.datetime(),
            step_id: z.uuid(),
          }),
        )
        .parse(
          kernel
            .prepare(
              "SELECT id, started_at, initial_prepared_step_attempt_id AS step_id FROM activities",
            )
            .all(),
        );
      expect(activities).toHaveLength(1);
      if (!activities[0]) throw new Error("没有已预备的内核活动");
      original = activities[0];
    } finally {
      kernel.close();
    }
    sql.exec("DROP TRIGGER break_course_projection");
    const frozen = z
      .object({ id: z.string(), version: z.number() })
      .parse(
        sql
          .prepare(
            "SELECT json_extract(draft_json, '$.responses[0].question.id') AS id, json_extract(draft_json, '$.responses[0].questionVersion') AS version FROM kernel_course_openings",
          )
          .get(),
      );
    const questionPath = `/api/teacher/questions/${encodeURIComponent(frozen.id)}`;
    const question = await request(app, world.teacher, questionPath);
    const {
      data: { sourceMd },
    } = z
      .object({ data: z.object({ sourceMd: z.string() }) })
      .parse(await question.json());
    expect(
      (
        await request(app, world.teacher, questionPath, "PUT", {
          sourceMd: sourceMd.replace("\n", "\n开卷准备中改变题面。"),
        })
      ).status,
    ).toBe(200);
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
    const recovered = await open(disabled, world.ownerCookie, {
      ...whole,
      timeLimitMinutes: 10,
    });
    expect(recovered.status, await recovered.clone().text()).toBe(201);
    const timed = attemptStartOkSchema.parse(await recovered.json()).data;
    expect(timed).toMatchObject({
      id: original.id,
      phase: "active",
      startedAt: original.started_at,
      frozenAt: original.started_at,
      activatedAt: original.started_at,
      timeLimitSec: 300,
      deadlineAt: new Date(
        Date.parse(original.started_at) + 300_000,
      ).toISOString(),
    });
    expect(
      sql
        .prepare(
          "SELECT attempt_id, step_attempt_id FROM kernel_course_openings",
        )
        .all(),
    ).toEqual([{ attempt_id: original.id, step_attempt_id: original.step_id }]);
    const resumed = await request(
      disabled,
      world.ownerCookie,
      `/api/student/attempts/${original.id}`,
    );
    expect(resumed.status).toBe(200);
    const resumedDraft = attemptDraftOkSchema.parse(await resumed.json()).data;
    expect(
      resumedDraft.units.flatMap(({ questions }) => questions)[0],
    ).toMatchObject({
      id: frozen.id,
      questionVersion: frozen.version,
    });
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
    expect(attemptStartOkSchema.parse(await again.json()).data).toEqual(timed);
    expect(
      handle.db.$client
        .prepare("SELECT attempt_id FROM kernel_course_openings")
        .all(),
    ).toEqual([{ attempt_id: original.id }]);
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
    sql
      .prepare("DELETE FROM kernel_attempt_refreezes WHERE attempt_id=?")
      .run(original.id);
    const legacyPath = `/api/student/attempts/${original.id}`;
    const legacyDraft = attemptDraftOkSchema.parse(
      await (await request(live, world.ownerCookie, legacyPath)).json(),
    ).data;
    const questions = legacyDraft.units.flatMap((unit) => unit.questions);
    const [question] = questions;
    if (!question) throw new Error("缺少旧卷冻结题");
    const note = await putNoteReceipt(
      live,
      world.ownerCookie,
      original.id,
      question.id,
    );
    const submitted = await request(
      live,
      world.ownerCookie,
      `${legacyPath}/submit`,
      "POST",
      {
        revisions: questions.map(({ id, questionRevisionId }) => ({
          questionId: id,
          questionRevisionId,
          expectedAnswerRevision: 0,
        })),
        evidence: questions.map(({ id }) =>
          id === question.id
            ? {
                questionId: id,
                state: "frozen",
                versionId: note.versionId,
                revision: note.revision,
              }
            : { questionId: id, state: "none" },
        ),
      },
    );
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    expect(
      sql
        .prepare(
          "SELECT state, version_id FROM submission_evidence WHERE attempt_id=? AND question_id=?",
        )
        .get(original.id, question.id),
    ).toEqual({ state: "frozen", version_id: note.versionId });
    expect(
      sql
        .prepare("SELECT count(*) AS n FROM attempt_original_reservations")
        .get(),
    ).toEqual({ n: 0 });
    expect(existsSync(join(data.path, BACKUP_KERNEL_DATABASE))).toBe(false);
  } finally {
    handle.close();
  }
});

it("限时重开的两个断点保留第一次选择、旧卷和原意图，同代归档可继续", async () => {
  using data = mkdtempDisposableSync(
    join(tmpdir(), "ownclass-course-restart-"),
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
    const enabled = appWith(true);
    const world = await setupCourse(enabled);
    const profile = await request(enabled, world.teacher, "/api/teacher/me");
    const operator = teacherInfoOkSchema.parse(await profile.json()).data.id;
    const disabled = appWith(false, operator);
    const open = (app: ReturnType<typeof createApp>, options: object = whole) =>
      request(
        app,
        world.ownerCookie,
        `${world.unitPath}/attempts`,
        "POST",
        options,
      );
    const previous = attemptStartOkSchema.parse(
      await (await open(enabled, { ...whole, timeLimitMinutes: 11 })).json(),
    ).data;
    const path = `/api/student/attempts/${previous.id}`;
    const restart = { restartAttemptId: previous.id, timeLimitMinutes: 5 };
    const draft = attemptDraftOkSchema.parse(
      await (await request(enabled, world.ownerCookie, path)).json(),
    ).data;
    const question = draft.units[0]?.questions[0];
    if (!question) throw new Error("缺少冻结题");
    expect(
      (
        await request(
          enabled,
          world.ownerCookie,
          `${path}/answers/${question.id}`,
          "PUT",
          {
            answer: { kind: "choice", index: 1 },
            baseRevision: 0,
            mutationId: randomUUID(),
            expectedFrozenAt: previous.frozenAt,
            questionRevisionId: question.questionRevisionId,
          },
        )
      ).status,
    ).toBe(200);
    const note = await putNoteReceipt(
      enabled,
      world.ownerCookie,
      previous.id,
      question.id,
    );
    const database = join(data.path, BACKUP_KERNEL_DATABASE);
    const readPrevious = () => {
      const runtime = openLearningRuntime({ databasePath: database });
      try {
        return runtime.read(
          { role: "student", id: world.studentId },
          previous.id,
        );
      } finally {
        runtime.close();
      }
    };
    const oldActivity = readPrevious();
    const activityIds = () => {
      using kernel = new DatabaseSync(database, { readOnly: true });
      return z
        .array(z.object({ id: z.uuid() }))
        .parse(kernel.prepare("SELECT id FROM activities ORDER BY rowid").all())
        .map(({ id }) => id);
    };
    const sql = () => handle.db.$client;
    const noteVersion = () =>
      z
        .object({ body_path: z.string() })
        .passthrough()
        .parse(
          sql()
            .prepare("SELECT * FROM note_versions WHERE id=?")
            .get(note.versionId),
        );
    const original = noteVersion();
    const originalBody = readFileSync(join(data.path, original.body_path));
    const pending = () =>
      sql()
        .prepare(`SELECT operation_id, attempt_id, practice_id, practice_version, draft_json,
        json_extract(draft_json, '$.restartAttemptId') AS predecessor,
        json_extract(draft_json, '$.timeLimitMinutes') AS minutes
      FROM kernel_course_openings WHERE attempt_no=2`)
        .get();
    const download = async () => {
      const response = await request(
        disabled,
        world.teacher,
        "/api/teacher/backup/download",
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return new Uint8Array(await response.arrayBuffer());
    };
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
    const submitOld = () =>
      request(disabled, world.ownerCookie, `${path}/submit`, "POST", {
        revisions: [],
      });
    const kernelExec = (statement: string) => {
      using kernel = new DatabaseSync(database);
      kernel.exec(statement);
    };

    kernelExec(`CREATE TRIGGER stop_restart_prepare BEFORE INSERT ON activities
      BEGIN SELECT RAISE(ABORT, '测试中断新活动准备'); END`);
    const preKernel = await open(enabled, restart);
    expect(preKernel.status).toBe(500);
    const intent = pending();
    expect(intent).toMatchObject({
      attempt_id: null,
      predecessor: previous.id,
      minutes: 5,
    });
    expect(activityIds()).toEqual([previous.id]);
    expect((await submitOld()).status).toBe(503);
    kernelExec("DROP TRIGGER stop_restart_prepare");
    const beforePrepare = await download();
    const restoredIntent = await restore(beforePrepare);
    expect(restoredIntent.status, await restoredIntent.clone().text()).toBe(
      200,
    );
    expect(activityIds()).toEqual([previous.id]);
    expect(pending()).toEqual(intent);

    sql().exec(`CREATE TEMP TRIGGER stop_restart_projection BEFORE UPDATE OF abandoned_at ON attempts
      BEGIN SELECT RAISE(ABORT, '测试中断换卷投影'); END`);
    const postKernel = await open(enabled, { ...restart, timeLimitMinutes: 9 });
    expect(postKernel.status).toBe(500);
    expect(pending()).toEqual(intent);
    expect(
      sql()
        .prepare("SELECT abandoned_at FROM attempts WHERE id=?")
        .get(previous.id),
    ).toEqual({ abandoned_at: null });
    const prepared = activityIds();
    expect(prepared).toHaveLength(2);
    const [oldId, preparedId] = prepared;
    if (!preparedId) throw new Error("缺少已准备新卷");
    const preparedCoordinates = () => {
      using kernel = new DatabaseSync(database, { readOnly: true });
      return z
        .object({ startedAt: z.iso.datetime(), stepId: z.uuid() })
        .parse(
          kernel
            .prepare(
              "SELECT started_at AS startedAt, initial_prepared_step_attempt_id AS stepId FROM activities WHERE id=?",
            )
            .get(preparedId),
        );
    };
    const coordinates = preparedCoordinates();
    expect((await submitOld()).status).toBe(503);
    expect(
      sql()
        .prepare("SELECT 1 FROM kernel_question_deliveries WHERE attempt_id=?")
        .get(previous.id),
    ).toBeUndefined();
    sql().exec("DROP TRIGGER stop_restart_projection");

    const members = `${world.course}/members`;
    const updateMembers = (method: string) =>
      request(disabled, world.teacher, members, method, {
        studentIds: [world.studentId],
      });
    expect((await updateMembers("DELETE")).status).toBe(200);
    expect((await open(disabled, restart)).status).toBe(403);
    expect((await submitOld()).status).toBe(403);
    expect(pending()).toEqual(intent);
    expect(activityIds()).toEqual(prepared);
    expect((await updateMembers("POST")).status).toBe(200);
    const afterPrepare = await download();
    const restoredPrepared = await restore(afterPrepare);
    expect(restoredPrepared.status, await restoredPrepared.clone().text()).toBe(
      200,
    );
    expect(pending()).toEqual(intent);
    expect(activityIds()).toEqual(prepared);

    const recovered = await open(disabled, {
      ...restart,
      timeLimitMinutes: 12,
    });
    expect(recovered.status, await recovered.clone().text()).toBe(201);
    const found = attemptStartOkSchema.parse(await recovered.json()).data;
    expect(found).toMatchObject({
      id: preparedId,
      phase: "active",
      startedAt: coordinates.startedAt,
      activatedAt: coordinates.startedAt,
      frozenAt: coordinates.startedAt,
      timeLimitSec: 300,
      deadlineAt: new Date(
        Date.parse(coordinates.startedAt) + 300_000,
      ).toISOString(),
    });
    expect(preparedCoordinates()).toEqual(coordinates);
    expect(oldId).toBe(previous.id);
    expect(readPrevious()).toEqual(oldActivity);
    expect(
      sql()
        .prepare(
          "SELECT activated_at, time_limit_sec, deadline_at, frozen_at FROM attempts WHERE id=?",
        )
        .get(previous.id),
    ).toEqual({
      activated_at: previous.activatedAt,
      time_limit_sec: 660,
      deadline_at: previous.deadlineAt,
      frozen_at: previous.frozenAt,
    });
    expect((await open(disabled, restart)).status).toBe(409);
    expect(noteVersion()).toEqual(original);
    expect(readFileSync(join(data.path, original.body_path))).toEqual(
      originalBody,
    );
    expect(
      await (
        await request(
          disabled,
          world.ownerCookie,
          `/api/student/attempts/${found.id}/notes/${question.id}`,
        )
      ).json(),
    ).toMatchObject({ data: { note: null, evidence: null, images: [] } });
    const beforeKernel = readZipEntriesMap(Buffer.from(beforePrepare)).get(
      BACKUP_KERNEL_DATABASE,
    );
    if (!beforeKernel) throw new Error("较早归档缺内核库");
    const newer = readZipEntriesMap(Buffer.from(await download()));
    const manifest = backupKernelManifestSchema.parse(
      JSON.parse(newer.get(BACKUP_KERNEL_MANIFEST)?.toString() ?? "null"),
    );
    newer.set(BACKUP_KERNEL_DATABASE, beforeKernel);
    newer.set(
      BACKUP_KERNEL_MANIFEST,
      Buffer.from(
        JSON.stringify({
          ...manifest,
          kernelSha256: createHash("sha256").update(beforeKernel).digest("hex"),
        }),
      ),
    );
    const archive = new ZipArchive();
    const mixed = zipToBackupBuffer({
      stream: archive,
      filename: "mixed-restart.zip",
    });
    for (const [name, bytes] of newer) archive.append(bytes, { name });
    await archive.finalize();
    const rejected = await restore(new Uint8Array(await mixed));
    expect(rejected.status, await rejected.clone().text()).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: "BACKUP_ZIP_INVALID",
      message: expect.stringContaining("开卷记录与内核实际作答不一致"),
    });
    expect(activityIds()).toEqual(prepared);
    expect(
      attemptStartOkSchema.parse(await (await open(disabled)).json()).data,
    ).toEqual(found);
    const noLimit = await open(enabled, { restartAttemptId: found.id });
    expect(noLimit.status, await noLimit.clone().text()).toBe(201);
    const last = attemptStartOkSchema.parse(await noLimit.json()).data;
    expect(last.id).not.toBe(found.id);
    expect(activityIds()).toEqual([...prepared, last.id]);
    expect(last).toMatchObject({
      attemptNo: 3,
      phase: "opened",
      activatedAt: null,
      timeLimitSec: null,
      deadlineAt: null,
    });
    const lastDraft = await request(
      enabled,
      world.ownerCookie,
      `/api/student/attempts/${last.id}`,
    );
    expect(lastDraft.status).toBe(200);
    expect(
      attemptDraftOkSchema.parse(await lastDraft.json()).data,
    ).toMatchObject({
      drafts: {},
      timing: null,
    });
  } finally {
    handle.close();
  }
});

it("课程冻结原稿经双库断点和两设备核对后仍以同一回执落地", async () => {
  using data = mkdtempDisposableSync(
    join(tmpdir(), "ownclass-course-restart-submit-"),
  );
  const openProduct = () =>
    createDbHandle(join(data.path, "tutor.db"), runMigrations);
  let handle = openProduct();
  const openApp = (kernelCourseOpeningEnabled: boolean) =>
    createApp({
      db: handle.db,
      dbHandle: handle,
      dataDir: data.path,
      kernelCourseOpeningEnabled,
      isProduction: false,
      publicUrl: "http://localhost:8787",
      logger: pino({ enabled: false }),
    });
  try {
    let app = openApp(true);
    const world = await setupCourse(app);
    const secondDevice = await loginAssignmentOwner(app);
    expect(secondDevice).not.toBe(world.ownerCookie);
    const owner = (path: string, method = "GET", body?: object) =>
      request(app, world.ownerCookie, path, method, body);
    const entry = `${world.unitPath}/attempts`;
    const old = attemptStartOkSchema.parse(
      await (await owner(entry, "POST", whole)).json(),
    ).data;
    const path = `/api/student/attempts/${old.id}`;
    const draft = attemptDraftOkSchema.parse(
      await (await owner(path)).json(),
    ).data;
    const questions = draft.units.flatMap((unit) => unit.questions);
    const [question, missingQuestion] = questions;
    if (!question || !missingQuestion) throw new Error("缺少冻结题");
    const saved = await owner(`${path}/answers/${question.id}`, "PUT", {
      answer: { kind: "choice", index: 1 },
      baseRevision: 0,
      mutationId: randomUUID(),
      expectedFrozenAt: old.frozenAt,
      questionRevisionId: question.questionRevisionId,
    });
    expect(saved.status).toBe(200);
    const firstNote = await putNoteReceipt(
      app,
      world.ownerCookie,
      old.id,
      question.id,
    );
    const missingNote = await putNoteReceipt(
      app,
      world.ownerCookie,
      old.id,
      missingQuestion.id,
    );
    const submission = ({
      versionId,
      revision,
    }: Pick<typeof firstNote, "versionId" | "revision">) => ({
      revisions: questions.map((item) => ({
        questionId: item.id,
        questionRevisionId: item.questionRevisionId,
        expectedAnswerRevision: item.id === question.id ? 1 : 0,
      })),
      evidence: questions.map(({ id: questionId }) =>
        questionId === question.id
          ? {
              questionId,
              state: "frozen",
              versionId,
              revision,
            }
          : {
              questionId,
              state: questionId === missingQuestion.id ? "missing" : "none",
            },
      ),
    });
    const perform = (
      body: ReturnType<typeof submission>,
      cookie = world.ownerCookie,
    ) => request(app, cookie, `${path}/submit`, "POST", body);
    const wrongQuestion = await perform({
      ...submission(firstNote),
      evidence: submission(firstNote).evidence.map((item) =>
        item.questionId === question.id
          ? { ...item, questionId: "题组外的题" }
          : item,
      ),
    });
    expect(wrongQuestion.status).toBe(409);
    expect(await wrongQuestion.json()).toMatchObject({
      error: "NOTE_EVIDENCE_MISMATCH",
    });
    expect(
      (
        await request(app, world.teacher, `${world.course}/members`, "POST", {
          studentIds: [world.otherStudentId],
        })
      ).status,
    ).toBe(200);
    const foreign = attemptStartOkSchema.parse(
      await (
        await request(app, world.otherCookie, entry, "POST", whole)
      ).json(),
    ).data;
    const foreignNote = await putNoteReceipt(
      app,
      world.otherCookie,
      foreign.id,
      question.id,
    );
    const wrongOwner = await perform(submission(foreignNote));
    expect(wrongOwner.status).toBe(409);
    expect(await wrongOwner.json()).toMatchObject({
      error: "NOTE_EVIDENCE_MISMATCH",
    });
    expect(
      (await perform(submission(firstNote), world.otherCookie)).status,
    ).toBe(403);
    let sql = handle.db.$client;
    const currentBinding = z
      .object({ attempt_no: z.number() })
      .parse(
        sql
          .prepare(
            "SELECT attempt_no FROM kernel_course_openings WHERE attempt_id=?",
          )
          .get(old.id),
      );
    const setBindingRound = (round: number) =>
      sql
        .prepare(
          "UPDATE kernel_course_openings SET attempt_no=? WHERE attempt_id=?",
        )
        .run(round, old.id);
    setBindingRound(currentBinding.attempt_no + 1);
    const wrongBinding = await perform(submission(firstNote));
    expect(wrongBinding.status).toBe(503);
    expect(await wrongBinding.json()).toMatchObject({
      error: "KERNEL_ATTEMPT_UNAVAILABLE",
    });
    setBindingRound(currentBinding.attempt_no);
    const held = () =>
      sql
        .prepare(`SELECT r.version_id, r.state, r.operation_id
      FROM attempt_original_reservations r JOIN kernel_question_deliveries d
        ON d.attempt_id=r.attempt_id AND d.operation_id=r.operation_id
      WHERE r.attempt_id=?`)
        .get(old.id);
    const storedPath = join(
      data.path,
      z
        .object({ body_path: z.string() })
        .parse(
          sql
            .prepare("SELECT body_path FROM note_versions WHERE id=?")
            .get(firstNote.versionId),
        ).body_path,
    );
    const firstBody = readFileSync(storedPath);
    try {
      writeFileSync(storedPath, gzipJson(noteDoc(3)));
      const damaged = await perform(submission(firstNote));
      expect(damaged.status).toBe(500);
      expect(await damaged.json()).toMatchObject({
        error: "NOTE_BODY_UNREADABLE",
      });
    } finally {
      writeFileSync(storedPath, firstBody);
    }
    expect(held()).toBeUndefined();
    const kernelExec = (statement: string) => {
      using kernel = new DatabaseSync(join(data.path, BACKUP_KERNEL_DATABASE));
      kernel.exec(statement);
    };
    const readOld = () => {
      const runtime = openLearningRuntime({
        databasePath: join(data.path, BACKUP_KERNEL_DATABASE),
      });
      try {
        return runtime.read({ role: "student", id: world.studentId }, old.id);
      } finally {
        runtime.close();
      }
    };
    kernelExec(`CREATE TRIGGER stop_confirmation BEFORE INSERT ON submissions
      BEGIN SELECT RAISE(ABORT, '测试中断权威确认'); END`);
    const beforeKernel = await perform(submission(firstNote));
    expect(beforeKernel.status, await beforeKernel.clone().text()).toBe(500);
    const reserved = held();
    expect(reserved).toMatchObject({
      version_id: firstNote.versionId,
      state: "pending",
    });
    expect(readOld()).toMatchObject({
      status: "active",
      questionDeliveries: [],
    });
    handle.close();
    handle = openProduct();
    sql = handle.db.$client;
    app = openApp(true);
    const replay = await perform(submission(firstNote), secondDevice);
    expect(replay.status).toBe(500);
    expect(held()).toEqual(reserved);
    kernelExec("DROP TRIGGER stop_confirmation");
    const note = await putNoteReceipt(
      app,
      secondDevice,
      old.id,
      question.id,
      2,
      {
        baseRevision: firstNote.revision,
      },
    );
    const stale = await perform(submission(firstNote));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: "NOTE_EVIDENCE_MISMATCH",
    });
    expect(held()).toBeUndefined();
    expect(
      sql
        .prepare(
          "SELECT state FROM attempt_original_reservations WHERE attempt_id=?",
        )
        .all(old.id),
    ).toEqual([{ state: "aborted" }]);

    const png = makeNotePng();
    const uploaded = await postNoteImage(
      app,
      "student",
      note.versionId,
      png,
      secondDevice,
    );
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    const {
      data: { imageId },
    } = z
      .object({ data: z.object({ imageId: z.uuid() }) })
      .parse(await uploaded.json());
    const readBytes = async (role: "student" | "teacher", part: string) => {
      const response = await request(
        app,
        role === "student" ? secondDevice : world.teacher,
        `/api/${role}/note-versions/${note.versionId}/${part}`,
      );
      expect(response.status).toBe(200);
      return new Uint8Array(await response.arrayBuffer());
    };
    const originalBytes = await readBytes("student", "document");
    const image = `images/${imageId}.png`;
    expect(await readBytes("student", image)).toEqual(png);
    const submit = submission(note);
    sql.exec(`CREATE TEMP TRIGGER stop_old_submission BEFORE UPDATE OF receipt_id ON kernel_question_deliveries
      BEGIN SELECT RAISE(ABORT, '测试中断旧卷正式回执投影'); END`);
    const interrupted = await perform(submit);
    expect(interrupted.status, await interrupted.clone().text()).toBe(500);
    const receipt = readOld();
    expect(receipt.status).toBe("completed");
    if (!("questionDeliveries" in receipt)) throw new Error("缺少权威交卷记录");
    const receiptId = receipt.questionDeliveries[0]?.receipt?.id;
    expect(receiptId).toEqual(expect.any(String));
    expect(held()).toMatchObject({
      version_id: note.versionId,
      state: "pending",
    });
    expect(
      sql.prepare("SELECT status FROM attempts WHERE id=?").get(old.id),
    ).toEqual({ status: "draft" });
    expect(
      sql
        .prepare("SELECT * FROM submission_evidence WHERE attempt_id=?")
        .all(old.id),
    ).toEqual([]);
    expect(
      sql
        .prepare("SELECT * FROM attempt_settlements WHERE attempt_id=?")
        .all(old.id),
    ).toEqual([]);
    handle.close();
    handle = openProduct();
    sql = handle.db.$client;
    app = openApp(false);
    const rejectedWrite = await app.request(`${path}/notes/${question.id}`, {
      method: "PUT",
      headers: { cookie: secondDevice },
      body: putNoteForm(3, { baseRevision: note.revision }),
    });
    expect(rejectedWrite.status, await rejectedWrite.clone().text()).toBe(409);
    expect(await rejectedWrite.json()).toMatchObject({
      error: "ALREADY_SUBMITTED",
    });
    app = openApp(true);
    const conflict = await owner(entry, "POST", {
      restartAttemptId: old.id,
      timeLimitMinutes: 5,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: "ATTEMPT_RESTART_STALE",
    });
    expect(
      sql
        .prepare("SELECT status, abandoned_at FROM attempts WHERE id=?")
        .get(old.id),
    ).toEqual({ status: "graded", abandoned_at: null });
    expect(
      sql
        .prepare("SELECT kind FROM attempt_settlements WHERE attempt_id=?")
        .all(old.id),
    ).toEqual([{ kind: "final" }]);
    expect(
      sql
        .prepare(
          "SELECT state, version_id FROM submission_evidence WHERE attempt_id=? AND question_id=?",
        )
        .get(old.id, question.id),
    ).toEqual({ state: "frozen", version_id: note.versionId });
    expect(
      sql
        .prepare(
          "SELECT state, version_id FROM submission_evidence WHERE attempt_id=? AND question_id=?",
        )
        .get(old.id, missingQuestion.id),
    ).toEqual({ state: "missing", version_id: null });
    expect(
      sql
        .prepare("SELECT id FROM note_versions WHERE id=?")
        .get(missingNote.versionId),
    ).toEqual({ id: missingNote.versionId });
    expect(held()).toMatchObject({
      version_id: note.versionId,
      state: "projected",
    });
    expect(
      sql
        .prepare(
          "SELECT receipt_id FROM kernel_question_deliveries WHERE attempt_id=?",
        )
        .get(old.id),
    ).toEqual({ receipt_id: receiptId });
    expect(
      sql
        .prepare("SELECT id FROM note_versions WHERE id=?")
        .get(note.versionId),
    ).toEqual({ id: note.versionId });
    expect(
      sql
        .prepare(
          "SELECT attempt_id FROM kernel_course_openings WHERE student_id=?",
        )
        .all(world.studentId),
    ).toEqual([{ attempt_id: old.id }]);
    for (const role of ["student", "teacher"] as const) {
      expect(await readBytes(role, "document")).toEqual(originalBytes);
      expect(await readBytes(role, image)).toEqual(png);
    }
    const head = await owner(`${path}/evidence/${question.id}`);
    expect(head.status).toBe(200);
    const headBody: unknown = await head.json();
    assertNoLeak(headBody);
    expect(
      z.object({ data: noteHeadDataSchema }).parse(headBody).data,
    ).toMatchObject({
      note: { currentVersionId: note.versionId, revision: note.revision },
      evidence: { state: "frozen", versionId: note.versionId },
    });
    expect((await owner(path)).status).toBe(200);
    const duplicate = await perform(submit);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      error: "ALREADY_SUBMITTED",
    });
    expect(readOld()).toEqual(receipt);
  } finally {
    handle.close();
  }
});

it.each(["首次选择", "空卷后选择"] as const)(
  "课程整卷%s时限生效，跨设备重开并按权威答案完成",
  async (mode) => {
    using data = mkdtempDisposableSync(
      join(tmpdir(), "ownclass-course-timed-"),
    );
    const database = join(data.path, "tutor.db");
    let handle = createDbHandle(database, runMigrations);
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
    try {
      let app = appWith(true);
      const world = await setupCourse(app);
      const secondDevice = await loginAssignmentOwner(app);
      const owner = (path: string, method?: string, body?: object) =>
        request(app, world.ownerCookie, path, method, body);
      const unit = `${world.unitPath}/attempts`;
      const open = async (options: object, cookie = world.ownerCookie) => {
        const response = await request(app, cookie, unit, "POST", options);
        expect(response.status, await response.clone().text()).toBe(201);
        const raw = await response.json();
        assertNoLeak(raw);
        return attemptStartOkSchema.parse(raw).data;
      };
      expect((await owner(world.unitPath)).status).toBe(200);
      expect(secondDevice).not.toBe(world.ownerCookie);
      vi.useFakeTimers({ toFake: ["Date"] });
      const initially = new Date();
      const blank = mode === "空卷后选择" ? await open(whole) : undefined;
      if (blank) {
        expect(blank).toMatchObject({
          activatedAt: null,
          phase: "opened",
          deadlineAt: null,
        });
        app = appWith(false);
        vi.setSystemTime(initially.getTime() + 20_000);
      }
      const selected = new Date();
      const timed = await open({ ...whole, timeLimitMinutes: 5 });
      const deadline = selected.getTime() + 300_000;
      expect(timed).toMatchObject({
        activatedAt: selected.toISOString(),
        phase: "active",
        timeLimitSec: 300,
        deadlineAt: new Date(deadline).toISOString(),
        startedAt: initially.toISOString(),
      });
      if (blank)
        expect(timed).toMatchObject({ id: blank.id, frozenAt: blank.frozenAt });
      const kernelDb = join(data.path, BACKUP_KERNEL_DATABASE);
      const readKernel = () => {
        const runtime = openLearningRuntime({ databasePath: kernelDb });
        try {
          const view = runtime.read(
            { role: "student", id: world.studentId },
            timed.id,
          );
          if (!("questionDeliveries" in view))
            throw new Error("限时整卷缺少内核权威");
          return view;
        } finally {
          runtime.close();
        }
      };
      const tables = () => ({
        opening: handle.db.$client
          .prepare(
            "SELECT attempt_id, step_attempt_id, practice_version FROM kernel_course_openings",
          )
          .all(),
        settlements: handle.db.$client
          .prepare("SELECT kind FROM attempt_settlements WHERE attempt_id=?")
          .all(timed.id),
      });
      expect(existsSync(kernelDb)).toBe(true);
      const initial = readKernel();
      expect(initial).toMatchObject({
        activityId: timed.id,
        startedAt: timed.startedAt,
        questionDeliveryDrafts: [],
      });
      expect(tables()).toEqual({
        opening: [
          {
            attempt_id: timed.id,
            step_attempt_id: initial.stepAttemptId,
            practice_version: 1,
          },
        ],
        settlements: [],
      });
      const path = `/api/student/attempts/${timed.id}`;
      const detail = async (cookie = world.ownerCookie) => {
        const response = await request(app, cookie, path);
        expect(response.status, await response.clone().text()).toBe(200);
        const raw = await response.json();
        assertNoLeak(raw);
        return attemptDraftOkSchema.parse(raw).data;
      };
      const running = await detail();
      expect(running.timing).toMatchObject({
        deadlineAt: timed.deadlineAt,
        phase: "running",
      });
      const [first, second] = running.units.flatMap((item) => item.questions);
      if (!first || !second) throw new Error("整卷需要两道冻结题");
      const questionPath = `/api/teacher/questions/${encodeURIComponent(first.id)}`;
      const question = await request(app, world.teacher, questionPath);
      const {
        data: { sourceMd },
      } = z
        .object({ data: z.object({ sourceMd: z.string() }) })
        .parse(await question.json());
      expect(
        (
          await request(app, world.teacher, questionPath, "PUT", {
            sourceMd: sourceMd.replace("\n", "\n计时开始后改题。"),
          })
        ).status,
      ).toBe(200);
      vi.setSystemTime(selected.getTime() + 30_000);
      expect(
        await open({ ...whole, timeLimitMinutes: 10 }, secondDevice),
      ).toEqual(timed);
      handle.close();
      handle = createDbHandle(database, runMigrations);
      app = appWith(false);
      expect(await open({}, secondDevice)).toEqual(timed);
      expect((await detail(secondDevice)).units).toEqual(running.units);
      expect(readKernel()).toEqual(initial);
      const member = (method: string, studentId: string) =>
        request(app, world.teacher, `${world.course}/members`, method, {
          studentIds: [studentId],
        });
      expect((await member("POST", world.otherStudentId)).status).toBe(200);
      const unbound = await open(
        { ...whole, timeLimitMinutes: 5 },
        world.otherCookie,
      );
      expect(unbound).toMatchObject({ timeLimitSec: 300, phase: "active" });
      expect(tables().opening).toHaveLength(1);
      expect((await request(app, world.otherCookie, path)).status).toBe(403);

      vi.setSystemTime(deadline + 1000);
      expect((await detail()).timing?.phase).toBe("grace");
      const save = {
        answer: { kind: "choice", index: 1 },
        baseRevision: 0,
        mutationId: randomUUID(),
        expectedFrozenAt: timed.frozenAt,
        questionRevisionId: first.questionRevisionId,
      };
      const answerPath = `${path}/answers/${encodeURIComponent(first.id)}`;
      const saved = await owner(answerPath, "PUT", save);
      expect(saved.status, await saved.clone().text()).toBe(200);
      const receipt = await saved.json();
      expect(readKernel().questionDeliveryDrafts).toEqual([
        expect.objectContaining({
          questionId: first.id,
          revision: 1,
          value: "1",
        }),
      ]);
      const hostAnswer = handle.db.$client.prepare(
        "SELECT answer_json FROM responses WHERE attempt_id=? AND question_id=?",
      );
      expect(hostAnswer.get(timed.id, first.id)).toEqual({ answer_json: null });
      const activity = handle.db.$client.prepare(
        "SELECT last_activity_at FROM attempts WHERE id=?",
      );
      const lastActivity = activity.get(timed.id);
      vi.setSystemTime(deadline + (ATTEMPT_TIME_UP_GRACE_SEC + 1) * 1000);
      const locked = await detail(secondDevice);
      expect(locked.timing?.phase).toBe("locked");
      const replay = await request(app, secondDevice, answerPath, "PUT", save);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(receipt);
      const reject = async (
        response: Response,
        status: number,
        error: string,
      ) => {
        expect(response.status, await response.clone().text()).toBe(status);
        expect(await response.json()).toMatchObject({ error });
      };
      const unsaved = {
        ...save,
        answer: { kind: "choice", index: 2 },
        mutationId: randomUUID(),
        questionRevisionId: second.questionRevisionId,
      };
      await reject(
        await owner(
          `${path}/answers/${encodeURIComponent(second.id)}`,
          "PUT",
          unsaved,
        ),
        409,
        "ATTEMPT_TIME_UP",
      );
      expect(activity.get(timed.id)).toEqual(lastActivity);
      const submitPath = `${path}/submit`;
      const submission = {
        revisions: [first, second].map((question) => ({
          questionId: question.id,
          questionRevisionId: question.questionRevisionId,
          expectedAnswerRevision: locked.draftRevisions?.[question.id] ?? 0,
        })),
      };
      await reject(
        await owner(submitPath, "POST", submission),
        409,
        "ATTEMPT_TIME_UP",
      );
      const confirmed = { ...submission, confirmedSavedAnswers: true };
      expect((await member("DELETE", world.studentId)).status).toBe(200);
      expect((await owner(unit, "POST", whole)).status).toBe(403);
      expect((await owner(path)).status).toBe(403);
      expect((await owner(answerPath, "PUT", save)).status).toBe(403);
      expect((await owner(submitPath, "POST", confirmed)).status).toBe(403);
      expect(tables().settlements).toEqual([]);
      expect(readKernel().questionDeliveries).toEqual([]);
      expect((await member("POST", world.studentId)).status).toBe(200);
      const submitted = await request(
        app,
        secondDevice,
        submitPath,
        "POST",
        confirmed,
      );
      expect(submitted.status, await submitted.clone().text()).toBe(200);
      const result = attemptResultOkSchema.parse(await submitted.json()).data;
      expect(result.attempt).toMatchObject({
        id: timed.id,
        frozenAt: timed.frozenAt,
        deadlineAt: timed.deadlineAt,
        scoreAuto: 50,
      });
      expect(
        result.units.flatMap(({ questions }) =>
          questions.map(({ answer, answered }) => ({ answer, answered })),
        ),
      ).toEqual([
        { answer: save.answer, answered: true },
        { answer: null, answered: false },
      ]);
      const finished = readKernel();
      expect(finished.status).toBe("completed");
      expect(finished.questionDeliveries).toHaveLength(1);
      expect(
        handle.db.$client
          .prepare(
            "SELECT receipt_id FROM kernel_question_deliveries WHERE attempt_id=?",
          )
          .all(timed.id),
      ).toEqual([{ receipt_id: finished.questionDeliveries[0]?.receipt?.id }]);
      expect(tables().settlements).toEqual([{ kind: "final" }]);
      await reject(
        await owner(submitPath, "POST", confirmed),
        409,
        "ALREADY_SUBMITTED",
      );
      expect(readKernel()).toEqual(finished);
      expect(tables().settlements).toEqual([{ kind: "final" }]);
    } finally {
      vi.useRealTimers();
      handle.close();
    }
  },
);

it("明确选择逐题的新课程请求沿原策略处理", async () => {
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
