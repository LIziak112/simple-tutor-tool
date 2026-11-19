import { randomUUID } from "node:crypto";
import {
  choiceStudentAnswerSchema,
  type TeacherResponseEdit,
} from "@tutor/contract";
import { and, eq, isNull } from "drizzle-orm";
import { ChoiceDraftConflict, LearningError } from "learning-kernel";
import type { Db } from "../db/client.ts";
import {
  type Attempt,
  responseEditAudits,
  responses,
  teachers,
} from "../db/schema.ts";
import {
  kernelAttemptBindings,
  kernelChoiceAmendments,
} from "../db/schema-kernel-assignments.ts";
import { HttpError } from "../lib/http-error.ts";
import { buildAttemptQuestionWhere } from "./attempt-access.ts";
import { assertFrozenAnswerShape } from "./attempt-question-projection.ts";
import { requireNoPendingKernelRefreeze } from "./kernel-assignment-refreeze-guard.ts";
import { isKernelAttempt } from "./kernel-assignment-routing.ts";
import {
  type KernelRuntime,
  kernelAttemptUnavailable,
  ownClassChoiceAnswerOf,
  withKernelRuntime,
} from "./kernel-assignment-runtime.ts";
import { choiceAmendmentIntentSchema } from "./kernel-choice-amendment-intent.ts";
import { snapshotOfRow } from "./snapshot.ts";
import {
  editTeacherDraftResponse,
  findTeacherAttempt,
  requireTeacherAttempt,
} from "./teacher-attempt-service.ts";

type Edit = Extract<TeacherResponseEdit, { answer: unknown }>;
type Ticket = typeof kernelChoiceAmendments.$inferSelect;
type Scope = ReturnType<typeof scopeOf>;

function notInProgress() {
  return new HttpError(
    409,
    "ATTEMPT_NOT_IN_PROGRESS",
    "只能修改未作废的进行中练习",
  );
}

function revisionConflict() {
  return new HttpError(
    409,
    "ANSWER_REVISION_CONFLICT",
    "本题已更新，请重新查询",
  );
}

function knownRejection(error: unknown) {
  if (error instanceof ChoiceDraftConflict) return revisionConflict();
  if (error instanceof LearningError && error.code === "ALREADY_SUBMITTED")
    return notInProgress();
  return undefined;
}

function ticketFor(db: Db, attemptId: string) {
  return db
    .select()
    .from(kernelChoiceAmendments)
    .where(eq(kernelChoiceAmendments.attemptId, attemptId))
    .get();
}

function scopeOf(db: Db, attempt: Attempt, questionId: string) {
  requireNoPendingKernelRefreeze(db, attempt);
  const binding = db
    .select()
    .from(kernelAttemptBindings)
    .where(eq(kernelAttemptBindings.attemptId, attempt.id))
    .get();
  if (binding === undefined || binding.assignmentId !== attempt.assignmentId)
    kernelAttemptUnavailable();

  const row = db
    .select()
    .from(responses)
    .where(buildAttemptQuestionWhere(attempt.id, questionId))
    .get();
  const snapshot = row === undefined ? null : snapshotOfRow(row);
  if (row === undefined || snapshot === null)
    throw new HttpError(404, "QUESTION_NOT_FOUND", "找不到该练习的冻结题目");

  return {
    row,
    snapshot,
    binding,
    capability: {
      protocolVersion: 1 as const,
      stepAttemptId: binding.stepAttemptId,
      slotId: "answers",
      questionId,
      questionVersion: row.questionVersion,
    },
  };
}

function withReviewer<T>(
  db: Db,
  dataDir: string,
  teacherId: string,
  attempt: Attempt,
  scope: Scope,
  action: "read" | "amend",
  run: (
    runtime: KernelRuntime,
    reviewer: { role: "reviewer"; id: string },
  ) => T,
) {
  return withKernelRuntime(
    db,
    dataDir,
    false,
    (runtime) => run(runtime, { role: "reviewer", id: teacherId }),
    {
      authorizeChoiceDraftAmendment(request) {
        const { capability } = scope;
        return (
          request.action === action &&
          request.reviewerId === teacherId &&
          request.studentId === attempt.studentId &&
          request.activityId === attempt.id &&
          request.stepAttemptId === capability.stepAttemptId &&
          request.slotId === capability.slotId &&
          request.questionId === capability.questionId &&
          request.questionVersion === capability.questionVersion &&
          findTeacherAttempt(db, teacherId, attempt.id)?.attempt.studentId ===
            attempt.studentId &&
          db
            .select({ id: teachers.id })
            .from(teachers)
            .where(and(eq(teachers.id, teacherId), isNull(teachers.disabledAt)))
            .get() !== undefined
        );
      },
    },
  );
}

function stage(db: Db, dataDir: string, teacherId: string, edit: Edit) {
  return db.$client
    .transaction(() => {
      const { attempt } = requireTeacherAttempt(db, teacherId, edit.attemptId);
      if (attempt.status !== "draft" || attempt.abandonedAt !== null)
        throw notInProgress();
      const scope = scopeOf(db, attempt, edit.questionId);
      const { row, capability, binding } = scope;
      if (row.submittedAt !== null)
        throw new HttpError(
          409,
          "QUESTION_ALREADY_SUBMITTED",
          "本题已提交，不能修改",
        );
      if (ticketFor(db, attempt.id) !== undefined) kernelAttemptUnavailable();

      return withReviewer(
        db,
        dataDir,
        teacherId,
        attempt,
        scope,
        "read",
        (runtime, reviewer) => {
          const current = (() => {
            try {
              return runtime.readChoiceDraftForAmendment(
                reviewer,
                attempt.id,
                capability,
              );
            } catch (error) {
              throw knownRejection(error) ?? error;
            }
          })();
          if (current.revision !== edit.expectedAnswerRevision)
            throw revisionConflict();
          assertFrozenAnswerShape(db, row, scope.snapshot, edit.answer);
          const checked = choiceStudentAnswerSchema.safeParse(edit.answer);
          if (!checked.success)
            throw new HttpError(400, "VALIDATION_ERROR", "本题需要单选答案");
          const ticket: Ticket = {
            attemptId: attempt.id,
            operationId: randomUUID(),
            responseId: row.id,
            teacherId,
            intent: choiceAmendmentIntentSchema.parse({
              stepAttemptId: capability.stepAttemptId,
              practiceVersion: binding.practiceVersion,
              questionId: capability.questionId,
              questionVersion: capability.questionVersion,
              baseRevision: current.revision,
              answer: checked.data,
              prior:
                current.choice === null
                  ? null
                  : ownClassChoiceAnswerOf(current.choice),
              reason: edit.reason,
              createdAt: new Date().toISOString(),
            }),
          };
          db.insert(kernelChoiceAmendments).values(ticket).run();
          return ticket;
        },
      );
    })
    .immediate();
}

function apply(db: Db, dataDir: string, ticket: Ticket) {
  const { attemptId, teacherId, responseId, operationId } = ticket;
  const intent = choiceAmendmentIntentSchema.parse(ticket.intent);
  const { attempt } =
    findTeacherAttempt(db, teacherId, attemptId) ?? kernelAttemptUnavailable();
  if (attempt.abandonedAt !== null) kernelAttemptUnavailable();
  const scope = scopeOf(db, attempt, intent.questionId);
  const { capability, binding } = scope;
  if (
    scope.row.id !== responseId ||
    capability.stepAttemptId !== intent.stepAttemptId ||
    capability.questionVersion !== intent.questionVersion ||
    binding.practiceVersion !== intent.practiceVersion
  )
    kernelAttemptUnavailable();

  return withReviewer(
    db,
    dataDir,
    teacherId,
    attempt,
    scope,
    "amend",
    (runtime, reviewer) => {
      try {
        const receipt = runtime.amendChoiceDraft(reviewer, attemptId, {
          ...capability,
          choice: String(intent.answer.index),
          operationId,
          baseRevision: intent.baseRevision,
          reason: intent.reason,
        });
        if (
          receipt.revision !== intent.baseRevision + 1 ||
          receipt.choice !== String(intent.answer.index)
        )
          kernelAttemptUnavailable();
        db.insert(responseEditAudits)
          .values({
            id: operationId,
            responseId,
            teacherId,
            kind: "answer",
            previousJson:
              intent.prior === null ? null : JSON.stringify(intent.prior),
            reason: intent.reason,
            answerRevision: receipt.revision,
            createdAt: intent.createdAt,
          })
          .run();
        return { answerRevision: receipt.revision };
      } catch (error) {
        const denied = knownRejection(error);
        if (denied === undefined) throw error;
        return { denied };
      }
    },
  );
}

export function recoverKernelChoiceAmendment(
  db: Db,
  dataDir: string,
  attemptId: string,
  expectedOperationId?: string,
) {
  if (ticketFor(db, attemptId) === undefined) return;
  return db.$client
    .transaction(() => {
      const ticket = ticketFor(db, attemptId);
      if (
        ticket === undefined ||
        (expectedOperationId !== undefined &&
          ticket.operationId !== expectedOperationId)
      )
        return;
      const outcome = apply(db, dataDir, ticket);
      db.delete(kernelChoiceAmendments)
        .where(eq(kernelChoiceAmendments.attemptId, attemptId))
        .run();
      return outcome;
    })
    .immediate();
}

export function editTeacherDraftAnswer(
  db: Db,
  dataDir: string,
  teacherId: string,
  edit: Edit,
) {
  const { attempt } = requireTeacherAttempt(db, teacherId, edit.attemptId);
  if (!isKernelAttempt(db, attempt))
    return editTeacherDraftResponse(db, teacherId, edit);
  recoverKernelChoiceAmendment(db, dataDir, attempt.id);
  const ticket = stage(db, dataDir, teacherId, edit);
  const outcome = recoverKernelChoiceAmendment(
    db,
    dataDir,
    attempt.id,
    ticket.operationId,
  );
  if (outcome?.denied !== undefined) throw outcome.denied;
  const answerRevision =
    outcome?.answerRevision ??
    db
      .select({ revision: responseEditAudits.answerRevision })
      .from(responseEditAudits)
      .where(eq(responseEditAudits.id, ticket.operationId))
      .get()?.revision;
  if (answerRevision === undefined) throw revisionConflict();
  requireTeacherAttempt(db, teacherId, edit.attemptId);
  return {
    success: true,
    attemptId: edit.attemptId,
    questionId: edit.questionId,
    answerRevision,
  };
}
