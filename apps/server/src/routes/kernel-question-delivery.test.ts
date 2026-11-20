import { createHash, randomUUID } from "node:crypto";
import { mkdtempDisposableSync } from "node:fs";
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
  hintOpenOkSchema,
  importCommitDataSchema,
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
import { extractSessionToken } from "../test/note-world.ts";

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
    const markOk = async (request: MarkRequest) => {
      const response = await mark(request);
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
    const wrongNeighbor = await mark(
      { ...wrong, mutationId: randomUUID() },
      neighborMarkPath,
    );
    expect(wrongNeighbor.status).toBe(503);
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
