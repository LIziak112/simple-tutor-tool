import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Attempt, attempts, courses } from "../db/schema.ts";
import { kernelCourseOpenings } from "../db/schema-kernel-question-delivery.ts";
import { HttpError } from "../lib/http-error.ts";
import { requireOwnAttempt } from "./attempt-access.ts";
import { requireVisibleCourseUnit } from "./course-service.ts";
import {
  canInitializeKernelStorage,
  insertKernelFrozenResponses,
  sameKernelFrozenDefinition,
  writeKernelRefreezeIntent,
} from "./kernel-assignment-freeze.ts";
import {
  type KernelOpeningDraft,
  kernelCourseDraftFor,
  kernelOpeningDraftSchema,
} from "./kernel-assignment-input.ts";
import {
  kernelMaterialPublication,
  matchesKernelMaterialInputs,
} from "./kernel-assignment-publication.ts";
import {
  finishKernelRefreeze,
  isOpenEmptyForKernelRefreeze,
} from "./kernel-assignment-refreeze.ts";
import { pendingKernelRefreeze } from "./kernel-assignment-refreeze-guard.ts";
import {
  ensureKernelRuntimeStorage,
  type KernelRuntime,
  kernelAttemptUnavailable,
  withKernelRuntime,
} from "./kernel-assignment-runtime.ts";
import {
  deliveryPolicy,
  questionDeliveryBinding,
  readBoundQuestionDelivery,
} from "./kernel-question-delivery-binding.ts";
import { questionDeliveryPublication } from "./kernel-question-delivery-publication.ts";
import { readQuestionDeliveryFacts } from "./kernel-question-delivery-recovery.ts";
import { freezeAttemptContextSnapshotsWithin } from "./material-repository.ts";
import { newDraftAttempt } from "./new-draft-attempt.ts";
import { getPracticeFeedbackSettings } from "./practice-feedback-settings-service.ts";
import type { Tx } from "./question-sync.ts";

type Opening = typeof kernelCourseOpenings.$inferSelect;

export function courseRestartStale() {
  return new HttpError(
    409,
    "ATTEMPT_RESTART_STALE",
    "当前作答已变化，请关闭确认后查看最新记录。",
  );
}

export function reserveKernelCourseOpening(
  db: Db,
  tx: Tx,
  attempt: Attempt,
  title: string,
  dataDir?: string,
  restartAttemptId?: string,
): Opening | undefined {
  const { courseId, unitId, studentId, attemptNo } = attempt;
  if (courseId === null || unitId === null) kernelAttemptUnavailable();
  if (
    !dataDir ||
    attempt.practiceWorkflowVersion !== 1 ||
    attempt.timeLimitSec !== null
  )
    return undefined;
  const course = tx
    .select({ teacherId: courses.teacherId })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  if (!course?.teacherId) return undefined;
  const settings = getPracticeFeedbackSettings(db, course.teacherId);
  if (settings.practiceFeedbackPolicy !== "after_attempt") return undefined;
  const teacherId = course.teacherId;
  const draft = kernelCourseDraftFor(
    db,
    attempt,
    teacherId,
    settings.studentSelfReviewEnabled,
    restartAttemptId,
  );
  if (!draft) return undefined;
  const practiceId = `course:${attempt.id}`;
  const practiceVersion = 1;
  ensureKernelRuntimeStorage(db, dataDir, canInitializeKernelStorage(tx));
  return tx
    .insert(kernelCourseOpenings)
    .values({
      studentId,
      courseId,
      unitId,
      teacherId,
      attemptNo,
      operationId: `open:${attempt.id}`,
      practiceId,
      practiceVersion,
      draft,
      publication: coursePublication(
        teacherId,
        practiceId,
        practiceVersion,
        title,
        draft,
      ),
    })
    .returning()
    .get();
}

function coursePublication(
  teacherId: string,
  practiceId: string,
  practiceVersion: number,
  title: string,
  draft: KernelOpeningDraft,
) {
  const { responses } = draft;
  const { materialInputs, materialDefinitions } = kernelMaterialPublication(
    teacherId,
    draft.context ?? [],
    responses.map(({ question }) => question),
  );
  return {
    ...materialDefinitions,
    ...questionDeliveryPublication(
      { id: practiceId, title },
      practiceVersion,
      responses,
      "whole",
      materialInputs,
    ),
  };
}

export function reserveKernelCourseRefreeze(
  db: Db,
  tx: Tx,
  dataDir: string,
  attempt: Attempt,
  title: string,
): boolean {
  if (pendingKernelRefreeze(tx, attempt.id)) return true;
  if (!isOpenEmptyForKernelRefreeze(db, attempt)) return false;
  const binding = questionDeliveryBinding(db, attempt);
  if (!binding?.course) kernelAttemptUnavailable();
  const next = kernelCourseDraftFor(
    db,
    attempt,
    binding.teacherId,
    getPracticeFeedbackSettings(db, binding.teacherId).studentSelfReviewEnabled,
  );
  if (!next || sameKernelFrozenDefinition(db, attempt, next)) return false;
  const eligible = withKernelRuntime(db, dataDir, false, (runtime) => {
    const view = readBoundQuestionDelivery(db, runtime, attempt, binding);
    return (
      view?.status === "active" &&
      !view.questionDeliveryDrafts.length &&
      !view.questionDeliveries.length
    );
  });
  if (!eligible) return false;

  const practiceVersion = binding.practiceVersion + 1;
  writeKernelRefreezeIntent(
    tx,
    attempt,
    {
      practiceVersion,
      expectedPracticeVersion: binding.practiceVersion,
      stepAttemptId: binding.stepAttemptId,
      publication: coursePublication(
        binding.teacherId,
        binding.practiceId,
        practiceVersion,
        title,
        next,
      ),
    },
    next,
  );
  return true;
}

export function replayKernelCourseOpening(
  runtime: KernelRuntime,
  opening: Opening,
) {
  const { practice } = opening.publication;
  const draft = kernelOpeningDraftSchema.parse(opening.draft);
  if (
    practice.id !== opening.practiceId ||
    practice.version !== opening.practiceVersion ||
    draft.courseId !== opening.courseId ||
    draft.workflowVersion !== 1 ||
    draft.timeLimitMinutes !== undefined ||
    draft.responses.some(({ unitId }) => unitId !== opening.unitId)
  )
    kernelAttemptUnavailable();
  const actor = { role: "student", id: opening.studentId } as const;
  runtime.publish(opening.publication);
  const receipt = runtime.prepare(actor, {
    protocolVersion: 1,
    operationId: opening.operationId,
    practiceId: opening.practiceId,
    practiceVersion: opening.practiceVersion,
  });
  const view = runtime.read(actor, receipt.activityId);
  if (
    !("questionDeliveries" in view) ||
    view.status !== "active" ||
    deliveryPolicy(view).mode !== "whole" ||
    view.questionDeliveries.length ||
    view.questionDeliveryDrafts.length ||
    !matchesKernelMaterialInputs(
      view,
      opening.teacherId,
      draft.context ?? [],
      draft.responses.map(({ question }) => question),
    )
  )
    kernelAttemptUnavailable();
  return { receipt, draft };
}

export function verifyKernelCourseRestartSource(
  db: Db,
  dataDir: string,
  opening: Opening,
  attachmentDir = dataDir,
) {
  const { restartAttemptId } = kernelOpeningDraftSchema.parse(opening.draft);
  if (restartAttemptId === undefined) return undefined;
  const predecessor = db
    .select()
    .from(attempts)
    .where(eq(attempts.id, restartAttemptId))
    .get();
  if (
    predecessor?.sourceType !== "course" ||
    predecessor.courseId !== opening.courseId ||
    predecessor.unitId !== opening.unitId ||
    predecessor.studentId !== opening.studentId ||
    predecessor.attemptNo >= opening.attemptNo ||
    predecessor.abandonedAt !== null ||
    predecessor.status !== "draft" ||
    questionDeliveryBinding(db, predecessor)?.teacherId !== opening.teacherId ||
    readQuestionDeliveryFacts(db, dataDir, predecessor, attachmentDir)?.attempt
      .status !== "draft"
  )
    kernelAttemptUnavailable();
  return predecessor;
}

export function finishKernelCourseOpening(
  db: Db,
  dataDir: string | undefined,
  opening: Opening,
  explicitRestart: boolean,
) {
  if (!dataDir) kernelAttemptUnavailable();
  return db.transaction(
    (tx) => {
      requireVisibleCourseUnit(
        db,
        opening.studentId,
        opening.courseId,
        opening.unitId,
      );
      const course = tx
        .select({ teacherId: courses.teacherId })
        .from(courses)
        .where(eq(courses.id, opening.courseId))
        .get();
      const current = tx
        .select()
        .from(kernelCourseOpenings)
        .where(eq(kernelCourseOpenings.operationId, opening.operationId))
        .get();
      if (!current || course?.teacherId !== current.teacherId)
        kernelAttemptUnavailable();
      if (current.attemptId !== null) {
        if (explicitRestart) throw courseRestartStale();
        const attempt = tx
          .select()
          .from(attempts)
          .where(eq(attempts.id, current.attemptId))
          .get();
        if (!attempt) kernelAttemptUnavailable();
        return resumeBoundKernelCourse(db, dataDir, attempt);
      }

      const predecessor = verifyKernelCourseRestartSource(db, dataDir, current);
      const { receipt, draft } = withKernelRuntime(
        db,
        dataDir,
        false,
        (runtime) => replayKernelCourseOpening(runtime, current),
      );
      const attempt = newDraftAttempt({
        sourceType: "course",
        assignmentId: null,
        lectureId: null,
        studentId: current.studentId,
        courseId: current.courseId,
        unitId: current.unitId,
        attemptNo: current.attemptNo,
        id: receipt.activityId,
        startedAt: receipt.startedAt,
        practiceWorkflowVersion: 1,
        feedbackMode: "after_attempt",
      });
      tx.insert(attempts).values(attempt).run();
      insertKernelFrozenResponses(tx, attempt.id, draft.responses);
      freezeAttemptContextSnapshotsWithin(
        tx,
        attempt.id,
        draft.context ?? [],
        attempt.startedAt,
      );
      tx.update(kernelCourseOpenings)
        .set({
          attemptId: attempt.id,
          stepAttemptId: receipt.stepAttemptId,
          draft: { ...draft, restartAttemptId: undefined },
        })
        .where(eq(kernelCourseOpenings.operationId, current.operationId))
        .run();
      if (predecessor)
        tx.update(attempts)
          .set({ abandonedAt: new Date().toISOString() })
          .where(
            and(eq(attempts.id, predecessor.id), isNull(attempts.abandonedAt)),
          )
          .run();
      return attempt;
    },
    { behavior: "immediate" },
  );
}

export function resumeBoundKernelCourse(
  db: Db,
  dataDir: string | undefined,
  attempt: Attempt,
  allowPendingRefreeze = false,
): Attempt {
  if (!dataDir) kernelAttemptUnavailable();
  return db.transaction(
    (tx) => {
      const current = requireOwnAttempt(db, attempt.studentId, attempt.id);
      if (current.courseId === null || current.unitId === null)
        kernelAttemptUnavailable();
      requireVisibleCourseUnit(
        db,
        current.studentId,
        current.courseId,
        current.unitId,
      );
      const pending = allowPendingRefreeze
        ? pendingKernelRefreeze(tx, current.id)
        : undefined;
      const resolved = pending
        ? finishKernelRefreeze(db, tx, dataDir, current, pending, true)
        : current;
      const delivery = readQuestionDeliveryFacts(db, dataDir, resolved);
      if (!delivery) kernelAttemptUnavailable();
      return delivery.attempt;
    },
    { behavior: "immediate" },
  );
}
