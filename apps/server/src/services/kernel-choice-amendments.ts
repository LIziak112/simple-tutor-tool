import { randomUUID } from "node:crypto";
import {
  choiceStudentAnswerSchema,
  type Question,
  singleChoiceScoringSourceSchema,
  type TeacherResponseEdit,
} from "@tutor/contract";
import {
  auditKindOf,
  choiceAmendmentIntentSchema,
} from "@tutor/contract/choice-amendment-intent";
import { studentStemMd } from "@tutor/md-dsl";
import { and, eq, isNull } from "drizzle-orm";
import {
  ChoiceDraftConflict,
  ChoiceSnapshotRevisionConflict,
  LearningError,
  QuestionDeliveryConflict,
} from "learning-kernel";
import type { Db } from "../db/client.ts";
import { attempts, responseEditAudits, responses } from "../db/schema.ts";
import { kernelChoiceAmendments } from "../db/schema-kernel-assignments.ts";
import { HttpError } from "../lib/http-error.ts";
import { assertFrozenAnswerShape } from "./attempt-question-projection.ts";
import { isKernelAttempt } from "./kernel-assignment-routing.ts";
import {
  kernelAttemptUnavailable,
  ownClassChoiceAnswerOf,
} from "./kernel-assignment-runtime.ts";
import {
  isCurrentChoiceReviewer,
  kernelChoiceAmendmentScope,
  withChoiceAmendmentReviewer,
} from "./kernel-choice-amendment-scope.ts";
import {
  applyDeliveryIntent,
  stageDeliveryFields,
  usesQuestionDelivery,
} from "./kernel-delivery-amendments.ts";
import {
  editTeacherDraftResponse,
  findTeacherAttempt,
  requireTeacherAttempt,
} from "./teacher-attempt-service.ts";
import {
  assertTeacherDraftSnapshot,
  responseEvidenceExists,
} from "./teacher-response-snapshot.ts";

type Ticket = typeof kernelChoiceAmendments.$inferSelect;

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

function amendmentForbidden() {
  return new HttpError(403, "FORBIDDEN", "当前教师无权修改这份作答");
}

function knownRejection(error: unknown) {
  if (
    error instanceof ChoiceDraftConflict ||
    error instanceof ChoiceSnapshotRevisionConflict ||
    error instanceof QuestionDeliveryConflict
  )
    return revisionConflict();
  if (error instanceof LearningError) {
    if (
      error.code === "ALREADY_SUBMITTED" ||
      error.code === "ACTIVITY_ABANDONED"
    )
      return notInProgress();
    if (error.code === "INVALID_QUESTION" || error.code === "INVALID_KEY")
      return new HttpError(
        400,
        "VALIDATION_ERROR",
        "题面勘误与冻结题型或评分不一致",
      );
    if (error.code === "RESPONSE_EVIDENCE_EXISTS")
      return responseEvidenceExists();
  }
  return undefined;
}

function kernelSnapshotContent(snapshot: Question) {
  const scoring = singleChoiceScoringSourceSchema.safeParse(snapshot);
  if (!scoring.success || snapshot.hints?.length) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "内核题面勘误须保留无提示的整卷单选评分",
    );
  }
  return {
    prompt: studentStemMd(snapshot),
    options: Object.fromEntries(
      scoring.data.options.map(({ text }, index) => [String(index), text]),
    ),
    acceptedChoice: String(scoring.data.answers.index),
  };
}

function ticketFor(db: Db, attemptId: string) {
  return db
    .select()
    .from(kernelChoiceAmendments)
    .where(eq(kernelChoiceAmendments.attemptId, attemptId))
    .get();
}

function stage(
  db: Db,
  dataDir: string,
  teacherId: string,
  edit: TeacherResponseEdit,
) {
  return db.$client
    .transaction(() => {
      const { attempt } = requireTeacherAttempt(db, teacherId, edit.attemptId);
      if (attempt.status !== "draft" || attempt.abandonedAt !== null)
        throw notInProgress();
      const scope = kernelChoiceAmendmentScope(db, attempt, edit.questionId);
      const { row, capability, binding } = scope;
      if (row.submittedAt !== null)
        throw new HttpError(
          409,
          "QUESTION_ALREADY_SUBMITTED",
          "本题已提交，不能修改",
        );
      if (ticketFor(db, attempt.id) !== undefined) kernelAttemptUnavailable();

      return withChoiceAmendmentReviewer(
        db,
        dataDir,
        teacherId,
        attempt,
        scope,
        { action: "read" },
        (runtime, reviewer) => {
          const read = <T>(load: () => T) => {
            try {
              return load();
            } catch (error) {
              throw knownRejection(error) ?? error;
            }
          };
          const delivery = usesQuestionDelivery(runtime, attempt);
          const current = delivery
            ? read(() =>
                runtime.readQuestionDeliveryDraftForAmendment(
                  reviewer,
                  attempt.id,
                  capability,
                ),
              )
            : read(() =>
                runtime.readChoiceDraftForAmendment(
                  reviewer,
                  attempt.id,
                  capability,
                ),
              );
          if (current.revision !== edit.expectedAnswerRevision)
            throw revisionConflict();
          const fields = (() => {
            if ("value" in current)
              return stageDeliveryFields(
                db,
                runtime,
                attempt,
                row,
                scope.snapshot,
                edit,
                current,
              );
            if ("snapshot" in edit) {
              assertTeacherDraftSnapshot(row, scope.snapshot, edit.snapshot);
              kernelSnapshotContent(edit.snapshot);
              return {
                kind: "snapshot",
                snapshot: edit.snapshot,
                prior: row.questionSnapshotJson,
              };
            }
            assertFrozenAnswerShape(db, row, scope.snapshot, edit.answer);
            const checked = choiceStudentAnswerSchema.safeParse(edit.answer);
            if (!checked.success)
              throw new HttpError(400, "VALIDATION_ERROR", "本题需要单选答案");
            return {
              kind: "answer",
              answer: checked.data,
              prior:
                current.choice === null
                  ? null
                  : ownClassChoiceAnswerOf(current.choice),
            };
          })();
          const ticket: Ticket = {
            attemptId: attempt.id,
            operationId: randomUUID(),
            responseId: row.id,
            teacherId,
            intent: choiceAmendmentIntentSchema.parse({
              ...fields,
              stepAttemptId: capability.stepAttemptId,
              practiceVersion: binding.practiceVersion,
              questionId: capability.questionId,
              questionVersion: capability.questionVersion,
              baseRevision: current.revision,
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
  const snapshotKind = auditKindOf(intent) === "snapshot";
  const attempt = snapshotKind
    ? db.select().from(attempts).where(eq(attempts.id, attemptId)).get()
    : findTeacherAttempt(db, teacherId, attemptId)?.attempt;
  if (attempt === undefined || attempt.abandonedAt !== null)
    kernelAttemptUnavailable();
  const acceptedOnly =
    snapshotKind && !isCurrentChoiceReviewer(db, teacherId, attempt);
  const scope = kernelChoiceAmendmentScope(db, attempt, intent.questionId);
  const { capability, binding, row } = scope;
  if (
    scope.row.id !== responseId ||
    capability.stepAttemptId !== intent.stepAttemptId ||
    capability.questionVersion !== intent.questionVersion ||
    binding.practiceVersion !== intent.practiceVersion ||
    ((intent.kind === "snapshot" || intent.kind === "deliverySnapshot") &&
      row.questionSnapshotJson !== intent.prior)
  )
    kernelAttemptUnavailable();

  return withChoiceAmendmentReviewer(
    db,
    dataDir,
    teacherId,
    attempt,
    scope,
    snapshotKind
      ? {
          action: "snapshot",
          operationId,
          baseRevision: intent.baseRevision,
          acceptedOnly,
        }
      : { action: "amend" },
    (runtime, reviewer) => {
      try {
        const command = {
          ...capability,
          operationId,
          baseRevision: intent.baseRevision,
          reason: intent.reason,
        };
        const revision = intent.baseRevision + 1;
        const projectSnapshot = (
          snapshot: Question,
          questionVersion: number,
        ) => {
          const updated = db
            .update(responses)
            .set({
              questionSnapshotJson: JSON.stringify(snapshot),
              questionVersion,
              answerRevision: revision,
              answerMutationId: operationId,
            })
            .where(
              and(eq(responses.id, responseId), isNull(responses.submittedAt)),
            )
            .run();
          if (updated.changes !== 1) kernelAttemptUnavailable();
        };
        let previousJson: string | null;
        if (
          intent.kind === "deliveryAnswer" ||
          intent.kind === "deliverySnapshot"
        ) {
          const revised = applyDeliveryIntent(
            db,
            runtime,
            attempt,
            reviewer,
            row,
            intent,
            command,
          );
          if (intent.kind === "deliverySnapshot") {
            if (!revised) kernelAttemptUnavailable();
            projectSnapshot(intent.snapshot, revised.questionVersion);
            previousJson = intent.prior;
          } else
            previousJson =
              intent.prior === null ? null : JSON.stringify(intent.prior);
        } else if (intent.kind === "snapshot") {
          const receipt = runtime.reviseChoiceSnapshot(reviewer, attemptId, {
            ...command,
            ...kernelSnapshotContent(intent.snapshot),
          });
          if (
            receipt.revision !== revision ||
            receipt.previousQuestionVersion !== intent.questionVersion ||
            receipt.questionVersion !== intent.questionVersion + 1
          )
            kernelAttemptUnavailable();
          projectSnapshot(intent.snapshot, receipt.questionVersion);
          previousJson = intent.prior;
        } else {
          const choice = String(intent.answer.index);
          const receipt = runtime.amendChoiceDraft(reviewer, attemptId, {
            ...command,
            choice,
          });
          if (receipt.revision !== revision || receipt.choice !== choice)
            kernelAttemptUnavailable();
          previousJson =
            intent.prior === null ? null : JSON.stringify(intent.prior);
        }
        db.insert(responseEditAudits)
          .values({
            id: operationId,
            responseId,
            teacherId,
            kind: auditKindOf(intent),
            previousJson,
            reason: intent.reason,
            answerRevision: revision,
            createdAt: intent.createdAt,
          })
          .run();
        return acceptedOnly
          ? { denied: amendmentForbidden() }
          : { answerRevision: revision };
      } catch (error) {
        const denied = knownRejection(error);
        if (denied === undefined) throw error;
        return { denied: acceptedOnly ? amendmentForbidden() : denied };
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

export function recoverKernelChoiceSnapshot(
  db: Db,
  dataDir: string,
  attemptId: string,
) {
  const ticket = ticketFor(db, attemptId);
  if (
    ticket &&
    auditKindOf(choiceAmendmentIntentSchema.parse(ticket.intent)) === "snapshot"
  )
    recoverKernelChoiceAmendment(db, dataDir, attemptId, ticket.operationId);
}

export function editTeacherKernelDraft(
  db: Db,
  dataDir: string,
  teacherId: string,
  edit: TeacherResponseEdit,
) {
  const { attempt } = requireTeacherAttempt(db, teacherId, edit.attemptId);
  if (!isCurrentChoiceReviewer(db, teacherId, attempt))
    throw amendmentForbidden();
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
  if (!isCurrentChoiceReviewer(db, teacherId, attempt))
    throw amendmentForbidden();
  return {
    success: true,
    attemptId: edit.attemptId,
    questionId: edit.questionId,
    answerRevision,
  };
}
