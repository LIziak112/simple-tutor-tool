import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  attemptContextSnapshotEntrySchema,
  BACKUP_KERNEL_DATABASE,
  frozenGradingPolicySchema,
  singleChoiceScoringSourceSchema,
  wrongPracticeScopeSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { type Attempt, attempts } from "../db/schema.ts";
import { kernelWrongOpenings } from "../db/schema-kernel-question-delivery.ts";
import { insertFrozenResponse } from "./attempt-freeze.ts";
import { WRONG_PRACTICE_TITLE } from "./attempt-rows.ts";
import { canInitializeKernelStorage } from "./kernel-assignment-freeze.ts";
import {
  kernelMaterialPublication,
  matchesKernelMaterialInputs,
} from "./kernel-assignment-publication.ts";
import {
  ensureKernelRuntimeStorage,
  type KernelRuntime,
  kernelAttemptUnavailable,
  withKernelRuntime,
} from "./kernel-assignment-runtime.ts";
import {
  deliveryPolicy,
  wrongOpeningOperation,
  wrongOpeningPractice,
  wrongOpeningVersion,
} from "./kernel-question-delivery-binding.ts";
import { questionDeliveryPublication } from "./kernel-question-delivery-publication.ts";
import { readQuestionDeliveryFacts } from "./kernel-question-delivery-recovery.ts";
import { freezeAttemptContextSnapshotsWithin } from "./material-repository.ts";
import { newDraftAttempt } from "./new-draft-attempt.ts";
import { getPracticeFeedbackSettings } from "./practice-feedback-settings-service.ts";
import { questionSnapshotOf } from "./snapshot.ts";
import { studentTeacherIdOf } from "./student-course-service.ts";

const draftSchema = z.strictObject({
  scope: wrongPracticeScopeSchema.optional(),
  context: z.array(attemptContextSnapshotEntrySchema),
  responses: z
    .array(
      z.strictObject({
        questionId: z.string(),
        questionVersion: z.int().positive(),
        questionSnapshotJson: z.string(),
        gradingPolicy: frozenGradingPolicySchema,
      }),
    )
    .min(1),
});

export type KernelWrongOpeningDraft = z.infer<typeof draftSchema>;
type Opening = typeof kernelWrongOpenings.$inferSelect;

const needsStorage = Symbol("错题重练须先初始化内核存储");

/** 空库初始化先于开卷预留。丢失已有引用的内核库时只报错。 */
export function withWrongKernelStorage<T>(
  db: Db,
  dataDir: string | undefined,
  reserve: () => T,
): T {
  try {
    return reserve();
  } catch (error) {
    if (error !== needsStorage || dataDir === undefined) throw error;
    ensureKernelRuntimeStorage(db, dataDir, canInitializeKernelStorage(db));
    return reserve();
  }
}

function choiceRows(draft: KernelWrongOpeningDraft) {
  return draft.responses.flatMap((row) => {
    const question = questionSnapshotOf(row.questionSnapshotJson);
    return question?.id === row.questionId &&
      row.gradingPolicy === "auto" &&
      singleChoiceScoringSourceSchema.safeParse(question).success
      ? [{ question, questionVersion: row.questionVersion }]
      : [];
  });
}

export function reserveKernelWrongOpening(
  db: Db,
  dataDir: string,
  attempt: Attempt,
  teacherId: string | null,
  draft: KernelWrongOpeningDraft,
): boolean {
  if (
    teacherId === null ||
    attempt.practiceWorkflowVersion !== 1 ||
    attempt.feedbackMode !== "after_attempt" ||
    draft.scope?.kind === "ai" ||
    getPracticeFeedbackSettings(db, teacherId).practiceFeedbackPolicy !==
      "after_attempt"
  )
    return false;
  const rows = choiceRows(draft);
  if (rows.length !== draft.responses.length) return false;
  const materials = draft.context.filter((entry) => entry.kind === "material");
  if (
    new Set(materials.map(({ sourceId }) => sourceId)).size !==
      materials.length ||
    materials.some(({ snapshot }) => snapshot.contentMd.trim() === "")
  )
    return false;
  const { materialInputs, materialDefinitions } = kernelMaterialPublication(
    teacherId,
    draft.context,
    rows.map(({ question }) => question),
  );
  const publication = {
    ...materialDefinitions,
    ...questionDeliveryPublication(
      { id: wrongOpeningPractice(attempt.id), title: WRONG_PRACTICE_TITLE },
      wrongOpeningVersion,
      rows,
      "whole",
      materialInputs,
    ),
  };
  // 存量快照容许比 K27 发版更宽的题号、版本和题面；在预留前保留宿主通道。
  if (
    publication.practice.questions.some(
      (question) =>
        question.response !== "choice" ||
        question.id.length > 128 ||
        !Number.isSafeInteger(question.version) ||
        question.version < 1 ||
        question.prompt.length === 0 ||
        Object.values(question.options).some((text) => text.length === 0),
    )
  )
    return false;
  if (!existsSync(join(dataDir, BACKUP_KERNEL_DATABASE))) throw needsStorage;
  db.insert(kernelWrongOpenings)
    .values({
      id: attempt.id,
      studentId: attempt.studentId,
      teacherId,
      attemptNo: attempt.attemptNo,
      publication,
      draft,
    })
    .run();
  return true;
}

export function insertWrongPracticeWithin(
  db: Db,
  attempt: Attempt,
  draft: KernelWrongOpeningDraft,
) {
  db.transaction((tx) => {
    tx.insert(attempts)
      .values({
        ...attempt,
        practiceScopeJson:
          draft.scope === undefined ? null : JSON.stringify(draft.scope),
      })
      .run();
    for (const response of draft.responses)
      insertFrozenResponse(tx, {
        ...response,
        attemptId: attempt.id,
        unitId: null,
      });
    freezeAttemptContextSnapshotsWithin(
      tx,
      attempt.id,
      draft.context,
      attempt.startedAt,
    );
  });
}

export function replayKernelWrongOpening(
  runtime: KernelRuntime,
  opening: Opening,
) {
  const draft = draftSchema.parse(opening.draft);
  const rows = choiceRows(draft);
  const practiceId = wrongOpeningPractice(opening.id);
  if (
    opening.publication.practice.id !== practiceId ||
    opening.publication.practice.version !== wrongOpeningVersion ||
    draft.scope?.kind === "ai" ||
    rows.length !== draft.responses.length
  )
    kernelAttemptUnavailable();
  const actor = { role: "student", id: opening.studentId } as const;
  runtime.publish(opening.publication);
  const receipt = runtime.prepare(actor, {
    protocolVersion: 1,
    operationId: wrongOpeningOperation(opening.id),
    practiceId,
    practiceVersion: wrongOpeningVersion,
  });
  const view = runtime.read(actor, receipt.activityId);
  const questions = "inputs" in view ? view.inputs.questions : undefined;
  if (
    !("questionDeliveries" in view) ||
    view.status !== "active" ||
    view.stepAttemptId !== receipt.stepAttemptId ||
    view.practiceVersion !== wrongOpeningVersion ||
    view.startedAt !== receipt.startedAt ||
    deliveryPolicy(view).mode !== "whole" ||
    view.questionDeliveries.length ||
    view.questionDeliveryDrafts.length ||
    questions?.from !== "questions" ||
    questions.questions.length !== rows.length ||
    rows.some(
      ({ question, questionVersion }, index) =>
        question.id !== questions.questions[index]?.id ||
        questionVersion !== questions.questions[index]?.version,
    ) ||
    !matchesKernelMaterialInputs(
      view,
      opening.teacherId,
      draft.context,
      rows.map(({ question }) => question),
    )
  )
    kernelAttemptUnavailable();
  return { receipt, draft };
}

/** 开卷意图已提交，重放只投影内核产生的活动 ID。 */
export function finishKernelWrongOpening(
  db: Db,
  dataDir: string | undefined,
  id: string,
  studentId: string,
): Attempt {
  return db.$client
    .transaction(() => {
      const opening = db
        .select()
        .from(kernelWrongOpenings)
        .where(eq(kernelWrongOpenings.id, id))
        .get();
      if (
        !opening ||
        opening.studentId !== studentId ||
        !dataDir ||
        studentTeacherIdOf(db, studentId) !== opening.teacherId
      )
        kernelAttemptUnavailable();
      if (opening.attemptId !== null) {
        const attempt = db
          .select()
          .from(attempts)
          .where(eq(attempts.id, opening.attemptId))
          .get();
        if (attempt?.sourceType !== "wrong" || attempt.studentId !== studentId)
          kernelAttemptUnavailable();
        const facts = readQuestionDeliveryFacts(db, dataDir, attempt);
        if (!facts) kernelAttemptUnavailable();
        return facts.attempt;
      }
      const { receipt, draft } = withKernelRuntime(
        db,
        dataDir,
        false,
        (runtime) => replayKernelWrongOpening(runtime, opening),
      );
      const attempt = newDraftAttempt({
        sourceType: "wrong",
        studentId,
        assignmentId: null,
        lectureId: null,
        courseId: null,
        unitId: null,
        attemptNo: opening.attemptNo,
        id: receipt.activityId,
        startedAt: receipt.startedAt,
        practiceWorkflowVersion: 1,
        feedbackMode: "after_attempt",
      });
      insertWrongPracticeWithin(db, attempt, draft);
      db.update(kernelWrongOpenings)
        .set({ attemptId: attempt.id, stepAttemptId: receipt.stepAttemptId })
        .where(eq(kernelWrongOpenings.id, id))
        .run();
      return attempt;
    })
    .immediate();
}
