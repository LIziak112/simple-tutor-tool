import { createHash, randomUUID } from "node:crypto";
import { mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ATTEMPT_SNAPSHOT_PROOF_HEADER,
  adminTeacherCreateOkSchema,
  attemptContextOkSchema,
  attemptDraftOkSchema,
  attemptResultOkSchema,
  attemptStartOkSchema,
  BACKUP_KERNEL_DATABASE,
  BACKUP_KERNEL_MANIFEST,
  backupKernelManifestSchema,
  hintOpenOkSchema,
  importCommitDataSchema,
  lessonQuestionSubmitOkSchema,
  lessonStartOkSchema,
  type MarkRequest,
  markResponseDataSchema,
  pendingMarkListDataSchema,
  RESPONSE_BODY_MAX_CHARS,
  RESPONSE_TITLE_MAX_CHARS,
  type SelfReviewRequest,
  type StudentAnswer,
  selfReviewDataSchema,
  studentPaperOkSchema,
  studentRecordsOkSchema,
  teacherAttemptDetailOkSchema,
  teacherInfoOkSchema,
  wrongQuestionsOkSchema,
} from "@tutor/contract";
import { kernelQuestionDeliveryIntentSchema } from "@tutor/contract/kernel-question-delivery";
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
import { purgeOpenedAttempts } from "../services/attempt-opened-purge.ts";
import * as deliveryPublication from "../services/kernel-question-delivery-publication.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { zipToBackupBuffer } from "../test/backup-fixtures.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import { nodePeerBindings } from "../test/node-peer.ts";
import { gzipJson, makeNotePng, putNoteForm } from "../test/note-fixtures.ts";
import {
  createStudent,
  extractSessionToken,
  loginStudent,
} from "../test/note-world.ts";

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

it("混合普通整卷按冻结版本登记判断题已答表现", async () => {
  using data = mkdtempDisposableSync(join(tmpdir(), "m05-mixed-judge-"));
  const instance = openInstance(data.path);
  const databasePath = join(data.path, BACKUP_KERNEL_DATABASE);
  try {
    let app = instance.open(false);
    const world = await setupAssignment(app);
    const values = ["  ", "", false, "  待判  "] as const;
    const ids = ["space", "empty", "false", "raw", "missing"].map(
      (suffix) => `m05-judge-${suffix}`,
    );
    const solution = "混合判断题私有详解哨兵。";
    const {
      units: [unit],
    } = await importQuestions(app, world.teacher, undefined, [
      ...choices.slice(0, 6),
      ...ids.flatMap((id) => [
        `::::question{id=${id} type=judge}`,
        "合成判断。[[错误]]",
        ":::solution",
        solution,
        ":::",
        "::::",
        "",
      ]),
    ]);
    if (!unit) throw new Error("未导入混合判断题");
    const assignment = await assignKernelFixture(
      app,
      { ...world, unitId: unit.id },
      { answerRelease: "after_due", dueAt: "2099-01-01T00:00:00Z" },
    );
    const open = async (cookie: string) => {
      const response = await postAssignment(app, assignment, cookie);
      expect(response.status, await response.clone().text()).toBe(200);
      return attemptStartOkSchema.parse(await response.json()).data;
    };
    const publish = deliveryPublication.questionDeliveryPublication;
    const legacy = vi
      .spyOn(deliveryPublication, "questionDeliveryPublication")
      .mockImplementation((...args) => {
        const { practice, ...rest } = publish(...args);
        delete practice.questionAnswerRules;
        return { ...rest, practice };
      });
    const oldAttempt = await open(world.ownerCookie).finally(() =>
      legacy.mockRestore(),
    );
    const currentAttempt = await open(world.otherCookie);
    expect((await open(world.ownerCookie)).id).toBe(oldAttempt.id);
    const answers: Record<string, StudentAnswer> = {
      "k17-one": { kind: "choice", index: 0 },
      ...Object.fromEntries(
        values.map(
          (value, index) => [ids[index], { kind: "judge", value }] as const,
        ),
      ),
    };
    const saveAndSubmit = async (
      attempt: typeof oldAttempt,
      cookie: string,
    ) => {
      const path = `/api/student/attempts/${attempt.id}`;
      const draft = async () => {
        const response = await jsonCall(app, path, cookie);
        expect(response.status, await response.clone().text()).toBe(200);
        return attemptDraftOkSchema.parse(await response.json()).data;
      };
      const questions = (await draft()).units.flatMap((unit) => unit.questions);
      for (const { id, questionRevisionId } of questions) {
        const answer = answers[id];
        if (answer === undefined) continue;
        const saved = await jsonCall(
          app,
          `${path}/answers/${id}`,
          cookie,
          "PUT",
          {
            answer,
            baseRevision: 0,
            mutationId: randomUUID(),
            expectedFrozenAt: attempt.frozenAt,
            questionRevisionId,
          },
        );
        expect(saved.status, await saved.clone().text()).toBe(200);
      }
      const saved = await draft();
      expect(saved.drafts).toEqual(answers);
      expect(saved.draftRevisions).toEqual(
        Object.fromEntries(
          questions.map(({ id }) => [id, answers[id] ? 1 : 0]),
        ),
      );
      const response = await jsonCall(app, `${path}/submit`, cookie, "POST", {
        revisions: questions.map(({ id, questionRevisionId }) => ({
          questionId: id,
          questionRevisionId,
          expectedAnswerRevision: saved.draftRevisions?.[id] ?? 0,
        })),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const raw = await response.text();
      expect(raw).not.toContain(solution);
      const result: unknown = JSON.parse(raw);
      assertNoLeak(result, {
        allow: ["answer", "answers", "solutionMd"],
        forbid: ["acceptedByQuestion", "questionAnswerRules", "scoringKey"],
      });
      const hidden = attemptResultOkSchema.parse(result).data;
      expect(hidden).toMatchObject({
        answersReleased: false,
        attempt: { scoreAuto: null },
        summary: { scoreFinal: null, pendingCount: null },
      });
      for (const row of hidden.units.flatMap((unit) => unit.questions)) {
        expect(row).toMatchObject({
          answer: answers[row.questionId] ?? null,
          answered: ["k17-one", "m05-judge-false", "m05-judge-raw"].includes(
            row.questionId,
          ),
          answers: null,
          autoCorrect: null,
          finalCorrect: null,
          solutionMd: null,
        });
      }
    };

    await saveAndSubmit(currentAttempt, world.otherCookie);
    await saveAndSubmit(oldAttempt, world.ownerCookie);
    instance.reopen();
    app = instance.open(false);
    const sql = instance.db().$client;
    using kernelDb = new DatabaseSync(databasePath, { readOnly: true });
    const definition = (attemptId: string) =>
      z.object({ version: z.number(), definition: z.string() }).parse(
        kernelDb
          .prepare(`SELECT p.version, p.definition FROM practices p JOIN activities a
            ON p.id=a.practice_id AND p.version=a.practice_version WHERE a.id=?`)
          .get(attemptId),
      );
    const facts = (attemptId: string, studentId: string) => {
      const ticket = keyRow.extend({ receipt_id: z.string().min(1) }).parse(
        sql
          .prepare(`SELECT operation_id, step_attempt_id, slot_id, receipt_id
            FROM kernel_question_deliveries WHERE attempt_id=?`)
          .get(attemptId),
      );
      expect(
        sql
          .prepare(`SELECT count(*) n FROM attempt_settlements
          WHERE attempt_id=? AND kind='final'`)
          .get(attemptId),
      ).toEqual({ n: 1 });
      expect(
        kernelDb
          .prepare("SELECT id FROM submissions WHERE step_attempt_id=?")
          .all(ticket.step_attempt_id),
      ).toEqual([{ id: ticket.receipt_id }]);
      const runtime = openLearningRuntime({
        databasePath,
        authorizeConfirmationRecovery: (identity) =>
          identity.studentId === studentId &&
          identity.activityId === attemptId &&
          identity.stepAttemptId === ticket.step_attempt_id &&
          identity.operationId === ticket.operation_id,
      });
      try {
        const recovered = runtime.recoverQuestionDelivery(
          { role: "student", id: studentId },
          attemptId,
          {
            protocolVersion: 1,
            operationId: ticket.operation_id,
            stepAttemptId: ticket.step_attempt_id,
          },
        );
        expect(recovered.receipt.id).toBe(ticket.receipt_id);
        expect(recovered.confirmation.questions).toMatchObject([
          { questionId: "k17-one", value: "0", revision: 1 },
          ...ids.map((questionId, index) => ({
            questionId,
            value: values[index] ?? null,
            revision: index < values.length ? 1 : 0,
          })),
        ]);
        const performed = kernelDb
          .prepare(
            "SELECT unit_id FROM performances WHERE submission_id=? ORDER BY unit_id",
          )
          .all(ticket.receipt_id);
        return { performed, verdicts: recovered.evaluation.questions };
      } finally {
        runtime.close();
      }
    };
    const current = facts(currentAttempt.id, world.otherStudentId);
    expect(current.performed).toEqual(
      ["k17-one", "m05-judge-false", "m05-judge-raw"].map((id) => ({
        unit_id: `question:${id}`,
      })),
    );
    const old = facts(oldAttempt.id, world.studentId);
    expect(old.performed).toEqual(
      ["k17-one", ...ids.slice(0, -1).sort()].map((id) => ({
        unit_id: `question:${id}`,
      })),
    );
    expect(current.verdicts).toEqual(old.verdicts);
    const oldDefinition = definition(oldAttempt.id);
    expect(oldDefinition.version).toBe(1);
    expect(JSON.parse(oldDefinition.definition)).not.toHaveProperty(
      "questionAnswerRules",
    );
    const currentDefinition = definition(currentAttempt.id);
    expect(currentDefinition.version).toBe(2);
    expect(JSON.parse(currentDefinition.definition)).toHaveProperty(
      "questionAnswerRules",
      Object.fromEntries(
        ids.map((id) => [id, { id: "ownclass-judge-value", version: 1 }]),
      ),
    );
    const denied = await jsonCall(
      app,
      `/api/student/attempts/${currentAttempt.id}`,
      world.ownerCookie,
    );
    expect(denied.status).toBe(403);
  } finally {
    instance.close();
  }
});

it("普通整卷只下发已解锁提示，迟到交付不改变封存活动", async () => {
  using data = mkdtempDisposableSync(join(tmpdir(), "m05-hint-host-"));
  const instance = openInstance(data.path);
  try {
    const app = instance.open(false);
    const world = await setupAssignment(app);
    const questionId = "m05-two-hints";
    const stem = "指出计算错误。";
    const first = "先检查乘法。";
    const second = "再检查符号。";
    const {
      units: [unit],
    } = await importQuestions(app, world.teacher, undefined, [
      `::::question{id=${questionId} type=find-error}`,
      stem,
      ":::hint",
      first,
      ":::",
      ":::hint",
      second,
      ":::",
      ":::answer",
      "改正第一步。",
      ":::",
      "::::",
    ]);
    if (!unit) throw new Error("未导入带提示题");
    const assignment = await assignKernelFixture(app, {
      ...world,
      unitId: unit.id,
    });
    const opened = await postAssignment(app, assignment, world.ownerCookie);
    expect(opened.status, await opened.clone().text()).toBe(200);
    const attempt = attemptStartOkSchema.parse(await opened.json()).data;
    const path = `/api/student/attempts/${attempt.id}`;
    const owner = world.ownerCookie;
    const requestHint = (index: number) =>
      jsonCall(app, `${path}/hints`, owner, "POST", {
        questionId,
        index,
        expectedFrozenAt: attempt.frozenAt,
      });
    const readWithoutHints = async (suffix: string, locks: string[]) => {
      const response = await jsonCall(app, path + suffix, owner);
      const raw = await response.text();
      expect(response.status, raw).toBe(200);
      for (const locked of locks) expect(raw).not.toContain(locked);
      return JSON.parse(raw) as unknown;
    };
    const paper = studentPaperOkSchema.parse(
      await readWithoutHints("/paper", [first, second]),
    ).data;
    const [question] = paper.units.flatMap(({ questions }) => questions);
    expect(question).toMatchObject({ id: questionId, hintCount: 2 });
    const questionRevisionId = question?.questionRevisionId;
    expect(questionRevisionId).toEqual(expect.any(String));
    expect(
      attemptDraftOkSchema.parse(await readWithoutHints("", [first, second]))
        .data.hintsOpened,
    ).toEqual({});
    const readActivity = () => {
      const runtime = openLearningRuntime({
        databasePath: join(data.path, BACKUP_KERNEL_DATABASE),
      });
      try {
        return runtime.read(
          { role: "student", id: world.studentId },
          attempt.id,
        );
      } finally {
        runtime.close();
      }
    };
    const activity = readActivity();
    if (!("questionDeliveries" in activity))
      throw new Error("应走 K18 整卷交付");
    expect(activity.inputs.questions).toMatchObject({
      from: "questions",
      questions: [{ id: questionId, prompt: stem }],
    });
    expect(JSON.stringify(activity)).not.toContain(first);
    expect(JSON.stringify(activity)).not.toContain(second);

    const hint = await requestHint(1);
    const hintRaw = await hint.text();
    expect(hint.status, hintRaw).toBe(200);
    expect(hintRaw).not.toContain(first);
    expect(hintOpenOkSchema.parse(JSON.parse(hintRaw)).data).toEqual({
      questionId,
      index: 1,
      hint: second,
      hintCount: 2,
      hintsUsed: 1,
      hintsRemaining: 1,
    });
    expect(
      attemptDraftOkSchema.parse(await readWithoutHints("", [first])).data
        .hintsOpened,
    ).toEqual({ [questionId]: [{ index: 1, text: second }] });

    const submitted = await jsonCall(app, `${path}/submit`, owner, "POST", {
      revisions: [
        {
          questionId,
          questionRevisionId,
          expectedAnswerRevision: 0,
        },
      ],
      evidence: [{ questionId, state: "none" }],
    });
    const submittedBody = await submitted.text();
    expect(submitted.status, submittedBody).toBe(200);
    expect(submittedBody).not.toContain(first);
    const result = attemptResultOkSchema.parse(JSON.parse(submittedBody)).data;
    expect(
      result.units.flatMap(({ questions }) => questions)[0]?.hintsOpened,
    ).toEqual([{ index: 1, text: second }]);
    const sealed = readActivity();
    expect(sealed).toMatchObject({
      status: "completed",
      questionDeliveries: [{ receipt: { id: expect.any(String) } }],
    });
    const sql = instance.db().$client;
    const activityTimes = () =>
      sql
        .prepare(
          "SELECT status, activated_at, last_activity_at, submitted_at FROM attempts WHERE id=?",
        )
        .get(attempt.id);
    const timesBefore = activityTimes();
    const activityLedger = () =>
      sql
        .prepare("SELECT * FROM response_time_ledger WHERE attempt_id=?")
        .all(attempt.id);
    const settlements = () =>
      sql
        .prepare("SELECT * FROM attempt_settlements WHERE attempt_id=?")
        .all(attempt.id);
    const ledgerBefore = activityLedger();
    expect(ledgerBefore).toHaveLength(1);
    const settlementsBefore = settlements();
    expect(settlementsBefore).toMatchObject([{ kind: "final" }]);
    const lateHint = await requestHint(0);
    expect(lateHint.status, await lateHint.clone().text()).toBe(200);
    expect(hintOpenOkSchema.parse(await lateHint.json()).data).toMatchObject({
      hint: first,
      hintsUsed: 2,
      hintsRemaining: 0,
    });
    const lateAnswer = await jsonCall(
      app,
      `${path}/answers/${questionId}`,
      owner,
      "PUT",
      {
        questionRevisionId,
        expectedFrozenAt: attempt.frozenAt,
        baseRevision: 0,
        mutationId: randomUUID(),
        answer: { kind: "final", finalAnswer: "迟到答案" },
      },
    );
    expect(lateAnswer.status, await lateAnswer.clone().text()).toBe(409);
    expect(await lateAnswer.json()).toMatchObject({
      error: "ALREADY_SUBMITTED",
    });
    expect(activityTimes()).toEqual(timesBefore);
    expect(readActivity()).toEqual(sealed);
    expect(activityLedger()).toEqual(ledgerBefore);
    expect(settlements()).toEqual(settlementsBefore);
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
      let app = instance.open(false);
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
      const wrongCards = async (query = "", cookie = world.ownerCookie) => {
        const res = await jsonCall(
          app,
          `/api/student/wrong-questions${query}`,
          cookie,
        );
        expect(res.status, await res.clone().text()).toBe(200);
        const body: unknown = await res.json();
        assertNoLeak(body, {
          allow: ["answers", "solutionMd"],
          forbid: [
            "operationId",
            "responseId",
            "teacherComment",
            "teacherMark",
          ],
        });
        return wrongQuestionsOkSchema.parse(body).data.questions;
      };
      const draft = async () =>
        attemptDraftOkSchema.parse(
          await (await jsonCall(app, path, world.ownerCookie)).json(),
        ).data;
      const initial = await draft();
      const rawResponse = z
        .object({ id: z.uuid() })
        .parse(
          instance
            .db()
            .$client.prepare(
              "SELECT id FROM responses WHERE attempt_id=? AND question_id='k18-extra'",
            )
            .get(attempt.id),
        );
      const draftMark = await jsonCall(
        app,
        "/api/teacher/responses/" + rawResponse.id + "/mark",
        world.teacher,
        "POST",
        { mark: "wrong", comment: null },
      );
      expect(draftMark.status).toBe(409);
      expect(await draftMark.json()).toMatchObject({ error: "NOT_SUBMITTED" });
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
      expect(await wrongCards("?includeResolved=true")).toEqual([]);
      const reviewPath = path + "/questions/k18-extra/self-review";
      const review = (body: SelfReviewRequest, cookie = world.ownerCookie) =>
        jsonCall(app, reviewPath, cookie, "POST", body);
      const correct: SelfReviewRequest = {
        verdict: "correct",
        baseRevision: 0,
        mutationId: randomUUID(),
      };
      if (selfReview) {
        const withheldReview = await review(correct);
        expect(withheldReview.status).toBe(403);
        const body: unknown = await withheldReview.json();
        expect(body).toMatchObject({ error: "SELF_REVIEW_NOT_RELEASED" });
        assertNoLeak(body);
      }
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
      if (selfReview) {
        const denied = await review(correct, world.otherCookie);
        expect(denied.status).toBe(403);
        assertNoLeak(await denied.json());

        const receipt = async (request: SelfReviewRequest) => {
          const saved = await review(request);
          expect(saved.status, await saved.clone().text()).toBe(200);
          return wire(selfReviewDataSchema).parse(await saved.json()).data;
        };
        for (const [baseRevision, verdict] of (
          ["correct", "wrong", "undecided"] as const
        ).entries()) {
          const request =
            baseRevision === 0
              ? correct
              : { verdict, baseRevision, mutationId: randomUUID() };
          const saved = await receipt(request);
          const reread = await finishedResult(app, path, world.ownerCookie);
          expect(saved.summary).toEqual(reread.summary);
          expect(saved.summary.scoreFinal).toBe(result.summary.scoreFinal);
          expect(
            reread.units
              .flatMap((group) => group.questions)
              .find((question) => question.questionId === "k18-extra")
              ?.selfReview,
          ).toEqual({ record: saved.selfReview, revision: baseRevision + 1 });
          expect(saved.effective).toEqual(
            verdict === "undecided"
              ? null
              : { source: "self", value: verdict === "correct" },
          );
          const cards = await wrongCards("?includeResolved=true");
          if (verdict === "wrong") {
            expect(cards).toEqual([
              expect.objectContaining({
                questionId: "k18-extra",
                rounds: [expect.objectContaining({ reviewSource: "self" })],
              }),
            ]);
          } else {
            expect(cards).toEqual([]);
          }
          expect(await receipt(request)).toEqual(saved);
        }
        const stale = await review({ ...correct, mutationId: randomUUID() });
        expect(stale.status).toBe(409);
        expect(await stale.json()).toMatchObject({
          error: "SELF_REVIEW_REVISION_CONFLICT",
          _current: { selfReview: null, revision: 3 },
        });

        const db = instance.db().$client;
        const readReview = () =>
          db
            .prepare(
              "SELECT self_review_verdict, self_review_at, self_review_revision, self_review_mutation_id FROM responses WHERE attempt_id=? AND question_id='k18-extra'",
            )
            .get(attempt.id);
        const originalReview = readReview();
        const ticket = z
          .object({ receipt_id: z.string() })
          .parse(
            db
              .prepare(
                "SELECT receipt_id FROM kernel_question_deliveries WHERE attempt_id=?",
              )
              .get(attempt.id),
          );
        const replaceReceipt = db.prepare(
          "UPDATE kernel_question_deliveries SET receipt_id=? WHERE attempt_id=?",
        );
        replaceReceipt.run(randomUUID(), attempt.id);
        try {
          const unmatched = new URLSearchParams({ knowledge: "不相干的考点" });
          expect(await wrongCards(`?${unmatched}`)).toEqual([]);
          const unavailable = await review({
            verdict: "correct",
            baseRevision: 3,
            mutationId: randomUUID(),
          });
          expect(unavailable.status).toBe(503);
          const body: unknown = await unavailable.json();
          expect(body).toMatchObject({ error: "KERNEL_ATTEMPT_UNAVAILABLE" });
          assertNoLeak(body);
          expect(readReview()).toEqual(originalReview);
        } finally {
          replaceReceipt.run(ticket.receipt_id, attempt.id);
        }
      }
      const markQuestion = teacherView.questions.find(
        ({ questionId }) =>
          questionId === (selfReview ? "k17-one" : "k18-extra"),
      );
      if (!markQuestion?.responseId)
        throw new Error("未取得正式作答的批改定位");
      const responseId = markQuestion.responseId;
      const markPath = "/api/teacher/responses/" + responseId + "/mark";
      const markResponse = async (request: MarkRequest) => {
        const res = await jsonCall(
          app,
          markPath,
          world.teacher,
          "POST",
          request,
        );
        expect(res.status, await res.clone().text()).toBe(200);
        return wire(markResponseDataSchema).parse(await res.json()).data;
      };
      const oldBody = {
        mark: selfReview ? "wrong" : "correct",
        comment: "合成评语",
      } as const;
      const marked = await markResponse(oldBody);
      expect(marked.eventId).toBeDefined();
      expect(marked).toMatchObject({
        revision: 1,
        teacherMark: oldBody.mark,
        teacherComment: oldBody.comment,
        finalCorrect: !selfReview,
        scoreFinal: selfReview ? 0 : null,
        pendingCount: selfReview ? 0 : 3,
      });
      expect(await markResponse(oldBody)).toEqual(marked);
      if (selfReview) {
        const expectedCard = {
          questionId: "k17-one",
          answerText: "A",
          wrongCount: 1,
          correctCount: 0,
          rounds: [
            expect.objectContaining({
              attemptId: attempt.id,
              answered: true,
              correct: false,
              reviewSource: "teacher",
            }),
          ],
        };
        expect(await wrongCards()).toEqual([
          expect.objectContaining(expectedCard),
        ]);
        expect(await wrongCards("?includeResolved=true")).toEqual([
          expect.objectContaining(expectedCard),
        ]);
        expect(
          await wrongCards("?includeResolved=true", world.otherCookie),
        ).toEqual([]);
        const release = async (answerRelease: "after_due" | "on_submit") => {
          const res = await jsonCall(
            app,
            `/api/teacher/assignments/${assignment}`,
            world.teacher,
            "PATCH",
            { answerRelease },
          );
          expect(res.status, await res.clone().text()).toBe(200);
        };
        await release("after_due");
        expect(await wrongCards("?includeResolved=true")).toEqual([]);
        const withheld = await finishedResult(app, path, world.ownerCookie);
        expect(withheld.answersReleased).toBe(false);
        expect(
          withheld.units
            .flatMap((group) => group.questions)
            .find(({ questionId }) => questionId === "k17-one"),
        ).toMatchObject({
          answer: { kind: "choice", index: 0 },
          answers: null,
          finalCorrect: null,
          teacherMark: null,
          teacherComment: null,
        });
        await release("on_submit");
        expect(await wrongCards()).toEqual([
          expect.objectContaining(expectedCard),
        ]);
      }
      const staleMark = await jsonCall(app, markPath, world.teacher, "POST", {
        mark: null,
        comment: null,
        mutationId: randomUUID(),
        baseRevision: 0,
      });
      expect(staleMark.status).toBe(409);
      expect(await staleMark.json()).toMatchObject({
        error: "VERDICT_CONFLICT",
      });

      const clear = {
        mark: null,
        comment: null,
        baseRevision: 1,
        mutationId: randomUUID(),
      };
      if (selfReview) {
        const db = instance.db().$client;
        db.exec(
          "CREATE TEMP TRIGGER stop_mark_projection BEFORE UPDATE OF result_json ON kernel_response_marks BEGIN SELECT RAISE(ABORT, '中断批改回执'); END",
        );
        const cut = await jsonCall(app, markPath, world.teacher, "POST", clear);
        expect(cut.status).toBe(500);
        expect(
          db
            .prepare(
              "SELECT result_json FROM kernel_response_marks WHERE operation_id=?",
            )
            .get(clear.mutationId),
        ).toEqual({ result_json: null });
        expect(
          db
            .prepare("SELECT teacher_comment FROM responses WHERE id=?")
            .get(responseId),
        ).toEqual({ teacher_comment: oldBody.comment });
        const acceptedEvent = () => {
          using kernel = new DatabaseSync(
            join(data.path, "learning-kernel.sqlite"),
            { readOnly: true },
          );
          return kernel
            .prepare("SELECT id FROM verdict_events WHERE operation_id=?")
            .all(clear.mutationId);
        };
        const [accepted] = acceptedEvent();
        expect(accepted).toBeDefined();
        instance.reopen();
        app = instance.open(false);
        const operator = teacherInfoOkSchema.parse(
          await (await jsonCall(app, "/api/teacher/me", world.teacher)).json(),
        ).data.id;
        app = instance.open(false, operator);
        const backup = await jsonCall(
          app,
          "/api/teacher/backup/download",
          world.teacher,
        );
        expect(backup.status, await backup.clone().text()).toBe(200);
        const restoreForm = new FormData();
        restoreForm.set(
          "zip",
          new File(
            [new Uint8Array(await backup.arrayBuffer())],
            "批改中断截面.zip",
            {
              type: "application/zip",
            },
          ),
        );
        restoreForm.set("password", "teacher-pass-8");
        const restored = await app.request("/api/teacher/backup/restore", {
          method: "POST",
          headers: { cookie: world.teacher },
          body: restoreForm,
        });
        expect(restored.status, await restored.clone().text()).toBe(200);
        expect(
          instance
            .db()
            .$client.prepare(
              "SELECT result_json FROM kernel_response_marks WHERE operation_id=?",
            )
            .get(clear.mutationId),
        ).toEqual({ result_json: null });
        const disableReviewer = instance
          .db()
          .$client.prepare("UPDATE teachers SET disabled_at=? WHERE id=?");
        disableReviewer.run(new Date().toISOString(), operator);
        try {
          const recovered = await finishedResult(app, path, world.ownerCookie);
          expect(recovered.summary).toEqual(result.summary);
        } finally {
          disableReviewer.run(null, operator);
        }
        const replayed = await markResponse(clear);
        expect(replayed.eventId).toBe(accepted?.id);
        expect(acceptedEvent()).toEqual([accepted]);
      }
      const cleared = await markResponse(clear);
      expect(cleared.eventId).toBeDefined();
      expect(cleared).toMatchObject({
        revision: 2,
        teacherMark: null,
        teacherComment: null,
        finalCorrect: selfReview ? true : null,
        scoreFinal: result.summary.scoreFinal,
        pendingCount: result.summary.pendingCount,
      });
      expect(await markResponse(clear)).toEqual(cleared);
      if (selfReview) {
        expect(await wrongCards()).toEqual([]);
        expect(await wrongCards("?includeResolved=true")).toEqual([]);
      }
      const reused = await jsonCall(app, markPath, world.teacher, "POST", {
        ...clear,
        comment: "异内容重用",
      });
      expect(reused.status).toBe(409);
      expect(await reused.json()).toMatchObject({
        error: "OPERATION_CONFLICT",
      });
      expect(
        (await finishedResult(app, path, world.ownerCookie)).summary,
      ).toEqual(result.summary);
      const abandon = instance
        .db()
        .$client.prepare("UPDATE attempts SET abandoned_at=? WHERE id=?");
      abandon.run(new Date().toISOString(), attempt.id);
      try {
        const blocked = await jsonCall(
          app,
          markPath,
          world.teacher,
          "POST",
          oldBody,
        );
        expect(blocked.status).toBe(409);
        expect(await blocked.json()).toMatchObject({
          error: "ATTEMPT_ABANDONED",
        });
      } finally {
        abandon.run(null, attempt.id);
      }
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

const lessonMaterialQuestions = (version: number) => [
  "开课讲解正文。",
  "",
  "::::material{id=lesson-material-one}",
  "合成讲练材料甲 V1",
  "::::",
  "",
  "::::material{id=lesson-material-two}",
  `合成讲练材料乙 V${version}`,
  "::::",
  "",
  "::::material{id=lesson-material-unused}",
  "未引用合成材料",
  "::::",
  "",
  "::::group{id=lesson-material-group}",
  "::ref{material=lesson-material-one}",
  "::ref{question=lesson-material-choice}",
  "::ref{question=lesson-material-judge}",
  "::::",
  "",
  "::::question{id=lesson-material-choice type=choice}",
  "第一道合成材料题。 ::ref{material=lesson-material-two}",
  "",
  "- [x] 第一项",
  "- [ ] 第二项",
  "",
  ":::solution",
  "合成单选解析",
  ":::",
  "::::",
  "",
  "题间讲解正文。",
  "",
  "::::question{id=lesson-material-judge type=judge}",
  "相邻合成判断题。[[正确]]",
  "",
  ":::solution",
  "相邻合成判断解析",
  ":::",
  "::::",
  "",
  "讲解结尾正文。",
];

it("材料讲练由正式学生入口绑定逐题交付并冻结材料位置", async () => {
  vi.stubEnv("NEW_CONTENT_ENABLED", "true");
  using data = mkdtempDisposableSync(join(tmpdir(), "k23-lesson-material-"));
  const instance = openInstance(data.path);
  try {
    let app = instance.open(true);
    const world = await setupAssignment(app);
    const teacher = teacherInfoOkSchema.parse(
      await (await jsonCall(app, "/api/teacher/me", world.teacher)).json(),
    ).data;
    app = instance.open(true, teacher.id);
    const owner = world.ownerCookie;
    const studentCall = (path: string, method = "GET", body?: object) =>
      jsonCall(app, path, owner, method, body);
    const course = wire(z.object({ id: z.uuid() })).parse(
      await (
        await jsonCall(app, "/api/teacher/courses", world.teacher, "POST", {
          title: "合成材料讲练班",
        })
      ).json(),
    ).data;
    expect(
      (
        await jsonCall(
          app,
          `/api/teacher/courses/${course.id}/members`,
          world.teacher,
          "POST",
          { studentIds: [world.studentId] },
        )
      ).status,
    ).toBe(200);
    const importLesson = async (version: number) => {
      const {
        lectures: [lecture],
      } = await importQuestions(
        app,
        world.teacher,
        course.id,
        lessonMaterialQuestions(version),
      );
      if (!lecture) throw new Error("未生成讲练");
      return lecture.id;
    };
    const lectureId = await importLesson(1);
    const lesson = `/api/student/lectures/${lectureId}/lesson`;
    const start = () =>
      studentCall(`${lesson}/start?courseId=${course.id}`, "POST");
    const startView = async () => {
      const response = await start();
      expect(response.status, await response.clone().text()).toBe(200);
      return lessonStartOkSchema.parse(await response.json()).data;
    };
    const response = await start();
    expect(response.status, await response.clone().text()).toBe(200);
    const raw = await response.json();
    assertNoLeak(raw);
    expect(JSON.stringify(raw)).not.toMatch(
      /\[\[正确\]\]|合成单选解析|相邻合成判断解析|未引用合成材料|\[x\]/,
    );
    const view = lessonStartOkSchema.parse(raw).data;
    const id = view.attempt.id;
    const root = (attemptId: string) => `/api/student/attempts/${attemptId}`;
    const path = root(id);
    const frozenContext = async (attemptId: string) => {
      const result = await studentCall(`${root(attemptId)}/context`);
      expect(result.status, await result.clone().text()).toBe(200);
      const body = await result.json();
      assertNoLeak(body);
      return attemptContextOkSchema.parse(body).data;
    };
    const oldContext = await frozenContext(id);
    const binding = (attemptId: string) =>
      z
        .object({
          practice_id: z.string(),
          practice_version: z.number(),
          step_attempt_id: z.uuid(),
        })
        .parse(
          instance
            .db()
            .$client.prepare(
              "SELECT practice_id,practice_version,step_attempt_id FROM kernel_lesson_openings WHERE attempt_id=?",
            )
            .get(attemptId),
        );
    expect(binding(id).practice_version).toBe(1);
    const [choice, judge] = view.questions;
    if (!choice || !judge) throw new Error("缺少合成题目");
    expect(view.blocks).toEqual([
      { type: "md", md: expect.stringContaining("开课讲解正文。") },
      { type: "question", questionId: choice.id },
      { type: "md", md: "题间讲解正文。" },
      { type: "question", questionId: judge.id },
      { type: "md", md: "讲解结尾正文。" },
    ]);
    expect(choice.materialRefs).toEqual([{ material: "lesson-material-two" }]);
    expect(oldContext).toMatchObject({
      freezeState: "frozen",
      groups: [
        {
          id: "lesson-material-group",
          materialRefs: [{ material: "lesson-material-one" }],
          questionIds: [choice.id, judge.id],
        },
      ],
    });
    expect(
      (await jsonCall(app, `${path}/context`, world.otherCookie)).status,
    ).toBe(403);
    const changeCourseMembership = (method: "POST" | "DELETE") =>
      jsonCall(
        app,
        `/api/teacher/courses/${course.id}/members`,
        world.teacher,
        method,
        { studentIds: [world.studentId] },
      );
    expect((await changeCourseMembership("DELETE")).status).toBe(200);
    expect((await studentCall(`${path}/context`)).status).toBe(403);
    expect((await changeCourseMembership("POST")).status).toBe(200);

    const actor = { role: "student", id: world.studentId } as const;
    const kernelDb = join(data.path, BACKUP_KERNEL_DATABASE);
    const kernelMaterials = (attemptId: string) => {
      const runtime = openLearningRuntime({ databasePath: kernelDb });
      try {
        const activity = runtime.read(actor, attemptId);
        expect(activity).toMatchObject({
          stepAttemptId: binding(attemptId).step_attempt_id,
          step: {
            submit: {
              slots: {
                answers: {
                  delivery: {
                    mode: "perQuestion",
                    questionSlots: {
                      [choice.id]: "question-1",
                      [judge.id]: "question-2",
                    },
                  },
                },
              },
            },
          },
        });
        expect(JSON.stringify(activity)).not.toMatch(
          /acceptedChoice|acceptedResponse|acceptedByQuestion|scoringKey|合成单选解析|相邻合成判断解析|未引用合成材料|\[\[正确\]\]/,
        );
        if (!("inputs" in activity)) throw new Error("缺少内核冻结输入");
        return Object.entries(activity.inputs)
          .flatMap(([key, input]) => {
            if (input.from !== "material" || !input.material) return [];
            expect(input.positionId).toBe(key);
            return [{ ...input.material, positionId: input.positionId }];
          })
          .sort((a, b) => a.source.localeCompare(b.source));
      } finally {
        runtime.close();
      }
    };
    const versionsOf = (context: Awaited<ReturnType<typeof frozenContext>>) =>
      context.materials.map(({ id, sourceVersion, contentMd }) => [
        id,
        sourceVersion,
        contentMd,
      ]);
    const expected = (version: number) => [
      ["lesson-material-one", 1, "合成讲练材料甲 V1"],
      ["lesson-material-two", version, `合成讲练材料乙 V${version}`],
    ];
    const oldPositions = kernelMaterials(id);
    expect(versionsOf(oldContext)).toEqual(expected(1));
    expect(
      oldPositions.map(({ source, version, paragraphs }) => [
        source,
        version,
        paragraphs[0]?.text,
      ]),
    ).toEqual(versionsOf(oldContext));
    expect(new Set(oldPositions.map(({ positionId }) => positionId)).size).toBe(
      2,
    );

    const neighborAnswer = { kind: "judge", value: false } as const;
    for (const [question, answer] of [
      [choice, { kind: "choice", index: 0 }],
      [judge, neighborAnswer],
    ] as const) {
      const save = await studentCall(`${path}/answers/${question.id}`, "PUT", {
        answer,
        baseRevision: 0,
        mutationId: randomUUID(),
        questionRevisionId: question.questionRevisionId,
        expectedFrozenAt: view.attempt.frozenAt,
      });
      expect(save.status, await save.clone().text()).toBe(200);
    }
    const confirmChoice = await studentCall(
      `${path}/questions/${choice.id}/submit`,
      "POST",
      {
        questionRevisionId: choice.questionRevisionId,
        expectedAnswerRevision: 1,
        evidence: { questionId: choice.id, state: "none" },
      },
    );
    expect(confirmChoice.status, await confirmChoice.clone().text()).toBe(200);
    const feedback = await confirmChoice.json();
    expect(JSON.stringify(feedback)).not.toMatch(
      /相邻合成判断题|相邻合成判断解析|lesson-material-judge|\[\[正确\]\]|acceptedResponse|scoringKey/,
    );
    expect(lessonQuestionSubmitOkSchema.parse(feedback).data).toMatchObject({
      attempt: { status: "draft" },
      question: {
        questionId: choice.id,
        autoCorrect: true,
        solutionMd: "合成单选解析",
      },
    });
    const tickets = () =>
      instance
        .db()
        .$client.prepare(
          "SELECT operation_id,step_attempt_id,slot_id,receipt_id,intent_json FROM kernel_question_deliveries WHERE attempt_id=? ORDER BY slot_id",
        )
        .all(id);
    const [choiceTicket] = tickets();
    expect(choiceTicket).toMatchObject({
      slot_id: "question-1",
      receipt_id: expect.any(String),
    });

    expect(await importLesson(2)).toBe(lectureId);
    expect(await frozenContext(id)).toEqual(oldContext);
    expect(kernelMaterials(id)).toEqual(oldPositions);
    const resumed = await startView();
    expect(resumed.blocks).toEqual(view.blocks);
    expect(Object.keys(resumed.released)).toEqual([choice.id]);
    expect(resumed.drafts[judge.id]).toEqual(neighborAnswer);
    expect(resumed.draftRevisions?.[judge.id]).toBe(1);
    expect(JSON.stringify(resumed)).not.toContain("相邻合成判断解析");

    const finish = () =>
      studentCall(`${path}/submit`, "POST", {
        revisions: resumed.questions.map(({ id, questionRevisionId }) => ({
          questionId: id,
          questionRevisionId,
          expectedAnswerRevision: resumed.draftRevisions?.[id] ?? 0,
        })),
        evidence: [{ questionId: judge.id, state: "none" }],
      });
    const finished = await finish();
    expect(finished.status, await finished.clone().text()).toBe(200);
    const final = await finishedResult(app, path, owner);
    expect(final.summary).toMatchObject({ answered: 2, scoreFinal: 50 });
    expect(final.units.flatMap(({ questions }) => questions)).toMatchObject([
      { questionId: choice.id, autoCorrect: true },
      { questionId: judge.id, autoCorrect: false, answer: neighborAnswer },
    ]);
    expect((await finish()).status).toBe(409);
    const originalTickets = tickets();
    expect(originalTickets).toHaveLength(2);
    expect(originalTickets).toContainEqual(choiceTicket);
    const settlements = () =>
      instance
        .db()
        .$client.prepare(
          "SELECT id,seq,question_count FROM attempt_settlements WHERE attempt_id=? AND kind='final'",
        )
        .all(id);
    const originalSettlements = settlements();
    expect(originalSettlements).toMatchObject([{ seq: 1, question_count: 2 }]);

    const restartRequest = { expectedAttemptId: id, operationId: randomUUID() };
    const restart = () =>
      studentCall(`${lesson}/restart`, "POST", restartRequest);
    instance
      .db()
      .$client.exec(
        "CREATE TEMP TRIGGER interrupt_material_lesson BEFORE INSERT ON attempt_context_snapshots " +
          "BEGIN SELECT RAISE(ABORT,'中断讲练材料投影'); END",
      );
    expect((await restart()).status).toBe(500);
    const pending = z
      .object({
        operation_id: z.string(),
        practice_id: z.string(),
        practice_version: z.number(),
        attempt_id: z.null(),
        draft_json: z.string(),
      })
      .parse(
        instance
          .db()
          .$client.prepare(
            "SELECT operation_id,practice_id,practice_version,attempt_id,draft_json FROM kernel_lesson_openings WHERE lecture_id=? AND attempt_no=2",
          )
          .get(lectureId),
      );
    let preparedId: string;
    const runtime = openLearningRuntime({ databasePath: kernelDb });
    try {
      const receipt = runtime.prepare(actor, {
        protocolVersion: 1,
        operationId: pending.operation_id,
        practiceId: pending.practice_id,
        practiceVersion: pending.practice_version,
      });
      preparedId = receipt.activityId;
    } finally {
      runtime.close();
    }
    expect(
      instance
        .db()
        .$client.prepare("SELECT id FROM attempts WHERE id=?")
        .get(preparedId),
    ).toBeUndefined();

    instance.reopen();
    app = instance.open(false, teacher.id);
    instance
      .db()
      .$client.prepare(
        "UPDATE kernel_lesson_openings SET draft_json=json_set(draft_json,'$.context[1].snapshot.contentMd','待恢复材料错配') WHERE operation_id=?",
      )
      .run(pending.operation_id);
    expect((await restart()).status).toBe(503);
    expect(
      instance
        .db()
        .$client.prepare("SELECT id FROM attempts WHERE id=?")
        .get(preparedId),
    ).toBeUndefined();
    expect(tickets()).toEqual(originalTickets);
    instance
      .db()
      .$client.prepare(
        "UPDATE kernel_lesson_openings SET draft_json=? WHERE operation_id=?",
      )
      .run(pending.draft_json, pending.operation_id);

    const next = await restart();
    expect(next.status, await next.clone().text()).toBe(201);
    const nextView = lessonStartOkSchema.parse(await next.json()).data;
    expect(nextView.attempt).toMatchObject({
      id: preparedId,
      attemptNo: 2,
      status: "draft",
    });
    expect(nextView.drafts).toEqual({});
    expect((await startView()).attempt.id).toBe(preparedId);
    expect(versionsOf(await frozenContext(preparedId))).toEqual(expected(2));
    expect(kernelMaterials(preparedId)).toEqual([
      oldPositions[0],
      {
        ...oldPositions[1],
        version: 2,
        paragraphs: [{ id: "content", text: "合成讲练材料乙 V2" }],
      },
    ]);
    expect(await frozenContext(id)).toEqual(oldContext);
    expect(kernelMaterials(id)).toEqual(oldPositions);
    expect(await finishedResult(app, path, owner)).toEqual(final);
    expect(tickets()).toEqual(originalTickets);
    expect(settlements()).toEqual(originalSettlements);

    const contextRow = instance
      .db()
      .$client.prepare(
        "SELECT id,snapshot_json FROM attempt_context_snapshots " +
          "WHERE attempt_id=? AND kind='material' AND source_id='lesson-material-two'",
      );
    const frozenRow = z
      .object({ id: z.uuid(), snapshot_json: z.string() })
      .parse(contextRow.get(id));
    instance
      .db()
      .$client.prepare(
        "UPDATE attempt_context_snapshots SET snapshot_json=json_set(snapshot_json,'$.contentMd','受控材料错配') WHERE id=?",
      )
      .run(frozenRow.id);
    const mismatched = await studentCall(`${path}/context`);
    expect(mismatched.status).toBe(503);
    expect(await mismatched.json()).toMatchObject({
      error: "KERNEL_ATTEMPT_UNAVAILABLE",
    });
    expect(tickets()).toEqual(originalTickets);
    expect(settlements()).toEqual(originalSettlements);
    instance
      .db()
      .$client.prepare(
        "UPDATE attempt_context_snapshots SET snapshot_json=? WHERE id=?",
      )
      .run(frozenRow.snapshot_json, frozenRow.id);
    expect(await frozenContext(id)).toEqual(oldContext);
    expect(kernelMaterials(id)).toEqual(oldPositions);
  } finally {
    instance.close();
    vi.unstubAllEnvs();
  }
});

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
    const teacherPath = `/api/teacher/attempts/${id}`;
    const teacherDetail = async () => {
      const res = await jsonCall(app, teacherPath, world.teacher);
      expect(res.status, await res.clone().text()).toBe(200);
      return teacherAttemptDetailOkSchema.parse(await res.json()).data;
    };
    const detail = await teacherDetail();
    const q1Response = detail.questions.find((q) => q.questionId === "k17-one");
    const q3Revision = frozen.get("k17-three");
    if (!q1Response?.responseId || !q3Revision)
      throw new Error("缺少首题冻结行或邻题原稿");
    const markPath = `/api/teacher/responses/${q1Response.responseId}/mark`;
    const neighborMarkPath = `/api/teacher/responses/${q3Revision}/mark`;
    const mark = (request: MarkRequest, target = markPath) =>
      jsonCall(app, target, world.teacher, "POST", request);
    const markOk = async (request: MarkRequest, target = markPath) => {
      const response = await mark(request, target);
      expect(response.status, await response.clone().text()).toBe(200);
      return wire(markResponseDataSchema).parse(await response.json()).data;
    };
    const wrong = {
      mark: "wrong",
      comment: "合成讲练课中批注",
      mutationId: randomUUID(),
      baseRevision: 0,
    } as const;
    expect((await mark(wrong, neighborMarkPath)).status).toBe(409);
    const marked = await markOk(wrong);
    expect(marked).toMatchObject({
      responseId: q1Response.responseId,
      teacherMark: "wrong",
      teacherComment: wrong.comment,
      finalCorrect: false,
      revision: 1,
      attemptStatus: "submitted",
      scoreFinal: null,
      pendingCount: 0,
    });
    expect(marked.eventId).toBeDefined();
    expect(await markOk(wrong)).toEqual(marked);
    const registration = await app.request(
      "/api/public/teacher/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          loginName: "讲练域外老师",
          password: "outside-pass-8",
        }),
      },
      nodePeerBindings("10.0.0.2"),
    );
    expect(registration.status, await registration.clone().text()).toBe(200);
    const outsideTeacher = `tutor_session=${extractSessionToken(registration)}`;
    const foreignMark = await jsonCall(
      app,
      markPath,
      outsideTeacher,
      "POST",
      wrong,
    );
    expect(foreignMark.status).toBe(404);
    expect(await foreignMark.text()).not.toContain(wrong.comment);
    expect((await jsonCall(app, teacherPath, outsideTeacher)).status).toBe(404);
    const markedView = await startView();
    expect(markedView.attempt.status).toBe("draft");
    expect(markedView.released["k17-one"]).toMatchObject({
      answer: reopened.released["k17-one"]?.answer,
      autoCorrect: true,
      teacherMark: "wrong",
      teacherComment: wrong.comment,
      finalCorrect: false,
    });
    expect(markedView.drafts).toEqual(reopened.drafts);
    expect(markedView.draftRevisions).toEqual(reopened.draftRevisions);
    expect(
      (await teacherDetail()).questions.find((q) => q.questionId === "k17-one"),
    ).toMatchObject({
      autoCorrect: true,
      teacherMark: "wrong",
      finalCorrect: false,
    });
    const stale = await mark({ ...wrong, mutationId: randomUUID() });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: "VERDICT_CONFLICT",
      _current: { revision: 1 },
    });

    const clear = {
      mark: null,
      comment: null,
      mutationId: randomUUID(),
      baseRevision: 1,
    } as const;
    instance
      .db()
      .$client.exec(
        "CREATE TEMP TRIGGER stop_lesson_mark_projection BEFORE UPDATE OF result_json ON kernel_response_marks BEGIN SELECT RAISE(ABORT,'中断讲练改判投影'); END",
      );
    expect((await mark(clear)).status).toBe(500);
    const readMarkReceipt = () =>
      instance
        .db()
        .$client.prepare(
          "SELECT result_json FROM kernel_response_marks WHERE operation_id=?",
        )
        .get(clear.mutationId);
    expect(readMarkReceipt()).toEqual({ result_json: null });
    const outsider = await jsonCall(app, path, world.otherCookie);
    expect(outsider.status).toBe(403);
    expect(await outsider.text()).not.toContain(wrong.comment);
    expect(readMarkReceipt()).toEqual({ result_json: null });
    instance.reopen();
    app = instance.open(false, teacher.id);
    expect((await startView()).released["k17-one"]).toEqual(
      reopened.released["k17-one"],
    );
    const recoveredMark = await markOk(clear);
    expect(recoveredMark).toMatchObject({ revision: 2, finalCorrect: true });
    expect(recoveredMark.eventId).toBeDefined();
    expect(readMarkReceipt()).not.toEqual({ result_json: null });
    const renewed = { ...wrong, mutationId: randomUUID(), baseRevision: 2 };
    instance.db().$client.exec(
      `CREATE TEMP TRIGGER revoke_lesson_mark AFTER INSERT ON kernel_response_marks
       BEGIN UPDATE teachers SET disabled_at = '2026-11-20T00:00:00.000Z' WHERE id = NEW.teacher_id; END`,
    );
    const denied = await mark(renewed);
    expect(denied.status, await denied.clone().text()).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "FORBIDDEN" });
    expect((await startView()).released["k17-one"]).toEqual(
      reopened.released["k17-one"],
    );
    instance.db().$client.exec("DROP TRIGGER revoke_lesson_mark");
    instance
      .db()
      .$client.prepare("UPDATE teachers SET disabled_at=NULL WHERE id=?")
      .run(teacher.id);
    const renewedMark = await markOk(renewed);
    expect(renewedMark).toMatchObject({ revision: 3, finalCorrect: false });
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
      scoreFinal: 25,
    });
    expect((await records())[0]).toMatchObject({ status: "graded", score: 25 });
    const finalQuestions = final.units.flatMap(({ questions }) => questions);
    expect(
      finalQuestions.find((q) => q.questionId === "k17-one"),
    ).toMatchObject({
      autoCorrect: true,
      teacherMark: "wrong",
      finalCorrect: false,
    });
    expect(
      finalQuestions.find((q) => q.questionId === "k17-three"),
    ).toMatchObject({
      autoCorrect: true,
      teacherMark: null,
      finalCorrect: true,
    });
    const settlement = () =>
      instance
        .db()
        .$client.prepare(
          "SELECT id, seq, created_at, question_count FROM attempt_settlements WHERE attempt_id=? AND kind='final'",
        )
        .all(id);
    const finalSettlement = settlement();
    expect(finalSettlement).toHaveLength(1);
    expect(finalSettlement[0]).toMatchObject({ seq: 1, question_count: 4 });
    const neighborWrong = { ...wrong, mutationId: randomUUID() };
    const override = await markOk(neighborWrong, neighborMarkPath);
    expect(override).toMatchObject({
      responseId: q3Revision,
      teacherMark: "wrong",
      finalCorrect: false,
      revision: 1,
      scoreFinal: 0,
    });
    expect(await markOk(neighborWrong, neighborMarkPath)).toEqual(override);
    const wrongTarget = await mark(neighborWrong);
    expect(wrongTarget.status).toBe(409);
    expect(await wrongTarget.json()).toMatchObject({
      error: "OPERATION_CONFLICT",
    });
    expect(
      (
        await jsonCall(
          app,
          neighborMarkPath,
          outsideTeacher,
          "POST",
          neighborWrong,
        )
      ).status,
    ).toBe(404);
    const overridden = await finishedResult(app, path, world.ownerCookie);
    expect(overridden.summary.scoreFinal).toBe(0);
    const revisedQuestions = overridden.units.flatMap(
      ({ questions }) => questions,
    );
    expect(revisedQuestions).toEqual(
      finalQuestions.map((question) =>
        question.questionId === "k17-three"
          ? {
              ...question,
              teacherMark: "wrong",
              teacherComment: wrong.comment,
              finalCorrect: false,
            }
          : question,
      ),
    );
    const neighborClear = await markOk(
      { ...clear, mutationId: randomUUID() },
      neighborMarkPath,
    );
    expect(neighborClear).toMatchObject({
      revision: 2,
      scoreFinal: 25,
      finalCorrect: true,
    });
    const finishReceipt = z
      .object({ receipt_id: z.uuid() })
      .parse(
        instance
          .db()
          .$client.prepare(
            "SELECT receipt_id FROM kernel_question_deliveries WHERE attempt_id=? AND json_extract(intent_json, '$.source')='finish'",
          )
          .get(id),
      ).receipt_id;
    expect(finishReceipt).not.toBe(receiptId);
    const verdictDb = new DatabaseSync(
      join(data.path, BACKUP_KERNEL_DATABASE),
      { readOnly: true },
    );
    try {
      const event = verdictDb.prepare(
        "SELECT question_id, submission_id FROM verdict_events WHERE id=?",
      );
      for (const change of [override, neighborClear])
        expect(event.get(change.eventId ?? "")).toEqual({
          question_id: "k17-three",
          submission_id: finishReceipt,
        });
      expect(event.get(renewedMark.eventId ?? "")).toEqual({
        question_id: "k17-one",
        submission_id: receiptId,
      });
    } finally {
      verdictDb.close();
    }
    expect(await finishedResult(app, path, world.ownerCookie)).toEqual(final);
    expect(settlement()).toEqual(finalSettlement);
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
    const automaticView = await startView();
    const nextPath = `/api/student/attempts/${automaticView.attempt.id}`;
    for (const question of automaticView.questions) {
      const response = await jsonCall(
        app,
        `${nextPath}/questions/${question.id}/submit`,
        world.ownerCookie,
        "POST",
        {
          questionRevisionId: question.questionRevisionId,
          expectedAnswerRevision:
            automaticView.draftRevisions?.[question.id] ?? 0,
          evidence: { questionId: question.id, state: "none" },
        },
      );
      expect(response.status, await response.clone().text()).toBe(200);
    }
    const autoFinished = await finishedResult(app, nextPath, world.ownerCookie);
    const last = automaticView.questions.at(-1);
    if (!last || autoFinished.summary.scoreFinal === null)
      throw new Error("缺少末题自动收尾结果");
    const lastMarkPath = `/api/teacher/responses/${last.questionRevisionId}/mark`;
    const lastMark = await markOk(
      { ...wrong, mark: "correct", mutationId: randomUUID() },
      lastMarkPath,
    );
    expect(lastMark.scoreFinal).toBe(autoFinished.summary.scoreFinal + 25);
    await markOk({ ...clear, mutationId: randomUUID() }, lastMarkPath);
    expect(await finishedResult(app, nextPath, world.ownerCookie)).toEqual(
      autoFinished,
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

it.each([false, true])(
  "普通整卷答问经公开入口保存、重开并确认（含客观题：%s）",
  async (mixed) => {
    using data = mkdtempDisposableSync(join(tmpdir(), "m05-response-host-"));
    const instance = openInstance(data.path);
    try {
      let app = instance.open(false);
      const world = await setupAssignment(app);
      const ids = {
        text: "m05-response-text",
        empty: "m05-response-empty",
        titleOnly: "m05-response-title",
        ink: "m05-response-ink",
        both: "m05-response-both",
        missing: "m05-response-missing",
      };
      const reference = "答问参考范文哨兵。";
      const alternative = "答问备选范文哨兵。";
      const solution = "答问详解哨兵。";
      const comment = "教师私有评语哨兵。";
      vi.stubEnv("NEW_CONTENT_ENABLED", "true");
      const {
        units: [unit],
      } = await importQuestions(app, world.teacher, undefined, [
        ...(mixed ? choices.slice(0, 6) : []),
        ...Object.values(ids).flatMap((id) => [
          `::::question{id=${id} type=response word-min=200}`,
          "请用一段话说明自己的看法。",
          ...(id === ids.missing
            ? []
            : [
                ":::answer",
                reference,
                ":::",
                ":::variant",
                alternative,
                ":::",
                ":::solution",
                solution,
                ":::",
              ]),
          "::::",
          "",
        ]),
      ]);
      vi.unstubAllEnvs();
      if (!unit) throw new Error("未导入答问题");
      const setReview = (studentSelfReviewEnabled: boolean) =>
        jsonCall(
          app,
          "/api/teacher/settings/practice-feedback",
          world.teacher,
          "PUT",
          { studentSelfReviewEnabled },
        );
      expect((await setReview(true)).status).toBe(200);
      const assignment = await assignKernelFixture(
        app,
        { ...world, unitId: unit.id },
        { answerRelease: "after_due", dueAt: "2099-01-01T00:00:00Z" },
      );
      const opened = await postAssignment(app, assignment, world.ownerCookie);
      expect(opened.status, await opened.clone().text()).toBe(200);
      const attempt = attemptStartOkSchema.parse(await opened.json()).data;
      expect((await setReview(false)).status).toBe(200);
      const path = `/api/student/attempts/${attempt.id}`;
      const forbidPrivate = (raw: unknown) => {
        for (const privateText of [reference, alternative, solution, comment])
          expect(JSON.stringify(raw)).not.toContain(privateText);
      };
      const readDraft = async () => {
        const res = await jsonCall(app, path, world.ownerCookie);
        expect(res.status, await res.clone().text()).toBe(200);
        const raw: unknown = await res.json();
        forbidPrivate(raw);
        assertNoLeak(raw);
        return attemptDraftOkSchema.parse(raw).data;
      };
      const initial = await readDraft();
      expect(initial.drafts).toEqual({});
      const questions = initial.units.flatMap((unit) => unit.questions);
      expect(questions.find(({ id }) => id === ids.text)).toMatchObject({
        type: "response",
        wordMin: 200,
      });
      const proof = (id: string, baseRevision = 0) => ({
        questionRevisionId: questions.find((question) => question.id === id)
          ?.questionRevisionId,
        expectedFrozenAt: attempt.frozenAt,
        baseRevision,
        mutationId: randomUUID(),
      });
      const save = (id: string, answer: object, cookie = world.ownerCookie) =>
        jsonCall(app, `${path}/answers/${id}`, cookie, "PUT", {
          ...proof(id),
          answer,
        });
      const rawText = {
        kind: "response",
        title: " 标题 \t",
        body: " 正文\r\n\n第二段  ",
      };
      const empty = { kind: "response", body: "" };
      const titleOnly = { kind: "response", title: "只有标题", body: " \t" };
      const both = { kind: "response", title: "", body: "纸面之外的文字\n" };
      const answers = {
        [ids.text]: rawText,
        [ids.empty]: empty,
        [ids.titleOnly]: titleOnly,
        [ids.both]: both,
        ...(mixed ? { "k17-one": { kind: "choice", index: 0 } } : {}),
      };
      for (const cookie of [world.otherCookie, world.teacher]) {
        const denied = await save(ids.text, rawText, cookie);
        expect(denied.status).toBe(cookie === world.teacher ? 401 : 403);
        forbidPrivate(await denied.json());
      }
      for (const malformed of [
        { kind: "response", title: "欠正文" },
        { kind: "response", body: "文".repeat(RESPONSE_BODY_MAX_CHARS + 1) },
        {
          kind: "response",
          title: "文".repeat(RESPONSE_TITLE_MAX_CHARS + 1),
          body: "正文",
        },
        { kind: "choice", index: 0 },
      ]) {
        const rejected = await save(ids.text, malformed);
        expect(rejected.status, await rejected.clone().text()).toBe(400);
        forbidPrivate(await rejected.json());
      }
      for (const [id, answer] of Object.entries(answers)) {
        const saved = await save(id, answer);
        expect(saved.status, await saved.clone().text()).toBe(200);
        forbidPrivate(await saved.json());
      }
      const putInk = async (id: string, base: number) => {
        const body = inkForm(base === 0 ? 15 : 30);
        const strokes = body.get("strokes"),
          snapshot = body.get("snapshot");
        if (!(strokes instanceof Blob && snapshot instanceof Blob))
          throw new Error("缺少合成笔迹");
        body.set("meta", JSON.stringify(proof(id, base)));
        const response = await app.request(`${path}/ink/${id}`, {
          method: "PUT",
          headers: { cookie: world.ownerCookie },
          body,
        });
        return {
          response,
          vector: Buffer.from(await strokes.arrayBuffer()),
          png: Buffer.from(await snapshot.arrayBuffer()),
        };
      };
      const inks = new Map<
        string,
        { inkId: string; vector: Buffer; png: Buffer }
      >();
      for (const id of [ids.ink, ids.both]) {
        const { response, vector, png } = await putInk(id, 0);
        expect(response.status, await response.clone().text()).toBe(200);
        const { inkId } = wire(
          z.object({ inkId: z.uuid(), revision: z.literal(1) }),
        ).parse(await response.json()).data;
        inks.set(id, { inkId, vector, png });
      }
      instance.reopen();
      app = instance.open(false);
      const reopened = await postAssignment(app, assignment, world.ownerCookie);
      expect(reopened.status, await reopened.clone().text()).toBe(200);
      expect(attemptStartOkSchema.parse(await reopened.json()).data.id).toBe(
        attempt.id,
      );
      const draft = await readDraft();
      expect(draft.drafts).toEqual(answers);
      expect(draft.draftRevisions).toMatchObject(
        Object.fromEntries(Object.keys(answers).map((id) => [id, 1])),
      );
      const submit = () =>
        jsonCall(app, `${path}/submit`, world.ownerCookie, "POST", {
          revisions: questions.map(({ id, questionRevisionId }) => ({
            questionId: id,
            questionRevisionId,
            expectedAnswerRevision: draft.draftRevisions?.[id] ?? 0,
          })),
        });
      const confirmed = await submit();
      expect(confirmed.status, await confirmed.clone().text()).toBe(200);
      const privateResult: unknown = await confirmed.json();
      forbidPrivate(privateResult);
      assertNoLeak(privateResult, {
        allow: ["answer", "answers", "solutionMd"],
        forbid: [
          "acceptedByQuestion",
          "questionAnswerRules",
          "reviewCriteria",
          "scoringKey",
        ],
      });
      const hidden = attemptResultOkSchema.parse(privateResult).data;
      expect(hidden.answersReleased).toBe(false);
      const rowsOf = (result: typeof hidden) =>
        result.units.flatMap((unit) => unit.questions);
      expect(
        rowsOf(hidden).map(({ questionId, answer, answered }) => [
          questionId,
          answer,
          answered,
        ]),
      ).toEqual([
        ...(mixed ? [["k17-one", answers["k17-one"], true]] : []),
        [ids.text, rawText, true],
        [ids.empty, empty, false],
        [ids.titleOnly, titleOnly, false],
        [ids.ink, null, true],
        [ids.both, both, true],
        [ids.missing, null, false],
      ]);
      for (const row of rowsOf(hidden)) {
        expect(row).toMatchObject({
          answers: null,
          solutionMd: null,
          gradingPolicy: null,
          autoCorrect: null,
          finalCorrect: null,
          teacherComment: null,
        });
      }

      const sql = instance.db().$client;
      const ticket = keyRow
        .extend({
          receipt_id: z.string().min(1),
          intent_json: z.string(),
        })
        .parse(
          sql
            .prepare(
              "SELECT operation_id, step_attempt_id, slot_id, receipt_id, intent_json FROM kernel_question_deliveries WHERE attempt_id=?",
            )
            .get(attempt.id),
        );
      const databasePath = join(data.path, BACKUP_KERNEL_DATABASE);
      const runtime = openLearningRuntime({
        databasePath,
        authorizeConfirmationRecovery: (identity) =>
          identity.studentId === world.studentId &&
          identity.activityId === attempt.id &&
          identity.operationId === ticket.operation_id,
      });
      try {
        const recovery = runtime.recoverQuestionDelivery(
          { role: "student", id: world.studentId },
          attempt.id,
          {
            protocolVersion: 1,
            operationId: ticket.operation_id,
            stepAttemptId: ticket.step_attempt_id,
          },
        );
        expect(recovery.receipt.id).toBe(ticket.receipt_id);
        expect(
          recovery.confirmation.questions
            .filter(({ questionId }) => questionId !== "k17-one")
            .map(({ questionId, value, revision }) => [
              questionId,
              value,
              revision,
            ]),
        ).toEqual([
          [ids.text, { title: rawText.title, body: rawText.body }, 1],
          [ids.empty, { body: "" }, 1],
          [ids.titleOnly, { title: titleOnly.title, body: titleOnly.body }, 1],
          [ids.ink, null, 0],
          [ids.both, { title: "", body: both.body }, 1],
          [ids.missing, null, 0],
        ]);
        if (recovery.evaluation.status !== "evaluated")
          throw new Error("内核评估须已在交卷时完成");
        expect(
          recovery.evaluation.questions
            .filter(({ questionId }) => questionId !== "k17-one")
            .map(({ result }) => result),
        ).toEqual(Array.from({ length: 6 }, () => ({ status: "needsReview" })));
      } finally {
        runtime.close();
      }
      using kernelDb = new DatabaseSync(databasePath, { readOnly: true });
      const definitionOf = (row: unknown): unknown =>
        JSON.parse(z.object({ definition: z.string() }).parse(row).definition);
      const questionIds = Object.values(ids);
      const publication = definitionOf(
        kernelDb
          .prepare(
            `SELECT p.definition FROM practices p JOIN activities a
          ON p.id=a.practice_id AND p.version=a.practice_version WHERE a.id=?`,
          )
          .get(attempt.id),
      );
      expect(publication).toMatchObject({
        questionAnswerRules: Object.fromEntries(
          questionIds.map((id) => [
            id,
            { id: "ownclass-response-body", version: 1 },
          ]),
        ),
      });
      const key = definitionOf(
        kernelDb
          .prepare(
            `SELECT k.definition FROM scoring_keys k JOIN evaluation_tasks e
          ON k.id=e.key_id AND k.version=e.key_version WHERE e.submission_id=?`,
          )
          .get(ticket.receipt_id),
      );
      expect(
        z
          .object({ acceptedByQuestion: z.record(z.string(), z.unknown()) })
          .parse(key).acceptedByQuestion,
      ).toEqual({
        ...Object.fromEntries(
          questionIds.map((id) => [id, { response: "textWithOptionalTitle" }]),
        ),
        ...(mixed
          ? { "k17-one": { response: "choice", acceptedChoice: "0" } }
          : {}),
      });
      expect(
        kernelDb
          .prepare(
            "SELECT unit_id FROM performances WHERE submission_id=? ORDER BY unit_id",
          )
          .all(ticket.receipt_id),
      ).toEqual(
        [ids.both, ids.text, ...(mixed ? ["k17-one"] : [])]
          .sort()
          .map((id) => ({ unit_id: `question:${id}` })),
      );
      const { formalInk: anchors } = kernelQuestionDeliveryIntentSchema.parse(
        JSON.parse(ticket.intent_json),
      );
      if (!anchors) throw new Error("答问缺少正式笔迹冻结声明");
      expect(anchors.map(({ questionId }) => questionId)).toEqual(
        Object.values(ids),
      );
      for (const { questionId, ink } of anchors) {
        const uploaded = inks.get(questionId);
        if (!uploaded) {
          expect(ink).toBeNull();
          continue;
        }
        expect(ink).toMatchObject({
          inkId: uploaded.inkId,
          revision: 1,
          strokeCount: 1,
        });
        expect(ink?.strokes.sha256).toBe(
          createHash("sha256").update(uploaded.vector).digest("hex"),
        );
        expect(ink?.png.sha256).toBe(
          createHash("sha256").update(uploaded.png).digest("hex"),
        );
      }

      expect((await submit()).status).toBe(409);
      for (const [id, base] of [
        [ids.ink, 1],
        [ids.missing, 0],
      ] as const) {
        const { response } = await putInk(id, base);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          error: "ALREADY_SUBMITTED",
        });
      }
      expect((await save(ids.both, both)).status).toBe(409);
      instance.reopen();
      app = instance.open(false);
      for (const [id, uploaded] of inks) {
        const png = await jsonCall(
          app,
          `${path}/ink/${id}.png`,
          world.ownerCookie,
        );
        expect(png.status).toBe(200);
        expect(Buffer.from(await png.arrayBuffer())).toEqual(uploaded.png);
        const vector = await jsonCall(
          app,
          `/api/teacher/ink/${uploaded.inkId}.json.gz`,
          world.teacher,
        );
        expect(vector.status).toBe(200);
        expect(Buffer.from(await vector.arrayBuffer())).toEqual(
          uploaded.vector,
        );
        const forbidden = await jsonCall(
          app,
          `${path}/ink/${id}`,
          world.otherCookie,
        );
        expect(forbidden.status).toBe(403);
      }

      const pending = await jsonCall(
        app,
        `/api/teacher/pending-marks?assignmentId=${assignment}`,
        world.teacher,
      );
      expect(pending.status, await pending.clone().text()).toBe(200);
      const queue = wire(pendingMarkListDataSchema).parse(
        await pending.json(),
      ).data;
      expect(queue.marks.map(({ questionId }) => questionId)).toEqual([
        ids.missing,
      ]);
      const [manual] = queue.marks;
      if (!manual) throw new Error("缺少冻结人工评阅行");
      const mark = await jsonCall(
        app,
        `/api/teacher/responses/${manual.responseId}/mark`,
        world.teacher,
        "POST",
        { mark: "wrong", comment, mutationId: randomUUID(), baseRevision: 0 },
      );
      expect(mark.status, await mark.clone().text()).toBe(200);
      forbidPrivate(await finishedResult(app, path, world.ownerCookie));
      expect((await jsonCall(app, path, world.otherCookie)).status).toBe(403);

      const reviewPath = `${path}/questions/${ids.text}/self-review`;
      const request = {
        verdict: "correct",
        baseRevision: 0,
        mutationId: randomUUID(),
      };
      const withheld = await jsonCall(
        app,
        reviewPath,
        world.ownerCookie,
        "POST",
        request,
      );
      expect(withheld.status).toBe(403);
      expect(await withheld.json()).toMatchObject({
        error: "SELF_REVIEW_NOT_RELEASED",
      });
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
      expect(released.attempt.scoreAuto).toBe(mixed ? 100 : null);
      const rows = rowsOf(released);
      if (mixed)
        expect(
          rows.find(({ questionId }) => questionId === "k17-one"),
        ).toMatchObject({ autoCorrect: true, finalCorrect: true });
      for (const row of rows.filter(
        ({ questionId }) => questionId !== "k17-one",
      )) {
        if (row.questionId === ids.missing) {
          expect(row).toMatchObject({
            gradingPolicy: "manual_only",
            answers: null,
            autoCorrect: null,
            finalCorrect: false,
            teacherComment: comment,
          });
          continue;
        }
        expect(row).toMatchObject({
          gradingPolicy: "reference_self",
          autoCorrect: null,
          finalCorrect: null,
          answers: {
            kind: "response",
            referenceMd: reference,
            variantsMd: [alternative],
          },
          solutionMd: solution,
        });
      }
      const foreignReview = await jsonCall(
        app,
        reviewPath,
        world.otherCookie,
        "POST",
        request,
      );
      expect(foreignReview.status).toBe(403);
      const reviewed = await jsonCall(
        app,
        reviewPath,
        world.ownerCookie,
        "POST",
        request,
      );
      expect(reviewed.status, await reviewed.clone().text()).toBe(200);
      expect(
        wire(selfReviewDataSchema).parse(await reviewed.json()).data.effective,
      ).toEqual({ source: "self", value: true });
      const finalSql = instance.db().$client;
      expect(
        finalSql
          .prepare(
            "SELECT count(*) n FROM kernel_question_deliveries WHERE attempt_id=?",
          )
          .get(attempt.id),
      ).toEqual({ n: 1 });
      expect(
        finalSql
          .prepare(
            "SELECT count(*) n FROM attempt_settlements WHERE attempt_id=? AND kind='final'",
          )
          .get(attempt.id),
      ).toEqual({ n: 1 });
    } finally {
      vi.unstubAllEnvs();
      instance.close();
    }
  },
);

it.each([
  { selfReview: true, unkeyed: false, mixed: false },
  { selfReview: false, unkeyed: false, mixed: true },
  { selfReview: true, unkeyed: true, mixed: false },
  { selfReview: true, unkeyed: true, mixed: true },
])(
  "普通整卷配对经原入口保存冻结映射，自评=$selfReview，无参考=$unkeyed，混卷=$mixed",
  async ({ selfReview, unkeyed, mixed }) => {
    using data = mkdtempDisposableSync(join(tmpdir(), "m05-matching-host-"));
    const instance = openInstance(data.path);
    try {
      let app = instance.open(false);
      const world = await setupAssignment(app);
      vi.stubEnv("NEW_CONTENT_ENABLED", "true");
      const ids = {
        partial: "m05-matching-partial",
        repeat: "m05-matching-repeat",
        empty: "m05-matching-empty",
        missing: "m05-matching-missing",
      };
      const questionIds = Object.values(ids);
      const slots = ["slot-1", "slot-2", "slot-3", "slot-4", "slot-5"];
      const material =
        "第一段 {{slot-1}} 讲睡眠结构；第二段 {{slot-2}} 讲清洁循环。第三段 {{slot-3}} 讲经济学误解，第四段 {{slot-4}} 讲文化态度，第五段 {{slot-5}} 讲对策。";
      const publicOptions = [
        "深睡眠期大脑的类淋巴系统冲洗清醒时累积的废物蛋白。",
        "十分钟午睡反而提升下午警觉且不扰夜间节律。",
        "对少睡的骄傲，从数据上看是对劣化表现的骄傲。",
        "固定起床时间比睡懒觉更能重建节律。",
        "八小时规范本身是工业排班的产物。",
        "尊重这张工具意味着给它一份职责说明：睡眠，且几乎是只睡眠。",
        "早晨的咖啡因在下个周期开始前已基本离开血流。",
      ].map((text, index) => ({ id: `opt-${index + 1}`, text }));
      const matching = (pairs: Record<string, string>) => ({
        kind: "matching" as const,
        pairs,
      });
      const reference = matching({
        "slot-1": "opt-1",
        "slot-2": "opt-5",
        "slot-3": "opt-3",
        "slot-4": "opt-4",
        "slot-5": "opt-6",
      });
      const repeated = matching({
        "slot-5": "opt-6",
        "slot-3": "opt-3",
        "slot-4": "opt-3",
      });
      const partial = matching({ "slot-5": "opt-7", "slot-2": "opt-2" });
      const partialReference = matching({ "slot-1": "opt-1" });
      const empty = matching({});
      const answerFor = (id: string) => {
        if (id === ids.repeat) return repeated;
        return id === ids.partial && !selfReview ? partialReference : reference;
      };
      const solution = "合成配对的私有详解。";
      const comment = "合成配对的教师私有评语。";
      const {
        units: [unit],
      } = await importQuestions(app, world.teacher, undefined, [
        "::::material{id=mat-1 title=配对材料}",
        material,
        "::::",
        "",
        '::::group{id=grp-1 title="为文中空白处选择合适的内容。" label=1}',
        "::ref{material=mat-1}",
        ...questionIds.map((id) => `::ref{question=${id}}`),
        "::::",
        "",
        ...(mixed ? choices.slice(0, 6) : []),
        ...questionIds.flatMap((id) => [
          `:::::question{id=${id} type=matching difficulty=3}`,
          "从选项中为文中空白处选择内容。",
          "",
          `::ref{material=mat-1 slots=slot-${id === ids.repeat ? 3 : 1}..slot-5}`,
          "",
          id === ids.repeat ? "::::options{allow-repeat=true}" : "::::options",
          ...publicOptions.flatMap(({ id, text }) => [
            `:::option{id=${id}${id === "opt-7" ? " distractor=true" : ""}}`,
            text,
            ":::",
          ]),
          "::::",
          "",
          ...(unkeyed
            ? []
            : [
                ":::answer",
                ...Object.entries(answerFor(id).pairs).map(
                  ([slot, option]) => `${slot} = ${option}`,
                ),
                ":::",
                "",
              ]),
          ":::solution",
          solution,
          ":::",
          ":::::",
          "",
        ]),
      ]);
      if (!unit) throw new Error("未导入合成配对题");
      if (unkeyed && !mixed) {
        const db = instance.db().$client;
        const stored = z
          .object({
            source_md: z.string(),
            answers_json: z.null(),
            material_refs_json: z.string(),
          })
          .parse(
            db
              .prepare(
                "SELECT source_md,answers_json,material_refs_json FROM questions WHERE id=?",
              )
              .get(ids.partial),
          );
        const replace = db.prepare(
          "UPDATE questions SET source_md=?,answers_json=?,material_refs_json=? WHERE id=?",
        );
        for (const [source, answers, refs] of [
          [stored.source_md, "无效 JSON", stored.material_refs_json],
          [stored.source_md, "null", stored.material_refs_json],
          [
            stored.source_md,
            '{"kind":"matching","pairs":{"slot-1":"unknown"}}',
            stored.material_refs_json,
          ],
          [
            stored.source_md.replace(
              ":::solution",
              ":::answer\n::: \n\n:::solution",
            ),
            null,
            stored.material_refs_json,
          ],
          [
            stored.source_md.replace(
              ":::solution",
              ":::answer\n非法参考\n:::\n\n:::solution",
            ),
            null,
            stored.material_refs_json,
          ],
          [
            stored.source_md,
            null,
            '[{"material":"mat-1","slots":"slot-1,unknown"}]',
          ],
          [
            stored.source_md,
            null,
            '[{"material":"mat-1","slots":"slot-1,slot-5..slot-2"}]',
          ],
        ] as const) {
          replace.run(source, answers, refs, ids.partial);
          try {
            const corrupted = await jsonCall(
              app,
              "/api/teacher/assignments",
              world.teacher,
              "POST",
              {
                title: "坏配对冻结来源",
                unitIds: [unit.id],
                studentIds: [world.studentId],
                executionBackend: "kernel",
                allowRedo: false,
              },
            );
            expect(corrupted.status, await corrupted.clone().text()).toBe(422);
            expect(await corrupted.json()).toMatchObject({
              error: "M04_PRACTICE_INELIGIBLE",
            });
          } finally {
            replace.run(
              stored.source_md,
              stored.answers_json,
              stored.material_refs_json,
              ids.partial,
            );
          }
        }
      }
      const setReview = (enabled: boolean) =>
        jsonCall(
          app,
          "/api/teacher/settings/practice-feedback",
          world.teacher,
          "PUT",
          { studentSelfReviewEnabled: enabled },
        );
      expect((await setReview(selfReview)).status).toBe(200);
      const assignment = await assignKernelFixture(
        app,
        { ...world, unitId: unit.id },
        { answerRelease: "after_due", dueAt: "2099-01-01T00:00:00Z" },
      );
      const opened = await postAssignment(app, assignment, world.ownerCookie);
      expect(opened.status, await opened.clone().text()).toBe(200);
      const attempt = attemptStartOkSchema.parse(await opened.json()).data;
      expect((await setReview(!selfReview)).status).toBe(200);
      const path = `/api/student/attempts/${attempt.id}`;
      const privateKeys = [
        "acceptedBlanks",
        "acceptedByQuestion",
        "distractor",
        "questionAnswerRules",
        "scoringKey",
      ];
      const readPublic = async (
        suffix: string,
        allow: readonly string[] = [],
      ) => {
        const response = await jsonCall(app, path + suffix, world.ownerCookie);
        expect(response.status, await response.clone().text()).toBe(200);
        const raw: unknown = await response.json();
        assertNoLeak(raw, { forbid: privateKeys, allow });
        return raw;
      };
      const readDraft = async () =>
        attemptDraftOkSchema.parse(await readPublic("")).data;
      const context = attemptContextOkSchema.parse(
        await readPublic("/context"),
      ).data;
      expect(context.materials).toEqual([
        expect.objectContaining({ id: "mat-1", contentMd: material }),
      ]);
      expect(context.groups).toEqual([
        expect.objectContaining({
          id: "grp-1",
          materialRefs: [{ material: "mat-1" }],
          questionIds,
        }),
      ]);
      const draft = await readDraft();
      const questions = draft.units.flatMap(({ questions }) => questions);
      const matchingQuestions = questions.filter(({ id }) =>
        questionIds.includes(id),
      );
      expect(matchingQuestions.map(({ id }) => id)).toEqual(questionIds);
      expect(draft.drafts).toEqual({});
      const structureOf = (id: string) => ({
        matchingSlots: slots
          .map((id, index) => ({ id, ordinal: index + 1 }))
          .slice(id === ids.repeat ? 2 : 0),
        matchingOptions: {
          allowRepeat: id === ids.repeat,
          options: publicOptions,
        },
        materialRefs: [{ material: "mat-1" }],
      });
      for (const question of matchingQuestions)
        expect(question).toMatchObject(structureOf(question.id));

      const save = (
        id: string,
        pairs: Record<string, string>,
        cookie = world.ownerCookie,
      ) =>
        jsonCall(app, `${path}/answers/${id}`, cookie, "PUT", {
          answer: matching(pairs),
          baseRevision: 0,
          mutationId: randomUUID(),
          expectedFrozenAt: attempt.frozenAt,
          questionRevisionId: questions.find((question) => question.id === id)
            ?.questionRevisionId,
        });
      const newTeacher = await jsonCall(
        app,
        "/api/admin/teachers",
        world.teacher,
        "POST",
        {
          loginName: "合成配对异域教师",
        },
      );
      expect(newTeacher.status, await newTeacher.clone().text()).toBe(201);
      const { initialPassword } = adminTeacherCreateOkSchema.parse(
        await newTeacher.json(),
      ).data;
      const foreignLogin = await jsonCall(
        app,
        "/api/public/teacher/login",
        "",
        "POST",
        {
          loginName: "合成配对异域教师",
          password: initialPassword,
        },
      );
      expect(foreignLogin.status).toBe(200);
      const foreignTeacher = `tutor_session=${extractSessionToken(foreignLogin)}`;
      await createStudent(app, foreignTeacher, "合成配对异域学生");
      const foreignStudent = await loginStudent(app, "合成配对异域学生");
      expect(
        (await jsonCall(app, `${path}/context`, foreignStudent)).status,
      ).toBe(403);
      expect(
        (await save(ids.partial, partial.pairs, foreignStudent)).status,
      ).toBe(403);
      for (const [id, pairs] of [
        [ids.partial, { unknown: "opt-1" }],
        [ids.partial, { "slot-1": "unknown" }],
        [ids.partial, { "slot-1": "opt-2", "slot-3": "opt-2" }],
        [ids.repeat, { "slot-1": "opt-3" }],
      ] as const) {
        const rejected = await save(id, pairs);
        expect(rejected.status, await rejected.clone().text()).toBe(400);
        expect(await rejected.json()).toMatchObject({
          error: "VALIDATION_ERROR",
        });
      }
      expect((await readDraft()).drafts).toEqual({});
      const written = {
        [ids.partial]: partial,
        [ids.repeat]: repeated,
        [ids.empty]: empty,
      };
      for (const [id, answer] of Object.entries(written)) {
        const saved = await save(id, answer.pairs);
        expect(saved.status, await saved.clone().text()).toBe(200);
        assertNoLeak(await saved.json(), {
          forbid: privateKeys,
          allow: ["answer"],
        });
      }
      const automaticDraft =
        unkeyed && mixed ? { "k17-one": { kind: "choice", index: 0 } } : {};
      if (unkeyed && mixed) {
        const automatic = await jsonCall(
          app,
          `${path}/answers/k17-one`,
          world.ownerCookie,
          "PUT",
          {
            answer: automaticDraft["k17-one"],
            baseRevision: 0,
            mutationId: randomUUID(),
            expectedFrozenAt: attempt.frozenAt,
            questionRevisionId: questions.find(({ id }) => id === "k17-one")
              ?.questionRevisionId,
          },
        );
        expect(automatic.status, await automatic.clone().text()).toBe(200);
      }
      instance.reopen();
      app = instance.open(false);
      const saved = await readDraft();
      expect(saved.drafts).toEqual({ ...written, ...automaticDraft });
      const submit = () =>
        jsonCall(app, `${path}/submit`, world.ownerCookie, "POST", {
          revisions: questions.map(({ id, questionRevisionId }) => ({
            questionId: id,
            questionRevisionId,
            expectedAnswerRevision: saved.draftRevisions?.[id] ?? 0,
          })),
        });
      let raw: unknown;
      if (unkeyed && !mixed) {
        const db = instance.db().$client;
        db.exec(
          "CREATE TEMP TRIGGER stop_matching_settlement BEFORE INSERT ON attempt_settlements BEGIN SELECT RAISE(ABORT, '中断配对结算'); END",
        );
        expect((await submit()).status).toBe(500);
        expect(
          db
            .prepare(
              "SELECT receipt_id FROM kernel_question_deliveries WHERE attempt_id=?",
            )
            .get(attempt.id),
        ).toEqual({ receipt_id: null });
        expect(
          db
            .prepare(
              "SELECT count(*) n FROM attempt_settlements WHERE attempt_id=?",
            )
            .get(attempt.id),
        ).toEqual({ n: 0 });
        using kernel = new DatabaseSync(
          join(data.path, BACKUP_KERNEL_DATABASE),
          { readOnly: true },
        );
        expect(
          kernel
            .prepare(
              "SELECT submission_id FROM completions WHERE activity_id=?",
            )
            .get(attempt.id),
        ).toEqual({ submission_id: expect.any(String) });
        instance.reopen();
        app = instance.open(false);
        raw = await readPublic("", ["answer", "answers", "solutionMd"]);
      } else {
        const confirmed = await submit();
        expect(confirmed.status, await confirmed.clone().text()).toBe(200);
        raw = await confirmed.json();
      }
      assertNoLeak(raw, {
        forbid: privateKeys,
        allow: ["answer", "answers", "solutionMd"],
      });
      expect(JSON.stringify(raw)).not.toContain(solution);
      const hidden = attemptResultOkSchema.parse(raw).data;
      const rowsOf = (data: typeof hidden) =>
        data.units
          .flatMap(({ questions }) => questions)
          .filter(({ questionId }) => questionIds.includes(questionId));
      expect(hidden.answersReleased).toBe(false);
      expect(
        rowsOf(hidden).map(({ questionId, answer, answered }) => [
          questionId,
          answer,
          answered,
        ]),
      ).toEqual([
        [ids.partial, partial, true],
        [ids.repeat, repeated, true],
        [ids.empty, empty, false],
        [ids.missing, null, false],
      ]);
      for (const row of rowsOf(hidden)) {
        expect(row).toMatchObject({
          snapshot: structureOf(row.questionId),
          answers: null,
          solutionMd: null,
          autoCorrect: null,
          finalCorrect: null,
          teacherMark: null,
          teacherComment: null,
        });
      }
      expect((await submit()).status).toBe(409);
      expect((await save(ids.partial, partial.pairs)).status).toBe(409);
      instance.reopen();
      app = instance.open(false);
      expect((await jsonCall(app, path, foreignStudent)).status).toBe(403);
      expect(await finishedResult(app, path, world.ownerCookie)).toEqual({
        ...hidden,
        releaseCheckedAt: expect.any(String),
      });

      const sql = instance.db().$client;
      const [ticket] = keyRow
        .extend({ receipt_id: z.string().min(1) })
        .array()
        .length(1)
        .parse(
          sql
            .prepare(
              "SELECT operation_id, step_attempt_id, slot_id, receipt_id FROM kernel_question_deliveries WHERE attempt_id=?",
            )
            .all(attempt.id),
        );
      if (!ticket) throw new Error("缺少配对确认回执");
      expect(
        sql
          .prepare(
            "SELECT count(*) AS n FROM attempt_settlements WHERE attempt_id=? AND kind='final'",
          )
          .get(attempt.id),
      ).toEqual({ n: 1 });
      const databasePath = join(data.path, BACKUP_KERNEL_DATABASE);
      const runtime = openLearningRuntime({
        databasePath,
        authorizeConfirmationRecovery: (identity) =>
          identity.studentId === world.studentId &&
          identity.activityId === attempt.id &&
          identity.stepAttemptId === ticket.step_attempt_id &&
          identity.operationId === ticket.operation_id,
      });
      try {
        const actor = { role: "student", id: world.studentId } as const;
        const activity = runtime.read(actor, attempt.id);
        assertNoLeak(activity, {
          forbid: [...privateKeys, "pairs"],
          allow: ["answer", "answers"],
        });
        if (!("inputs" in activity)) throw new Error("缺少冻结材料位置");
        const materials = Object.values(activity.inputs).flatMap((input) =>
          input.from === "material" && input.material ? [input] : [],
        );
        expect(materials).toHaveLength(5);
        expect(
          new Set(materials.map(({ positionId }) => positionId)).size,
        ).toBe(5);
        for (const { material: frozen } of materials)
          expect(frozen).toMatchObject({
            source: "mat-1",
            version: 1,
            paragraphs: [{ id: "content", text: material }],
          });
        const key = {
          protocolVersion: 1 as const,
          operationId: ticket.operation_id,
          stepAttemptId: ticket.step_attempt_id,
        };
        const recovery = runtime.recoverQuestionDelivery(
          actor,
          attempt.id,
          key,
          "declared",
        );
        expect(recovery.receipt.id).toBe(ticket.receipt_id);
        expect(
          runtime.confirmQuestionDelivery(actor, attempt.id, {
            ...key,
            source: "whole",
            slotId: ticket.slot_id,
            questions: recovery.requestQuestions,
          }),
        ).toEqual(recovery.receipt);
        expect(
          recovery.confirmation.questions
            .filter(({ questionId }) => questionIds.includes(questionId))
            .map(({ questionId, value, revision }) => [
              questionId,
              value,
              revision,
            ]),
        ).toEqual([
          [ids.partial, ["slot-2", "opt-2", "slot-5", "opt-7"], 1],
          [
            ids.repeat,
            ["slot-3", "opt-3", "slot-4", "opt-3", "slot-5", "opt-6"],
            1,
          ],
          [ids.empty, [], 1],
          [ids.missing, null, 0],
        ]);
        if (unkeyed) {
          expect(recovery.assessment).toBe(
            mixed ? "automatic" : "teacherReview",
          );
          expect(recovery.review?.questions).toEqual(
            questionIds.map((questionId) => ({
              questionId,
              questionVersion: 1,
              status: "needsReview",
            })),
          );
          if (recovery.assessment === "automatic")
            expect(recovery.evaluation.questions).toEqual([
              {
                questionId: "k17-one",
                questionVersion: 1,
                result: { status: "judged", correct: true },
              },
            ]);
        } else {
          if (recovery.assessment !== "automatic")
            throw new Error("有参考配对须保留原评估通道");
          if (recovery.evaluation.status !== "evaluated")
            throw new Error("内核评估须已在交卷时完成");
          expect(
            recovery.evaluation.questions
              .filter(({ questionId }) => questionIds.includes(questionId))
              .map(({ result }) => result),
          ).toEqual(questionIds.map(() => ({ status: "needsReview" })));
        }
      } finally {
        runtime.close();
      }
      using kernelDb = new DatabaseSync(databasePath, { readOnly: true });
      const parseDefinition = (row: unknown): unknown =>
        JSON.parse(z.object({ definition: z.string() }).parse(row).definition);
      const practice = parseDefinition(
        kernelDb
          .prepare(
            "SELECT p.definition FROM practices p JOIN activities a ON p.id=a.practice_id AND p.version=a.practice_version WHERE a.id=?",
          )
          .get(attempt.id),
      );
      expect(practice).toMatchObject({
        questionAnswerRules: Object.fromEntries(
          questionIds.map((id) => [
            id,
            { id: "ownclass-matching-pairs", version: 1 },
          ]),
        ),
      });
      const scoringKey = kernelDb
        .prepare(
          "SELECT k.definition FROM scoring_keys k JOIN evaluation_tasks e ON k.id=e.key_id AND k.version=e.key_version WHERE e.submission_id=?",
        )
        .get(ticket.receipt_id);
      if (unkeyed) {
        expect(practice).toMatchObject({
          grading: { teacherReview: { questionIds: questionIds.toSorted() } },
          questions: expect.arrayContaining(
            questionIds.map((id) =>
              expect.objectContaining({
                id,
                response: "orderedTextBlanks",
                blankCount: id === ids.repeat ? 6 : 10,
              }),
            ),
          ),
        });
        if (mixed)
          expect(parseDefinition(scoringKey)).toEqual({
            id: expect.any(String),
            version: 1,
            acceptedByQuestion: {
              "k17-one": { response: "choice", acceptedChoice: "0" },
            },
          });
        else {
          expect(practice).not.toHaveProperty("grading.assessment");
          expect(scoringKey).toBeUndefined();
        }
      } else {
        expect(parseDefinition(scoringKey)).toMatchObject({
          acceptedByQuestion: Object.fromEntries(
            questionIds.map((id) => [
              id,
              {
                response: "orderedTextBlanks",
                acceptedBlanks: Object.entries(answerFor(id).pairs)
                  .sort()
                  .flatMap(([slot, option]) => [[slot], [option]]),
              },
            ]),
          ),
        });
      }
      expect(
        kernelDb
          .prepare(
            "SELECT unit_id FROM performances WHERE submission_id=? ORDER BY unit_id",
          )
          .all(ticket.receipt_id),
      ).toEqual(
        [...(mixed && unkeyed ? ["k17-one"] : []), ids.partial, ids.repeat].map(
          (id) => ({ unit_id: `question:${id}` }),
        ),
      );

      const teacherView = await jsonCall(
        app,
        `/api/teacher/attempts/${attempt.id}`,
        world.teacher,
      );
      expect(teacherView.status).toBe(200);
      const teacher = teacherAttemptDetailOkSchema.parse(
        await teacherView.json(),
      ).data;
      const gradingPolicy =
        selfReview && !unkeyed ? "reference_self" : "manual_only";
      const target = teacher.questions.find(
        ({ questionId }) => questionId === ids.partial,
      );
      expect(target).toMatchObject({
        answer: partial,
        answers: unkeyed ? null : answerFor(ids.partial),
        autoCorrect: null,
        finalCorrect: null,
        gradingPolicy,
      });
      expect(teacher).toMatchObject({
        pendingCount: gradingPolicy === "manual_only" ? 4 : 0,
        selfReviewPendingCount: gradingPolicy === "reference_self" ? 4 : 0,
      });
      if (unkeyed && mixed)
        expect(
          teacher.questions.find(({ questionId }) => questionId === "k17-one"),
        ).toMatchObject({
          answer: automaticDraft["k17-one"],
          autoCorrect: true,
          finalCorrect: true,
          gradingPolicy: "auto",
        });
      if (gradingPolicy === "manual_only") {
        if (!target) throw new Error("缺少冻结配对评阅行");
        const mark = await jsonCall(
          app,
          `/api/teacher/responses/${target.responseId}/mark`,
          world.teacher,
          "POST",
          {
            mark: "wrong",
            comment,
            mutationId: randomUUID(),
            baseRevision: 0,
          },
        );
        expect(mark.status, await mark.clone().text()).toBe(200);
        expect(
          wire(markResponseDataSchema).parse(await mark.json()).data
            .finalCorrect,
        ).toBe(false);
        const withheld = await readPublic("", [
          "answer",
          "answers",
          "solutionMd",
        ]);
        expect(JSON.stringify(withheld)).not.toContain(comment);
        const [marked] = rowsOf(attemptResultOkSchema.parse(withheld).data);
        expect(marked).toMatchObject({
          finalCorrect: null,
          teacherMark: null,
          teacherComment: null,
        });
      }
      if (unkeyed) {
        if (!target) throw new Error("缺少无参考配对评阅行");
        const markPath = `/api/teacher/responses/${target.responseId}/mark`;
        const clear = {
          mark: null,
          comment: null,
          baseRevision: 1,
          mutationId: randomUUID(),
        };
        const mark = (request: MarkRequest, cookie = world.teacher) =>
          jsonCall(app, markPath, cookie, "POST", request);
        const checkedMark = async (request: MarkRequest) => {
          const response = await mark(request);
          expect(response.status, await response.clone().text()).toBe(200);
          return wire(markResponseDataSchema).parse(await response.json()).data;
        };
        const queue = async () => {
          const response = await jsonCall(
            app,
            `/api/teacher/pending-marks?assignmentId=${assignment}`,
            world.teacher,
          );
          expect(response.status, await response.clone().text()).toBe(200);
          return wire(pendingMarkListDataSchema)
            .parse(await response.json())
            .data.marks.map(({ questionId }) => questionId)
            .sort();
        };
        expect(await queue()).toEqual(
          questionIds.filter((id) => id !== ids.partial).sort(),
        );
        expect((await mark(clear, foreignTeacher)).status).toBe(404);
        const stale = await mark({ ...clear, baseRevision: 0 });
        expect(stale.status).toBe(409);
        expect(await stale.json()).toMatchObject({ error: "VERDICT_CONFLICT" });

        let finishedMark: z.infer<typeof markResponseDataSchema> | undefined;
        for (const row of teacher.questions.filter(
          ({ questionId }) =>
            questionId !== ids.partial && questionIds.includes(questionId),
        )) {
          const response = await jsonCall(
            app,
            `/api/teacher/responses/${row.responseId}/mark`,
            world.teacher,
            "POST",
            {
              mark: "correct",
              comment: null,
              baseRevision: 0,
              mutationId: randomUUID(),
            },
          );
          expect(response.status, await response.clone().text()).toBe(200);
          finishedMark = wire(markResponseDataSchema).parse(
            await response.json(),
          ).data;
        }
        expect(finishedMark).toMatchObject({
          attemptStatus: "graded",
          pendingCount: 0,
          scoreFinal: mixed ? 80 : 75,
        });
        expect(await queue()).toEqual([]);
        const owner = teacherInfoOkSchema.parse(
          await (await jsonCall(app, "/api/teacher/me", world.teacher)).json(),
        ).data.id;
        const disable = sql.prepare(
          "UPDATE teachers SET disabled_at=? WHERE id=?",
        );
        disable.run(new Date().toISOString(), owner);
        expect((await mark(clear)).status).toBe(401);
        disable.run(null, owner);
        const events = () =>
          kernelDb
            .prepare("SELECT id FROM verdict_events WHERE operation_id=?")
            .all(clear.mutationId);
        expect(events()).toEqual([]);
        sql.exec(
          "CREATE TEMP TRIGGER stop_matching_mark BEFORE UPDATE OF result_json ON kernel_response_marks BEGIN SELECT RAISE(ABORT, '中断配对批改'); END",
        );
        expect((await mark(clear)).status).toBe(500);
        expect(
          sql
            .prepare(
              "SELECT result_json FROM kernel_response_marks WHERE operation_id=?",
            )
            .get(clear.mutationId),
        ).toEqual({ result_json: null });
        const [accepted] = events();
        expect(accepted).toEqual({ id: expect.any(String) });
        instance.reopen();
        app = instance.open(false);
        expect(await queue()).toEqual([ids.partial]);
        const cleared = await checkedMark(clear);
        expect(cleared).toMatchObject({
          eventId: accepted?.id,
          revision: 2,
          teacherMark: null,
          teacherComment: null,
          finalCorrect: null,
          attemptStatus: "submitted",
          pendingCount: 1,
          scoreFinal: null,
        });
        expect(await checkedMark(clear)).toEqual(cleared);
        const reused = await mark({ ...clear, mark: "correct" });
        expect(reused.status).toBe(409);
        expect(await reused.json()).toMatchObject({
          error: "OPERATION_CONFLICT",
        });
        expect(events()).toEqual([accepted]);
        expect(
          instance
            .db()
            .$client.prepare(
              "SELECT count(*) AS n FROM attempt_settlements WHERE attempt_id=?",
            )
            .get(attempt.id),
        ).toEqual({ n: 1 });
      }
      const reviewPath = `${path}/questions/${ids.partial}/self-review`;
      const review = (cookie: string) =>
        jsonCall(app, reviewPath, cookie, "POST", {
          verdict: "correct",
          baseRevision: 0,
          mutationId: randomUUID(),
        });
      if (selfReview)
        expect((await review(world.ownerCookie)).status).toBe(403);
      const publish = await jsonCall(
        app,
        `/api/teacher/assignments/${assignment}`,
        world.teacher,
        "PATCH",
        { answerRelease: "on_submit" },
      );
      expect(publish.status, await publish.clone().text()).toBe(200);
      const released = attemptResultOkSchema.parse(
        await readPublic("", ["answer", "answers", "solutionMd"]),
      ).data;
      expect(released.answersReleased).toBe(true);
      for (const row of rowsOf(released)) {
        const marked = !selfReview && row.questionId === ids.partial;
        const unkeyedCorrect = unkeyed && row.questionId !== ids.partial;
        expect(row).toMatchObject({
          snapshot: structureOf(row.questionId),
          answers: unkeyed ? null : answerFor(row.questionId),
          solutionMd: solution,
          autoCorrect: null,
          finalCorrect: marked ? false : unkeyedCorrect ? true : null,
          gradingPolicy,
          teacherMark: marked ? "wrong" : unkeyedCorrect ? "correct" : null,
          teacherComment: marked ? comment : null,
        });
      }
      expect((await review(foreignStudent)).status).toBe(403);
      if (unkeyed) {
        expect((await review(world.ownerCookie)).status).toBe(403);
        expect(released.summary).toMatchObject({
          pendingCount: 1,
          scoreFinal: null,
        });
        expect(released.attempt.scoreAuto).toBe(mixed ? 100 : null);
      } else if (selfReview) {
        const reviewed = await review(world.ownerCookie);
        expect(reviewed.status, await reviewed.clone().text()).toBe(200);
        expect(
          wire(selfReviewDataSchema).parse(await reviewed.json()).data
            .effective,
        ).toEqual({ source: "self", value: true });
      }
    } finally {
      vi.unstubAllEnvs();
      instance.close();
    }
  },
);

it("普通整卷无材料无参考配对按真实零槽位冻结并进入教师待批", async () => {
  using data = mkdtempDisposableSync(join(tmpdir(), "m05-zero-matching-"));
  const instance = openInstance(data.path);
  try {
    let app = instance.open(false);
    const world = await setupAssignment(app);
    vi.stubEnv("NEW_CONTENT_ENABLED", "true");
    const ids = {
      partial: "match-partial",
      repeat: "match-repeat",
      empty: "match-empty",
      missing: "match-missing",
    };
    const questionIds = Object.values(ids);
    const withRepeat = (id: string) => id === ids.repeat;
    const options = [
      { id: "opt-1", text: "甲选项。" },
      { id: "opt-2", text: "乙选项。" },
    ];
    const solution = "合成零槽配对私有详解。";
    const {
      units: [unit],
    } = await importQuestions(app, world.teacher, undefined, [
      "::::material{id=unattached-material}",
      "索引污染探针所用的独立材料。",
      "::::",
      "",
      ...questionIds.flatMap((id) => [
        `:::::question{id=${id} type=matching}`,
        "请配置对应关系。",
        "",
        withRepeat(id) ? "::::options{allow-repeat=true}" : "::::options",
        ...options.flatMap(({ id, text }) => [
          `:::option{id=${id}${id === "opt-2" ? " distractor=true" : ""}}`,
          text,
          ":::",
        ]),
        "::::",
        "",
        ":::solution",
        solution,
        ":::",
        ":::::",
        "",
      ]),
    ]);
    if (!unit) throw new Error("未导入零槽配对题");
    const assignment = await assignKernelFixture(
      app,
      { ...world, unitId: unit.id },
      { answerRelease: "after_due", dueAt: "2099-01-01T00:00:00Z" },
    );

    const db = instance.db().$client;
    const stored = z
      .object({ source_md: z.string(), material_refs_json: z.null() })
      .parse(
        db
          .prepare(
            "SELECT source_md,material_refs_json FROM questions WHERE id=?",
          )
          .get(ids.partial),
      );
    const replace = db.prepare(
      "UPDATE questions SET source_md=?,material_refs_json=? WHERE id=?",
    );
    const rejectBrokenMaterial = async () => {
      const rejected = await jsonCall(
        app,
        "/api/teacher/assignments",
        world.teacher,
        "POST",
        {
          title: "错误的配对材料引用",
          unitIds: [unit.id],
          studentIds: [world.studentId],
          executionBackend: "kernel",
          allowRedo: false,
        },
      );
      expect(rejected.status, await rejected.clone().text()).toBe(422);
      expect(await rejected.json()).toMatchObject({
        error: "M04_PRACTICE_INELIGIBLE",
      });
    };
    for (const [source, refs] of [
      [stored.source_md, "无效 JSON"],
      [stored.source_md, "null"],
      [stored.source_md, '[{"slots":"slot-1"}]'],
      [stored.source_md, '[{"material":"missing","slots":"slot-1"}]'],
      [
        stored.source_md.replace(
          "::::options",
          "::ref{material=missing slots=slot-1}\n\n::::options",
        ),
        null,
      ],
      [
        stored.source_md.replace(
          "请配置对应关系。",
          "请配置对应关系。::ref{slots=slot-1}",
        ),
        null,
      ],
    ] as const) {
      replace.run(source, refs, ids.partial);
      try {
        await rejectBrokenMaterial();
      } finally {
        replace.run(stored.source_md, stored.material_refs_json, ids.partial);
      }
    }
    db.prepare(
      "INSERT INTO material_refs (teacher_id, owner_kind, owner_id, material_id, ref_order) SELECT teacher_id, 'question', id, 'unattached-material', 0 FROM questions WHERE id=?",
    ).run(ids.partial);
    try {
      await rejectBrokenMaterial();
    } finally {
      db.prepare(
        "DELETE FROM material_refs WHERE owner_kind='question' AND owner_id=? AND material_id='unattached-material'",
      ).run(ids.partial);
    }

    const opened = await postAssignment(app, assignment, world.ownerCookie);
    expect(opened.status, await opened.clone().text()).toBe(200);
    const attempt = attemptStartOkSchema.parse(await opened.json()).data;
    const path = `/api/student/attempts/${attempt.id}`;
    const privateKeys = [
      "acceptedBlanks",
      "acceptedByQuestion",
      "distractor",
      "questionAnswerRules",
      "scoringKey",
      "teacherReview",
    ];
    const allow = ["answer", "answers", "solutionMd"];
    const readPublic = async (suffix = "") => {
      const response = await jsonCall(app, path + suffix, world.ownerCookie);
      expect(response.status, await response.clone().text()).toBe(200);
      const raw: unknown = await response.json();
      assertNoLeak(raw, { forbid: privateKeys, allow });
      return raw;
    };
    const context = attemptContextOkSchema.parse(
      await readPublic("/context"),
    ).data;
    expect(context).toMatchObject({ materials: [], groups: [] });
    const draft = attemptDraftOkSchema.parse(await readPublic()).data;
    const questions = draft.units.flatMap(({ questions }) => questions);
    expect(questions.map(({ id }) => id)).toEqual(questionIds);
    for (const question of questions) {
      expect(question).toMatchObject({
        matchingOptions: { allowRepeat: withRepeat(question.id), options },
      });
      expect(question).not.toHaveProperty("matchingSlots");
      expect(question).not.toHaveProperty("materialRefs");
    }
    const matching = (pairs: Record<string, string>) =>
      ({ kind: "matching", pairs }) as const;
    const drafts = {
      [ids.partial]: matching({ "slot-2": "opt-2" }),
      [ids.repeat]: matching({ arbitrary: "opt-1", "slot-2": "opt-1" }),
      [ids.empty]: matching({}),
    };
    const save = (id: string, answer: ReturnType<typeof matching>) =>
      jsonCall(app, `${path}/answers/${id}`, world.ownerCookie, "PUT", {
        answer,
        baseRevision: 0,
        mutationId: randomUUID(),
        expectedFrozenAt: attempt.frozenAt,
        questionRevisionId: questions.find((question) => question.id === id)
          ?.questionRevisionId,
      });
    for (const answer of [
      matching({ arbitrary: "unknown" }),
      matching({ arbitrary: "opt-1", "slot-2": "opt-1" }),
    ]) {
      const rejected = await save(ids.partial, answer);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({
        error: "VALIDATION_ERROR",
      });
    }
    for (const [id, answer] of Object.entries(drafts)) {
      const saved = await save(id, answer);
      expect(saved.status, await saved.clone().text()).toBe(200);
      assertNoLeak(await saved.json(), { forbid: privateKeys, allow });
    }
    instance.reopen();
    app = instance.open(false);
    const saved = attemptDraftOkSchema.parse(await readPublic()).data;
    expect(saved.drafts).toEqual(drafts);
    const submit = () =>
      jsonCall(app, path + "/submit", world.ownerCookie, "POST", {
        revisions: questions.map(({ id, questionRevisionId }) => ({
          questionId: id,
          questionRevisionId,
          expectedAnswerRevision: saved.draftRevisions?.[id] ?? 0,
        })),
      });
    const confirmed = await submit();
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    const raw: unknown = await confirmed.json();
    assertNoLeak(raw, { forbid: privateKeys, allow });
    expect(JSON.stringify(raw)).not.toContain(solution);
    const hidden = attemptResultOkSchema.parse(raw).data;
    expect(hidden.answersReleased).toBe(false);
    expect(hidden.attempt.scoreAuto).toBeNull();
    expect(hidden.units.flatMap(({ questions }) => questions)).toEqual(
      questionIds.map((questionId) =>
        expect.objectContaining({
          questionId,
          answer: drafts[questionId] ?? null,
          answered: questionId === ids.partial || questionId === ids.repeat,
          answers: null,
          autoCorrect: null,
          finalCorrect: null,
          teacherComment: null,
        }),
      ),
    );
    expect((await submit()).status).toBe(409);

    const ticket = keyRow
      .extend({ receipt_id: z.string() })
      .parse(
        instance
          .db()
          .$client.prepare(
            "SELECT operation_id,step_attempt_id,slot_id,receipt_id FROM kernel_question_deliveries WHERE attempt_id=?",
          )
          .get(attempt.id),
      );
    const databasePath = join(data.path, BACKUP_KERNEL_DATABASE);
    using kernel = new DatabaseSync(databasePath, { readOnly: true });
    const definition = z
      .object({ definition: z.string() })
      .parse(
        kernel
          .prepare(
            "SELECT p.definition FROM practices p JOIN activities a ON p.id=a.practice_id AND p.version=a.practice_version WHERE a.id=?",
          )
          .get(attempt.id),
      );
    expect(JSON.parse(definition.definition)).toMatchObject({
      questions: questionIds.map((id) =>
        expect.objectContaining({
          id,
          response: "orderedTextBlanks",
          blankCount: 0,
        }),
      ),
      grading: { teacherReview: { questionIds: questionIds.toSorted() } },
    });
    // 内核 v2（迁移 19）起纯人工题不再写无评分键的空评估任务。
    expect(
      kernel
        .prepare("SELECT key_id FROM evaluation_tasks WHERE submission_id=?")
        .get(ticket.receipt_id),
    ).toBeUndefined();
    const runtime = openLearningRuntime({
      databasePath,
      authorizeConfirmationRecovery: (scope) =>
        scope.studentId === world.studentId &&
        scope.activityId === attempt.id &&
        scope.operationId === ticket.operation_id &&
        scope.stepAttemptId === ticket.step_attempt_id,
    });
    try {
      const actor = { role: "student", id: world.studentId } as const;
      assertNoLeak(runtime.read(actor, attempt.id), {
        forbid: privateKeys,
        allow,
      });
      const key = {
        protocolVersion: 1 as const,
        operationId: ticket.operation_id,
        stepAttemptId: ticket.step_attempt_id,
      };
      const recovered = runtime.recoverQuestionDelivery(
        actor,
        attempt.id,
        key,
        "declared",
      );
      expect(recovered.receipt.id).toBe(ticket.receipt_id);
      expect(recovered.assessment).toBe("teacherReview");
      expect(
        recovered.confirmation.questions.map(({ value, revision }) => [
          value,
          revision,
        ]),
      ).toEqual([
        [["slot-2", "opt-2"], 1],
        [["arbitrary", "opt-1", "slot-2", "opt-1"], 1],
        [[], 1],
        [null, 0],
      ]);
      expect(
        runtime.confirmQuestionDelivery(actor, attempt.id, {
          ...key,
          source: "whole",
          slotId: ticket.slot_id,
          questions: recovered.requestQuestions,
        }),
      ).toEqual(recovered.receipt);
    } finally {
      runtime.close();
    }
    const queue = async () => {
      const response = await jsonCall(
        app,
        `/api/teacher/pending-marks?assignmentId=${assignment}`,
        world.teacher,
      );
      expect(response.status).toBe(200);
      return wire(pendingMarkListDataSchema).parse(await response.json()).data
        .marks;
    };
    const pending = await queue();
    expect(pending.map(({ questionId }) => questionId).sort()).toEqual(
      questionIds.toSorted(),
    );
    const teacherView = await jsonCall(
      app,
      `/api/teacher/attempts/${attempt.id}`,
      world.teacher,
    );
    expect(teacherView.status).toBe(200);
    const teacherDetail = teacherAttemptDetailOkSchema.parse(
      await teacherView.json(),
    ).data;
    expect(
      teacherDetail.questions.map(({ gradingPolicy, answers }) => [
        gradingPolicy,
        answers,
      ]),
    ).toEqual(questionIds.map(() => ["manual_only", null]));
    const target = pending.find(({ questionId }) => questionId === ids.partial);
    if (!target) throw new Error("缺少零槽配对待批行");
    const mark = async (request: MarkRequest) => {
      const response = await jsonCall(
        app,
        `/api/teacher/responses/${target.responseId}/mark`,
        world.teacher,
        "POST",
        request,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return wire(markResponseDataSchema).parse(await response.json()).data;
    };
    const comment = "合成零槽配对教师私有评语。";
    const markRequest = {
      mark: "wrong",
      comment,
      baseRevision: 0,
      mutationId: randomUUID(),
    } as const;
    const marked = await mark(markRequest);
    expect(marked).toMatchObject({
      eventId: expect.any(String),
      revision: 1,
      finalCorrect: false,
      pendingCount: 3,
    });
    expect(await mark(markRequest)).toEqual(marked);
    expect(JSON.stringify(await readPublic())).not.toContain(comment);
    const cleared = await mark({
      mark: null,
      comment: null,
      baseRevision: 1,
      mutationId: randomUUID(),
    });
    expect(cleared).toMatchObject({
      eventId: expect.any(String),
      revision: 2,
      finalCorrect: null,
      pendingCount: 4,
    });
    expect((await queue()).map(({ questionId }) => questionId).sort()).toEqual(
      questionIds.toSorted(),
    );
    expect(
      instance
        .db()
        .$client.prepare(
          "SELECT count(*) n FROM attempt_settlements WHERE attempt_id=? AND kind='final'",
        )
        .get(attempt.id),
    ).toEqual({ n: 1 });
  } finally {
    vi.unstubAllEnvs();
    instance.close();
  }
});

it.each([false, true])(
  "普通整卷无参考排序保留零槽位并进入原教师待批队列，混卷=%s",
  async (mixed) => {
    using data = mkdtempDisposableSync(join(tmpdir(), "m05-zero-ordering-"));
    const instance = openInstance(data.path);
    try {
      let app = instance.open(false);
      const world = await setupAssignment(app);
      vi.stubEnv("NEW_CONTENT_ENABLED", "true");
      const ids = { empty: "m05-zero-empty", missing: "m05-zero-missing" };
      const questionIds = Object.values(ids);
      const orderingItems = [
        { id: "a", text: "条目甲。", fixedPosition: null },
        { id: "b", text: "条目乙。", fixedPosition: null },
      ];
      const orderingStructure = { orderingItems, sortableCount: 0 };
      const empty = { kind: "ordering", sequence: [] };
      const solution = "无参考排序详解。";
      const {
        units: [unit],
      } = await importQuestions(app, world.teacher, undefined, [
        ...(mixed ? choices.slice(0, 6) : []),
        ...questionIds.flatMap((id) => [
          `::::question{id=${id} type=ordering}`,
          "请排序。",
          ...orderingItems.flatMap(({ id, text }) => [
            `:::item{id=${id}}`,
            text,
            ":::",
          ]),
          ":::solution",
          solution,
          ":::",
          "::::",
          "",
        ]),
      ]);
      if (!unit) throw new Error("未导入无参考排序题");
      if (!mixed) {
        const db = instance.db().$client;
        const stored = z
          .object({ source_md: z.string(), answers_json: z.null() })
          .parse(
            db
              .prepare(
                "SELECT source_md,answers_json FROM questions WHERE id=?",
              )
              .get(ids.empty),
          );
        const replace = db.prepare(
          "UPDATE questions SET source_md=?,answers_json=? WHERE id=?",
        );
        for (const [source, answers] of [
          [stored.source_md, "无效 JSON"],
          [stored.source_md, "null"],
          [
            stored.source_md,
            JSON.stringify({ kind: "ordering", sequence: ["a"] }),
          ],
          [
            stored.source_md.replace(
              ":::solution",
              ":::answer\n:::\n\n:::solution",
            ),
            null,
          ],
          [
            stored.source_md.replace(
              ":::solution",
              ":::answer\n未知项\n:::\n\n:::solution",
            ),
            null,
          ],
        ] as const) {
          replace.run(source, answers, ids.empty);
          try {
            const assigned = await jsonCall(
              app,
              "/api/teacher/assignments",
              world.teacher,
              "POST",
              {
                title: "带坏参考的排序",
                unitIds: [unit.id],
                studentIds: [world.studentId],
                executionBackend: "kernel",
                allowRedo: false,
              },
            );
            expect(assigned.status, await assigned.clone().text()).toBe(422);
            expect(await assigned.json()).toMatchObject({
              error: "M04_PRACTICE_INELIGIBLE",
            });
          } finally {
            replace.run(stored.source_md, stored.answers_json, ids.empty);
          }
        }
      }
      const selfReview = await jsonCall(
        app,
        "/api/teacher/settings/practice-feedback",
        world.teacher,
        "PUT",
        { studentSelfReviewEnabled: true },
      );
      expect(selfReview.status).toBe(200);
      const assignment = await assignKernelFixture(
        app,
        { ...world, unitId: unit.id },
        { answerRelease: "after_due", dueAt: "2099-01-01T00:00:00Z" },
      );
      const opened = await postAssignment(app, assignment, world.ownerCookie);
      expect(opened.status, await opened.clone().text()).toBe(200);
      const attempt = attemptStartOkSchema.parse(await opened.json()).data;
      const path = `/api/student/attempts/${attempt.id}`;
      const privateKeys = [
        "acceptedBlanks",
        "acceptedByQuestion",
        "distractor",
        "questionAnswerRules",
        "scoringKey",
      ];
      const readDraft = async () => {
        const response = await jsonCall(app, path, world.ownerCookie);
        expect(response.status, await response.clone().text()).toBe(200);
        const raw: unknown = await response.json();
        assertNoLeak(raw, { forbid: privateKeys });
        return attemptDraftOkSchema.parse(raw).data;
      };
      const draft = await readDraft();
      const questions = draft.units.flatMap(({ questions }) => questions);
      const ordering = <Row extends { questionId: string }>(
        rows: readonly Row[],
      ) => rows.filter(({ questionId }) => questionIds.includes(questionId));
      expect(
        questions
          .filter(({ id }) => questionIds.includes(id))
          .map(({ id, orderingItems, sortableCount }) => ({
            id,
            orderingItems,
            sortableCount,
          })),
      ).toEqual(questionIds.map((id) => ({ id, ...orderingStructure })));
      const save = (id: string, answer: object, cookie = world.ownerCookie) =>
        jsonCall(app, `${path}/answers/${id}`, cookie, "PUT", {
          answer,
          baseRevision: 0,
          mutationId: randomUUID(),
          expectedFrozenAt: attempt.frozenAt,
          questionRevisionId: questions.find((question) => question.id === id)
            ?.questionRevisionId,
        });
      expect((await save(ids.empty, empty, world.otherCookie)).status).toBe(
        403,
      );
      for (const answer of [
        { kind: "ordering", sequence: ["a"] },
        { kind: "ordering", sequence: ["unknown"] },
        { kind: "choice", index: 0 },
      ]) {
        const rejected = await save(ids.empty, answer);
        expect(rejected.status, await rejected.clone().text()).toBe(400);
        expect(await rejected.json()).toMatchObject({
          error: "VALIDATION_ERROR",
        });
      }
      expect((await readDraft()).drafts).toEqual({});
      const saved = await save(ids.empty, empty);
      expect(saved.status, await saved.clone().text()).toBe(200);
      expect(await saved.json()).toMatchObject({ data: { revision: 1 } });
      const choice = { kind: "choice", index: 0 };
      if (mixed) expect((await save("k17-one", choice)).status).toBe(200);
      instance.reopen();
      app = instance.open(false);
      const resumed = await readDraft();
      expect(resumed.drafts).toEqual({
        [ids.empty]: empty,
        ...(mixed && { "k17-one": choice }),
      });
      expect(resumed.draftRevisions).toMatchObject({ [ids.empty]: 1 });
      expect(resumed.draftRevisions?.[ids.missing] ?? 0).toBe(0);

      const submit = () =>
        jsonCall(app, `${path}/submit`, world.ownerCookie, "POST", {
          revisions: questions.map(({ id, questionRevisionId }) => ({
            questionId: id,
            questionRevisionId,
            expectedAnswerRevision: id === ids.missing ? 0 : 1,
          })),
        });
      const submitted = await submit();
      expect(submitted.status, await submitted.clone().text()).toBe(200);
      const raw: unknown = await submitted.json();
      const allow = ["answer", "answers", "solutionMd"];
      assertNoLeak(raw, { forbid: privateKeys, allow });
      const hidden = attemptResultOkSchema.parse(raw).data;
      expect(hidden.answersReleased).toBe(false);
      const hiddenRows = ordering(
        hidden.units.flatMap(({ questions }) => questions),
      );
      expect(
        hiddenRows.map(({ questionId, answer }) => [questionId, answer]),
      ).toEqual([
        [ids.empty, empty],
        [ids.missing, null],
      ]);
      for (const row of hiddenRows)
        expect(row).toMatchObject({
          snapshot: orderingStructure,
          answers: null,
          solutionMd: null,
          answered: false,
          autoCorrect: null,
          finalCorrect: null,
          gradingPolicy: null,
        });
      expect((await submit()).status).toBe(409);
      expect((await save(ids.missing, empty)).status).toBe(409);

      instance.reopen();
      app = instance.open(false);
      expect(await finishedResult(app, path, world.ownerCookie)).toEqual({
        ...hidden,
        releaseCheckedAt: expect.any(String),
      });
      expect((await jsonCall(app, path, world.otherCookie)).status).toBe(403);
      const db = instance.db().$client;
      const [ticket] = keyRow
        .extend({ receipt_id: z.string().min(1) })
        .array()
        .length(1)
        .parse(
          db
            .prepare(
              "SELECT operation_id, step_attempt_id, slot_id, receipt_id FROM kernel_question_deliveries WHERE attempt_id=?",
            )
            .all(attempt.id),
        );
      if (!ticket) throw new Error("缺少无参考排序回执");
      const databasePath = join(data.path, BACKUP_KERNEL_DATABASE);
      const runtime = openLearningRuntime({
        databasePath,
        authorizeConfirmationRecovery: (identity) =>
          identity.studentId === world.studentId &&
          identity.activityId === attempt.id &&
          identity.stepAttemptId === ticket.step_attempt_id &&
          identity.operationId === ticket.operation_id,
      });
      try {
        const actor = { role: "student", id: world.studentId } as const;
        assertNoLeak(runtime.read(actor, attempt.id), {
          forbid: privateKeys,
          allow,
        });
        const key = {
          protocolVersion: 1 as const,
          operationId: ticket.operation_id,
          stepAttemptId: ticket.step_attempt_id,
        };
        const recovered = runtime.recoverQuestionDelivery(
          actor,
          attempt.id,
          key,
          "declared",
        );
        expect(recovered.receipt.id).toBe(ticket.receipt_id);
        expect(
          runtime.confirmQuestionDelivery(actor, attempt.id, {
            ...key,
            source: "whole",
            slotId: ticket.slot_id,
            questions: recovered.requestQuestions,
          }),
        ).toEqual(recovered.receipt);
        expect(() =>
          runtime.recoverQuestionDelivery(
            { role: "student", id: world.otherStudentId },
            attempt.id,
            key,
            "declared",
          ),
        ).toThrow();
        expect(
          ordering(recovered.confirmation.questions).map(
            ({ questionId, value, revision }) => [questionId, value, revision],
          ),
        ).toEqual([
          [ids.empty, [], 1],
          [ids.missing, null, 0],
        ]);
        expect(recovered.assessment).toBe(
          mixed ? "automatic" : "teacherReview",
        );
        expect(recovered.review?.questions).toEqual(
          questionIds.map((questionId) => ({
            questionId,
            questionVersion: 1,
            status: "needsReview",
          })),
        );
        if (recovered.assessment === "automatic")
          expect(recovered.evaluation.questions).toEqual([
            {
              questionId: "k17-one",
              questionVersion: 1,
              result: { status: "judged", correct: true },
            },
          ]);
      } finally {
        runtime.close();
      }
      using kernel = new DatabaseSync(databasePath, { readOnly: true });
      const parseDefinition = (value: unknown): unknown =>
        JSON.parse(
          z.object({ definition: z.string() }).parse(value).definition,
        );
      const practice = parseDefinition(
        kernel
          .prepare(
            "SELECT p.definition FROM practices p JOIN activities a ON p.id=a.practice_id AND p.version=a.practice_version WHERE a.id=?",
          )
          .get(attempt.id),
      );
      expect(practice).toMatchObject({
        grading: { teacherReview: { questionIds } },
        questionAnswerRules: Object.fromEntries(
          questionIds.map((id) => [
            id,
            { id: "ownclass-ordering-sequence", version: 1 },
          ]),
        ),
        questions: expect.arrayContaining(
          questionIds.map((id) =>
            expect.objectContaining({
              id,
              response: "orderedTextBlanks",
              blankCount: 0,
            }),
          ),
        ),
      });
      const scoringKey = kernel
        .prepare(
          "SELECT k.definition FROM scoring_keys k JOIN evaluation_tasks e ON k.id=e.key_id AND k.version=e.key_version WHERE e.submission_id=?",
        )
        .get(ticket.receipt_id);
      if (mixed)
        expect(parseDefinition(scoringKey)).toEqual({
          id: expect.any(String),
          version: 1,
          acceptedByQuestion: {
            "k17-one": { response: "choice", acceptedChoice: "0" },
          },
        });
      else {
        expect(practice).not.toHaveProperty("grading.assessment");
        expect(scoringKey).toBeUndefined();
      }

      const teacherPath = `/api/teacher/attempts/${attempt.id}`;
      const teacherView = await jsonCall(app, teacherPath, world.teacher);
      expect(teacherView.status, await teacherView.clone().text()).toBe(200);
      const teacher = teacherAttemptDetailOkSchema.parse(
        await teacherView.json(),
      ).data;
      expect(teacher).toMatchObject({
        pendingCount: 2,
        selfReviewPendingCount: 0,
      });
      const teacherRows = ordering(teacher.questions);
      expect(
        teacherRows.map(
          ({ questionId, answer, answers, answered, gradingPolicy }) => ({
            questionId,
            answer,
            answers,
            answered,
            gradingPolicy,
          }),
        ),
      ).toEqual([
        {
          questionId: ids.empty,
          answer: empty,
          answers: null,
          answered: false,
          gradingPolicy: "manual_only",
        },
        {
          questionId: ids.missing,
          answer: null,
          answers: null,
          answered: false,
          gradingPolicy: "manual_only",
        },
      ]);
      const queue = async () => {
        const response = await jsonCall(
          app,
          `/api/teacher/pending-marks?assignmentId=${assignment}`,
          world.teacher,
        );
        expect(response.status, await response.clone().text()).toBe(200);
        return wire(pendingMarkListDataSchema)
          .parse(await response.json())
          .data.marks.map(({ questionId }) => questionId)
          .sort();
      };
      expect(await queue()).toEqual(questionIds);
      const [first, second] = teacherRows;
      if (!first?.responseId || !second?.responseId)
        throw new Error("缺少教师待批行");
      const mark = (
        responseId: string,
        request: MarkRequest,
        teacher = world.teacher,
      ) =>
        jsonCall(
          app,
          `/api/teacher/responses/${responseId}/mark`,
          teacher,
          "POST",
          request,
        );
      const checkedMark = async (responseId: string, request: MarkRequest) => {
        const response = await mark(responseId, request);
        expect(response.status, await response.clone().text()).toBe(200);
        return wire(markResponseDataSchema).parse(await response.json()).data;
      };
      const wrong = {
        mark: "wrong",
        comment: null,
        baseRevision: 0,
        mutationId: randomUUID(),
      } as const;
      const comment = "排序人工评语。";
      const correct = {
        ...wrong,
        mark: "correct",
        comment,
        mutationId: randomUUID(),
      } as const;
      expect(
        (await mark(first.responseId, wrong, world.otherCookie)).status,
      ).toBe(401);
      if (!mixed) {
        const loginName = "异域排序教师";
        const created = await jsonCall(
          app,
          "/api/admin/teachers",
          world.teacher,
          "POST",
          { loginName },
        );
        expect(created.status, await created.clone().text()).toBe(201);
        const { initialPassword: password } = adminTeacherCreateOkSchema.parse(
          await created.json(),
        ).data;
        const login = await jsonCall(
          app,
          "/api/public/teacher/login",
          "",
          "POST",
          {
            loginName,
            password,
          },
        );
        expect(login.status, await login.clone().text()).toBe(200);
        const foreign = `tutor_session=${extractSessionToken(login)}`;
        expect((await jsonCall(app, teacherPath, foreign)).status).toBe(404);
        expect((await mark(first.responseId, wrong, foreign)).status).toBe(404);
      }
      const marked = await checkedMark(first.responseId, wrong);
      expect(marked).toMatchObject({ finalCorrect: false, pendingCount: 1 });
      expect(await checkedMark(first.responseId, wrong)).toEqual(marked);
      const reused = await mark(first.responseId, {
        ...wrong,
        mark: "correct",
      });
      expect(reused.status).toBe(409);
      expect(await reused.json()).toMatchObject({
        error: "OPERATION_CONFLICT",
      });
      const revise = {
        ...correct,
        comment: null,
        baseRevision: 1,
        mutationId: randomUUID(),
      };
      const stale = await mark(first.responseId, {
        ...revise,
        baseRevision: 0,
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: "VERDICT_CONFLICT" });
      expect(await queue()).toEqual([ids.missing]);
      expect(await checkedMark(second.responseId, correct)).toMatchObject({
        attemptStatus: "graded",
        pendingCount: 0,
        scoreFinal: mixed ? 67 : 50,
      });
      expect(await checkedMark(first.responseId, revise)).toMatchObject({
        revision: 2,
        finalCorrect: true,
        scoreFinal: 100,
      });
      expect(await queue()).toEqual([]);
      const withheld = await finishedResult(app, path, world.ownerCookie);
      expect(withheld.answersReleased).toBe(false);
      expect(JSON.stringify(withheld)).not.toContain(comment);
      const clear = {
        mark: null,
        comment: null,
        baseRevision: 2,
        mutationId: randomUUID(),
      };
      expect(await checkedMark(first.responseId, clear)).toMatchObject({
        revision: 3,
        finalCorrect: null,
        attemptStatus: "submitted",
        pendingCount: 1,
        scoreFinal: null,
      });
      expect(await queue()).toEqual([ids.empty]);
      const published = await jsonCall(
        app,
        `/api/teacher/assignments/${assignment}`,
        world.teacher,
        "PATCH",
        { answerRelease: "on_submit" },
      );
      expect(published.status, await published.clone().text()).toBe(200);
      const releasedResponse = await jsonCall(app, path, world.ownerCookie);
      expect(
        releasedResponse.status,
        await releasedResponse.clone().text(),
      ).toBe(200);
      const releasedRaw: unknown = await releasedResponse.json();
      assertNoLeak(releasedRaw, { forbid: privateKeys, allow });
      const released = attemptResultOkSchema.parse(releasedRaw).data;
      expect(released.answersReleased).toBe(true);
      expect(released.attempt.scoreAuto).toBe(mixed ? 100 : null);
      expect(
        ordering(released.units.flatMap(({ questions }) => questions)),
      ).toMatchObject([
        {
          answer: empty,
          answers: null,
          answered: false,
          gradingPolicy: "manual_only",
          solutionMd: solution,
          finalCorrect: null,
        },
        {
          answer: null,
          answers: null,
          answered: false,
          gradingPolicy: "manual_only",
          solutionMd: solution,
          finalCorrect: true,
          teacherComment: comment,
        },
      ]);
      const review = await jsonCall(
        app,
        `${path}/questions/${ids.empty}/self-review`,
        world.ownerCookie,
        "POST",
        { verdict: "correct", baseRevision: 0, mutationId: randomUUID() },
      );
      expect(review.status).toBe(403);
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM attempt_settlements WHERE attempt_id=? AND kind='final'",
          )
          .get(attempt.id),
      ).toEqual({ n: 1 });
    } finally {
      vi.unstubAllEnvs();
      instance.close();
    }
  },
);

it.each([true, false])(
  "普通整卷排序经原入口保存和确认冻结序列，自评开启=%s",
  async (selfReview) => {
    using data = mkdtempDisposableSync(join(tmpdir(), "m05-ordering-host-"));
    const instance = openInstance(data.path);
    try {
      let app = instance.open(false);
      const world = await setupAssignment(app);
      vi.stubEnv("NEW_CONTENT_ENABLED", "true");
      const ids = {
        partial: "m05-ordering-partial",
        complete: "m05-ordering-complete",
        empty: "m05-ordering-empty",
        missing: "m05-ordering-missing",
      };
      const reference = {
        kind: "ordering",
        sequence: ["first", "fixed", "third"],
      };
      const partial = { kind: "ordering", sequence: ["third", "fixed"] };
      const empty = { kind: "ordering", sequence: [] };
      const solution = "合成排序的私有详解。";
      const orderingItems = [
        { id: "first", text: "甲。", fixedPosition: null },
        { id: "fixed", text: "乙。", fixedPosition: 2 },
        { id: "third", text: "丙。", fixedPosition: null },
        { id: "decoy", text: "无关句。", fixedPosition: null },
      ];
      const questionIds = Object.values(ids);
      const {
        units: [unit],
      } = await importQuestions(app, world.teacher, undefined, [
        ...(selfReview ? [] : choices.slice(0, 6)),
        ...questionIds.flatMap((id) => [
          `::::question{id=${id} type=ordering}`,
          "把下列语句排成一段。",
          ":::item{id=first}",
          "甲。",
          ":::",
          ":::item{id=fixed fixed=true}",
          "乙。",
          ":::",
          ":::item{id=third}",
          "丙。",
          ":::",
          ":::item{id=decoy distractor=true}",
          "无关句。",
          ":::",
          ":::answer",
          ...reference.sequence,
          ":::",
          ":::solution",
          solution,
          ":::",
          "::::",
          "",
        ]),
      ]);
      if (!unit) throw new Error("未导入合成排序题");
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
        { answerRelease: "after_due", dueAt: "2099-01-01T00:00:00Z" },
      );
      const opened = await postAssignment(app, assignment, world.ownerCookie);
      expect(opened.status, await opened.clone().text()).toBe(200);
      const attempt = attemptStartOkSchema.parse(await opened.json()).data;
      expect((await setReview(!selfReview)).status).toBe(200);
      const path = `/api/student/attempts/${attempt.id}`;
      const privateKeys = [
        "acceptedBlanks",
        "acceptedByQuestion",
        "distractor",
        "questionAnswerRules",
        "scoringKey",
      ];
      const assertPrivate = (raw: unknown, result = false) => {
        assertNoLeak(raw, {
          forbid: privateKeys,
          ...(result && { allow: ["answer", "answers", "solutionMd"] }),
        });
        const body = JSON.stringify(raw);
        expect(body).not.toContain("distractor");
        expect(body).not.toContain(solution);
      };
      const readDraft = async () => {
        const read = await jsonCall(app, path, world.ownerCookie);
        expect(read.status, await read.clone().text()).toBe(200);
        const raw: unknown = await read.json();
        assertPrivate(raw);
        return attemptDraftOkSchema.parse(raw).data;
      };
      const draft = await readDraft();
      const questions = draft.units.flatMap(({ questions }) => questions);
      expect(draft.drafts).toEqual({});
      for (const question of questions.filter(({ id }) =>
        questionIds.includes(id),
      )) {
        expect(question).toMatchObject({ orderingItems, sortableCount: 2 });
      }
      const save = (
        id: string,
        sequence: string[],
        cookie = world.ownerCookie,
        expectedFrozenAt = attempt.frozenAt,
      ) =>
        jsonCall(app, `${path}/answers/${id}`, cookie, "PUT", {
          answer: { kind: "ordering", sequence },
          baseRevision: 0,
          mutationId: randomUUID(),
          expectedFrozenAt,
          questionRevisionId: questions.find((q) => q.id === id)
            ?.questionRevisionId,
        });
      expect(
        (await save(ids.partial, ["unknown"], world.otherCookie)).status,
      ).toBe(403);
      expect(
        (
          await save(
            ids.partial,
            ["unknown"],
            world.ownerCookie,
            "2000-01-01T00:00:00Z",
          )
        ).status,
      ).toBe(409);
      for (const sequence of [
        ["unknown"],
        ["third", "third"],
        ["decoy"],
        ["fixed"],
      ]) {
        const invalid = await save(ids.partial, sequence);
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({
          error: "VALIDATION_ERROR",
        });
      }
      expect((await readDraft()).drafts).toEqual({});
      for (const [id, answer] of [
        [ids.partial, partial],
        [ids.complete, reference],
        [ids.empty, empty],
      ] as const) {
        const response = await save(id, answer.sequence);
        expect(response.status, await response.clone().text()).toBe(200);
      }
      instance.reopen();
      app = instance.open(false);
      const saved = await readDraft();
      expect(saved.drafts).toEqual({
        [ids.partial]: partial,
        [ids.complete]: reference,
        [ids.empty]: empty,
      });
      const submit = () =>
        jsonCall(app, `${path}/submit`, world.ownerCookie, "POST", {
          revisions: questions.map(({ id, questionRevisionId }) => ({
            questionId: id,
            questionRevisionId,
            expectedAnswerRevision: saved.draftRevisions?.[id] ?? 0,
          })),
        });
      const confirmed = await submit();
      expect(confirmed.status, await confirmed.clone().text()).toBe(200);
      const raw: unknown = await confirmed.json();
      assertPrivate(raw, true);
      const hidden = attemptResultOkSchema.parse(raw).data;
      expect(hidden.answersReleased).toBe(false);
      const orderingRows = (result: typeof hidden) =>
        result.units
          .flatMap(({ questions }) => questions)
          .filter(({ questionId }) => questionIds.includes(questionId));
      expect(
        orderingRows(hidden).map(({ questionId, answer, answered }) => [
          questionId,
          answer,
          answered,
        ]),
      ).toEqual([
        [ids.partial, partial, true],
        [ids.complete, reference, true],
        [ids.empty, empty, false],
        [ids.missing, null, false],
      ]);
      for (const row of orderingRows(hidden)) {
        expect(row).toMatchObject({
          snapshot: { orderingItems, sortableCount: 2 },
          answers: null,
          solutionMd: null,
          gradingPolicy: null,
          autoCorrect: null,
          finalCorrect: null,
        });
      }
      expect((await submit()).status).toBe(409);
      expect((await save(ids.partial, ["third"])).status).toBe(409);

      instance.reopen();
      app = instance.open(false);
      expect((await jsonCall(app, path, world.otherCookie)).status).toBe(403);
      expect(await finishedResult(app, path, world.ownerCookie)).toEqual({
        ...hidden,
        releaseCheckedAt: expect.any(String),
      });
      const sql = instance.db().$client;
      const [ticket] = keyRow
        .extend({ receipt_id: z.string().min(1) })
        .array()
        .length(1)
        .parse(
          sql
            .prepare(
              "SELECT operation_id, step_attempt_id, slot_id, receipt_id FROM kernel_question_deliveries WHERE attempt_id=?",
            )
            .all(attempt.id),
        );
      if (!ticket) throw new Error("缺少排序确认回执");
      expect(
        sql
          .prepare(
            "SELECT count(*) AS n FROM attempt_settlements WHERE attempt_id=? AND kind='final'",
          )
          .get(attempt.id),
      ).toEqual({ n: 1 });

      const databasePath = join(data.path, BACKUP_KERNEL_DATABASE);
      const runtime = openLearningRuntime({
        databasePath,
        authorizeConfirmationRecovery: (identity) =>
          identity.studentId === world.studentId &&
          identity.activityId === attempt.id &&
          identity.stepAttemptId === ticket.step_attempt_id &&
          identity.operationId === ticket.operation_id,
      });
      try {
        const actor = { role: "student", id: world.studentId } as const;
        const view = runtime.read(actor, attempt.id);
        assertPrivate(view, true);
        const recovery = runtime.recoverQuestionDelivery(actor, attempt.id, {
          protocolVersion: 1,
          operationId: ticket.operation_id,
          stepAttemptId: ticket.step_attempt_id,
        });
        assertPrivate(recovery);
        expect(recovery.receipt.id).toBe(ticket.receipt_id);
        expect(
          recovery.confirmation.questions
            .filter(({ questionId }) => questionIds.includes(questionId))
            .map(({ questionId, value, revision }) => [
              questionId,
              value,
              revision,
            ]),
        ).toEqual([
          [ids.partial, partial.sequence, 1],
          [ids.complete, reference.sequence, 1],
          [ids.empty, [], 1],
          [ids.missing, null, 0],
        ]);
        if (recovery.evaluation.status !== "evaluated")
          throw new Error("内核评估须已在交卷时完成");
        expect(
          recovery.evaluation.questions
            .filter(({ questionId }) => questionIds.includes(questionId))
            .map(({ result }) => result),
        ).toEqual(questionIds.map(() => ({ status: "needsReview" })));
        expect(() =>
          runtime.recoverQuestionDelivery(actor, attempt.id, {
            protocolVersion: 1,
            operationId: randomUUID(),
            stepAttemptId: ticket.step_attempt_id,
          }),
        ).toThrow();
      } finally {
        runtime.close();
      }
      using kernelDb = new DatabaseSync(databasePath, { readOnly: true });
      const parseDefinition = (row: unknown): unknown =>
        JSON.parse(z.object({ definition: z.string() }).parse(row).definition);
      expect(
        parseDefinition(
          kernelDb
            .prepare(
              "SELECT p.definition FROM practices p JOIN activities a ON p.id=a.practice_id AND p.version=a.practice_version WHERE a.id=?",
            )
            .get(attempt.id),
        ),
      ).toMatchObject({
        questionAnswerRules: Object.fromEntries(
          questionIds.map((id) => [
            id,
            { id: "ownclass-ordering-sequence", version: 1 },
          ]),
        ),
      });
      const key = parseDefinition(
        kernelDb
          .prepare(
            "SELECT k.definition FROM scoring_keys k JOIN evaluation_tasks e ON k.id=e.key_id AND k.version=e.key_version WHERE e.submission_id=?",
          )
          .get(ticket.receipt_id),
      );
      expect(
        z
          .object({ acceptedByQuestion: z.record(z.string(), z.unknown()) })
          .parse(key).acceptedByQuestion,
      ).toEqual({
        ...Object.fromEntries(
          questionIds.map((id) => [
            id,
            {
              response: "orderedTextBlanks",
              acceptedBlanks: reference.sequence.map((item) => [item]),
            },
          ]),
        ),
        ...(selfReview
          ? {}
          : { "k17-one": { response: "choice", acceptedChoice: "0" } }),
      });
      expect(
        kernelDb
          .prepare(
            "SELECT unit_id FROM performances WHERE submission_id=? ORDER BY unit_id",
          )
          .all(ticket.receipt_id),
      ).toEqual(
        [ids.complete, ids.partial].map((id) => ({
          unit_id: `question:${id}`,
        })),
      );

      const teacherView = await jsonCall(
        app,
        `/api/teacher/attempts/${attempt.id}`,
        world.teacher,
      );
      expect(teacherView.status, await teacherView.clone().text()).toBe(200);
      const teacher = teacherAttemptDetailOkSchema.parse(
        await teacherView.json(),
      ).data;
      expect(teacher).toMatchObject({
        pendingCount: selfReview ? 0 : 4,
        selfReviewPendingCount: selfReview ? 4 : 0,
      });
      const gradingPolicy = selfReview ? "reference_self" : "manual_only";
      const teacherRow = teacher.questions.find(
        ({ questionId }) => questionId === ids.partial,
      );
      expect(teacherRow).toMatchObject({
        answer: partial,
        answers: reference,
        autoCorrect: null,
        finalCorrect: null,
        gradingPolicy,
      });
      const reviewPath = `${path}/questions/${ids.partial}/self-review`;
      const review = (cookie: string) =>
        jsonCall(app, reviewPath, cookie, "POST", {
          verdict: "correct",
          baseRevision: 0,
          mutationId: randomUUID(),
        });
      if (selfReview) {
        const withheld = await review(world.ownerCookie);
        expect(withheld.status).toBe(403);
        expect(await withheld.json()).toMatchObject({
          error: "SELF_REVIEW_NOT_RELEASED",
        });
      }
      const publish = await jsonCall(
        app,
        `/api/teacher/assignments/${assignment}`,
        world.teacher,
        "PATCH",
        { answerRelease: "on_submit" },
      );
      expect(publish.status, await publish.clone().text()).toBe(200);
      const readReleased = await jsonCall(app, path, world.ownerCookie);
      expect(readReleased.status).toBe(200);
      const rawReleased: unknown = await readReleased.json();
      const released = attemptResultOkSchema.parse(rawReleased).data;
      expect(released.answersReleased).toBe(true);
      expect(released.attempt.scoreAuto).toBe(selfReview ? null : 0);
      assertNoLeak(rawReleased, {
        forbid: privateKeys,
        allow: ["answer", "answers", "solutionMd"],
      });
      for (const row of orderingRows(released)) {
        expect(row).toMatchObject({
          snapshot: { orderingItems, sortableCount: 2 },
          answers: reference,
          solutionMd: solution,
          gradingPolicy,
          autoCorrect: null,
          finalCorrect: null,
        });
      }
      expect((await review(world.otherCookie)).status).toBe(403);
      if (selfReview) {
        const reviewed = await review(world.ownerCookie);
        expect(reviewed.status, await reviewed.clone().text()).toBe(200);
        expect(
          wire(selfReviewDataSchema).parse(await reviewed.json()).data
            .effective,
        ).toEqual({ source: "self", value: true });
      } else {
        const queue = await jsonCall(
          app,
          `/api/teacher/pending-marks?assignmentId=${assignment}`,
          world.teacher,
        );
        expect(queue.status, await queue.clone().text()).toBe(200);
        const marks = wire(pendingMarkListDataSchema).parse(await queue.json())
          .data.marks;
        expect(marks.map(({ questionId }) => questionId).sort()).toEqual(
          questionIds.toSorted(),
        );
        if (!teacherRow?.responseId) throw new Error("缺少冻结人工评阅行");
        const mark = await jsonCall(
          app,
          `/api/teacher/responses/${teacherRow.responseId}/mark`,
          world.teacher,
          "POST",
          {
            mark: "wrong",
            comment: "合成排序人工批改",
            mutationId: randomUUID(),
            baseRevision: 0,
          },
        );
        expect(mark.status, await mark.clone().text()).toBe(200);
        expect(
          wire(markResponseDataSchema).parse(await mark.json()).data
            .finalCorrect,
        ).toBe(false);
      }
    } finally {
      vi.unstubAllEnvs();
      instance.close();
    }
  },
);
