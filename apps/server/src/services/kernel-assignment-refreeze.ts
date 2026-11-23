import { and, eq, isNotNull } from "drizzle-orm";
import {
  LearningError,
  type PreparedActivityVersionInput,
  type StudentActivity,
} from "learning-kernel";
import type { Db } from "../db/client.ts";
import {
  type Assignment,
  type Attempt,
  attemptBatchSubmissions,
  attemptContextFreezes,
  attemptContextSnapshots,
  attempts,
  notes,
  responses,
} from "../db/schema.ts";
import {
  kernelAttemptBindings,
  kernelAttemptConfirmations,
  kernelAttemptRefreezes,
  kernelChoiceAmendments,
} from "../db/schema-kernel-assignments.ts";
import {
  kernelCourseOpenings,
  kernelQuestionDeliveries,
} from "../db/schema-kernel-question-delivery.ts";
import { HttpError } from "../lib/http-error.ts";
import { requireOwnAttempt } from "./attempt-access.ts";
import {
  discardOpenedArtifactsWithin,
  hasPendingOriginals,
} from "./attempt-opened-artifacts.ts";
import { hasSubstantiveAttemptEvidence } from "./attempt-substantive-evidence.ts";
import { projectKernelDraftActivity } from "./kernel-assignment-activity.ts";
import {
  insertKernelFrozenResponses,
  reserveKernelAssignmentVersion,
  sameKernelFrozenDefinition,
  writeKernelRefreezeIntent,
} from "./kernel-assignment-freeze.ts";
import {
  assertKernelAssignmentPolicy,
  kernelOpeningDraftSchema,
  kernelRefreezeDraftSchema,
  loadKernelAssignmentQuestions,
} from "./kernel-assignment-input.ts";
import { matchesKernelMaterialInputs } from "./kernel-assignment-publication.ts";
import { pendingKernelRefreeze } from "./kernel-assignment-refreeze-guard.ts";
import {
  kernelAttemptUnavailable,
  verifyKernelMaterialContext,
  withKernelRuntime,
} from "./kernel-assignment-runtime.ts";
import { questionDeliveryBinding } from "./kernel-question-delivery-binding.ts";
import { freezeAttemptContextSnapshotsWithin } from "./material-repository.ts";
import type { Tx } from "./question-sync.ts";

type Ticket = typeof kernelAttemptRefreezes.$inferSelect;

export function isOpenEmptyForKernelRefreeze(
  db: Db,
  attempt: Attempt,
): boolean {
  const id = attempt.id;
  return (
    attempt.status === "draft" &&
    attempt.activatedAt === null &&
    attempt.abandonedAt === null &&
    attempt.frozenAt !== null &&
    !attempt.legacyUnverified &&
    attempt.timeLimitSec === null &&
    !hasSubstantiveAttemptEvidence(db, id) &&
    !hasPendingOriginals(db, id) &&
    !db
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.attemptId, id), isNotNull(notes.currentVersionId)))
      .get() &&
    !db
      .select()
      .from(kernelAttemptConfirmations)
      .where(eq(kernelAttemptConfirmations.attemptId, id))
      .get() &&
    !db
      .select()
      .from(kernelChoiceAmendments)
      .where(eq(kernelChoiceAmendments.attemptId, id))
      .get() &&
    !db
      .select({ id: kernelQuestionDeliveries.attemptId })
      .from(kernelQuestionDeliveries)
      .where(eq(kernelQuestionDeliveries.attemptId, id))
      .get() &&
    !db
      .select()
      .from(attemptBatchSubmissions)
      .where(eq(attemptBatchSubmissions.attemptId, id))
      .get()
  );
}

export function reserveKernelRefreeze(
  db: Db,
  tx: Tx,
  dataDir: string,
  assignment: Assignment,
  attempt: Attempt,
  activity: StudentActivity,
): boolean {
  if (
    activity.status !== "active" ||
    !("practiceVersion" in activity) ||
    activity.practiceVersion === undefined ||
    !("stepAttemptId" in activity) ||
    !isOpenEmptyForKernelRefreeze(db, attempt)
  )
    return false;
  let definition: ReturnType<typeof loadKernelAssignmentQuestions>;
  try {
    assertKernelAssignmentPolicy(assignment);
    definition = loadKernelAssignmentQuestions(
      db,
      assignment,
      attempt.studentId,
    );
  } catch (error) {
    if (error instanceof HttpError && error.code === "M04_PRACTICE_INELIGIBLE")
      return false;
    throw error;
  }
  if (
    !("submit" in activity.step) ||
    activity.step.submit.slots.answers?.type !== definition.slotType
  )
    return false;
  if (sameKernelFrozenDefinition(db, attempt, definition)) return false;
  const target = reserveKernelAssignmentVersion(
    db,
    tx,
    dataDir,
    assignment,
    definition,
  );
  writeKernelRefreezeIntent(
    tx,
    attempt,
    {
      expectedPracticeVersion: activity.practiceVersion,
      stepAttemptId: activity.stepAttemptId,
      ...target,
    },
    definition,
  );
  return true;
}

function currentVersion(activity: StudentActivity, attempt: Attempt) {
  if (
    activity.activityId !== attempt.id ||
    !("startedAt" in activity) ||
    activity.startedAt !== attempt.startedAt ||
    !("stepAttemptId" in activity) ||
    !("practiceVersion" in activity) ||
    activity.practiceVersion === undefined
  )
    kernelAttemptUnavailable();
  return {
    stepAttemptId: activity.stepAttemptId,
    practiceVersion: activity.practiceVersion,
  };
}

export function finishKernelRefreeze(
  db: Db,
  tx: Tx,
  dataDir: string,
  attempt: Attempt,
  ticket: Ticket,
  allowChange: boolean,
): Attempt {
  const key = eq(kernelAttemptRefreezes.attemptId, attempt.id);
  const course =
    attempt.sourceType === "course"
      ? questionDeliveryBinding(db, attempt)
      : undefined;
  const assignment =
    attempt.sourceType === "assignment"
      ? tx
          .select()
          .from(kernelAttemptBindings)
          .where(eq(kernelAttemptBindings.attemptId, attempt.id))
          .get()
      : undefined;
  const binding = course ?? assignment;
  const practiceId = course?.practiceId ?? assignment?.assignmentId;
  if (
    !binding ||
    !practiceId ||
    ticket.attemptId !== attempt.id ||
    (assignment && assignment.assignmentId !== attempt.assignmentId) ||
    (course && !course.course) ||
    binding.stepAttemptId !== ticket.stepAttemptId ||
    binding.practiceVersion !== ticket.expectedPracticeVersion ||
    ticket.publication.practice.id !== practiceId ||
    ticket.publication.practice.version !== ticket.practiceVersion ||
    ticket.practiceVersion === ticket.expectedPracticeVersion
  )
    kernelAttemptUnavailable();

  return withKernelRuntime(db, dataDir, false, (runtime) => {
    const principal = { role: "student", id: attempt.studentId } as const;
    const read = () =>
      currentVersion(runtime.read(principal, attempt.id), attempt);
    const previous = read();
    const stillOriginal =
      previous.stepAttemptId === ticket.stepAttemptId &&
      previous.practiceVersion === ticket.expectedPracticeVersion;
    if (stillOriginal && !allowChange) {
      if (course) return attempt;
      // 持有同一产品写锁时，仍是原步的 K 活动可安全继续原卷。
      tx.delete(kernelAttemptRefreezes).where(key).run();
      return attempt.activatedAt === null
        ? projectKernelDraftActivity(db, attempt, runtime)
        : attempt;
    }
    if (!isOpenEmptyForKernelRefreeze(db, attempt)) kernelAttemptUnavailable();
    if (stillOriginal) runtime.publish(ticket.publication);
    const input = {
      protocolVersion: 1,
      operationId: ticket.operationId,
      stepAttemptId: ticket.stepAttemptId,
      expectedPracticeVersion: ticket.expectedPracticeVersion,
      practiceVersion: ticket.practiceVersion,
    } satisfies PreparedActivityVersionInput;
    let receipt: ReturnType<typeof runtime.replacePreparedActivityVersion>;
    try {
      receipt = runtime.replacePreparedActivityVersion(
        principal,
        attempt.id,
        input,
      );
    } catch (error) {
      if (
        !(error instanceof LearningError) ||
        error.code !== "ACTIVITY_ALREADY_STARTED" ||
        !stillOriginal
      )
        throw error;
      const latest = read();
      if (
        latest.stepAttemptId !== previous.stepAttemptId ||
        latest.practiceVersion !== previous.practiceVersion
      )
        kernelAttemptUnavailable();
      tx.delete(kernelAttemptRefreezes).where(key).run();
      return projectKernelDraftActivity(db, attempt, runtime);
    }
    const latest = read();
    if (
      receipt.activityId !== attempt.id ||
      receipt.startedAt !== attempt.startedAt ||
      receipt.practiceVersion !== ticket.practiceVersion ||
      receipt.stepAttemptId === ticket.stepAttemptId ||
      latest.stepAttemptId !== receipt.stepAttemptId ||
      latest.practiceVersion !== receipt.practiceVersion
    )
      kernelAttemptUnavailable();

    const frozen = kernelRefreezeDraftSchema.parse(ticket.responses);
    const activity = runtime.read(principal, attempt.id);
    if (course?.course) {
      if (
        !("questionDeliveries" in activity) ||
        activity.status !== "active" ||
        activity.questionDeliveryDrafts.length ||
        activity.questionDeliveries.length ||
        frozen.responses.some(
          ({ unitId }) => unitId !== course.course?.unitId,
        ) ||
        !matchesKernelMaterialInputs(
          activity,
          course.teacherId,
          frozen.context ?? [],
          frozen.responses.map(({ question }) => question),
        )
      )
        kernelAttemptUnavailable();
    } else {
      verifyKernelMaterialContext(db, activity, practiceId, frozen);
    }
    discardOpenedArtifactsWithin(tx, attempt.id);
    tx.delete(attemptContextFreezes)
      .where(eq(attemptContextFreezes.attemptId, attempt.id))
      .run();
    tx.delete(attemptContextSnapshots)
      .where(eq(attemptContextSnapshots.attemptId, attempt.id))
      .run();
    tx.delete(responses).where(eq(responses.attemptId, attempt.id)).run();
    tx.update(attempts)
      .set({ frozenAt: ticket.frozenAt })
      .where(eq(attempts.id, attempt.id))
      .run();
    insertKernelFrozenResponses(tx, attempt.id, frozen.responses);
    freezeAttemptContextSnapshotsWithin(
      tx,
      attempt.id,
      frozen.context ?? [],
      ticket.frozenAt,
    );
    const replacement = {
      practiceVersion: receipt.practiceVersion,
      stepAttemptId: receipt.stepAttemptId,
    };
    if (course?.course) {
      tx.update(kernelCourseOpenings)
        .set({
          ...replacement,
          publication: ticket.publication,
          draft: kernelOpeningDraftSchema.parse({
            ...frozen,
            courseId: course.course.courseId,
            workflowVersion: 1,
          }),
        })
        .where(eq(kernelCourseOpenings.attemptId, attempt.id))
        .run();
    } else {
      tx.update(kernelAttemptBindings)
        .set(replacement)
        .where(eq(kernelAttemptBindings.attemptId, attempt.id))
        .run();
    }
    tx.delete(kernelAttemptRefreezes).where(key).run();
    return projectKernelDraftActivity(
      db,
      { ...attempt, frozenAt: ticket.frozenAt },
      runtime,
    );
  });
}

export function resolveKernelRefreezeForRead(
  db: Db,
  dataDir: string,
  attempt: Attempt,
): Attempt {
  if (!pendingKernelRefreeze(db, attempt.id)) return attempt;
  return db.transaction(
    (tx) => {
      const current = requireOwnAttempt(db, attempt.studentId, attempt.id);
      const ticket = pendingKernelRefreeze(tx, attempt.id);
      return ticket
        ? finishKernelRefreeze(db, tx, dataDir, current, ticket, false)
        : current;
    },
    { behavior: "immediate" },
  );
}
