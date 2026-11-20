import { randomUUID } from "node:crypto";
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
import { canonicalJsonOf } from "../lib/canonical-json.ts";
import { HttpError } from "../lib/http-error.ts";
import { requireOwnAttempt } from "./attempt-access.ts";
import { attemptResponseRows } from "./attempt-freeze.ts";
import {
  discardOpenedArtifactsWithin,
  hasPendingOriginals,
} from "./attempt-opened-artifacts.ts";
import { hasSubstantiveAttemptEvidence } from "./attempt-substantive-evidence.ts";
import { projectKernelDraftActivity } from "./kernel-assignment-activity.ts";
import {
  insertKernelFrozenResponses,
  reserveKernelAssignmentVersion,
} from "./kernel-assignment-freeze.ts";
import {
  assertKernelAssignmentPolicy,
  kernelRefreezeDraftSchema,
  loadKernelAssignmentQuestions,
} from "./kernel-assignment-input.ts";
import { pendingKernelRefreeze } from "./kernel-assignment-refreeze-guard.ts";
import {
  frozenKernelContextOf,
  kernelAttemptUnavailable,
  verifyKernelMaterialContext,
  withKernelRuntime,
} from "./kernel-assignment-runtime.ts";
import { freezeAttemptContextSnapshotsWithin } from "./material-repository.ts";
import type { Tx } from "./question-sync.ts";

type Ticket = typeof kernelAttemptRefreezes.$inferSelect;

function isOpenEmpty(db: Db, attempt: Attempt): boolean {
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
    !isOpenEmpty(db, attempt)
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
  const current = attemptResponseRows(db, attempt.id);
  if (
    canonicalJsonOf(
      frozenKernelContextOf(db, attempt.id).map(canonicalJsonOf).sort(),
    ) === canonicalJsonOf(definition.context.map(canonicalJsonOf).sort()) &&
    current.length === definition.responses.length &&
    current.every((row, index) => {
      const next = definition.responses[index];
      return (
        row.questionId === next?.question.id &&
        row.questionVersion === next.questionVersion &&
        row.unitId === next.unitId
      );
    })
  )
    return false;
  const target = reserveKernelAssignmentVersion(
    db,
    tx,
    dataDir,
    assignment,
    definition,
  );
  if (target.practiceVersion === activity.practiceVersion)
    kernelAttemptUnavailable();
  const frozenAt = new Date(
    Math.max(Date.now(), Date.parse(attempt.frozenAt ?? attempt.startedAt) + 1),
  ).toISOString();
  tx.insert(kernelAttemptRefreezes)
    .values({
      attemptId: attempt.id,
      operationId: `refreeze:${randomUUID()}`,
      stepAttemptId: activity.stepAttemptId,
      expectedPracticeVersion: activity.practiceVersion,
      frozenAt,
      ...target,
      responses:
        definition.context.length > 0
          ? { responses: definition.responses, context: definition.context }
          : definition.responses,
    })
    .run();
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
  const binding = tx
    .select()
    .from(kernelAttemptBindings)
    .where(eq(kernelAttemptBindings.attemptId, attempt.id))
    .get();
  if (
    !binding ||
    binding.assignmentId !== attempt.assignmentId ||
    binding.stepAttemptId !== ticket.stepAttemptId ||
    binding.practiceVersion !== ticket.expectedPracticeVersion ||
    ticket.publication.practice.id !== binding.assignmentId ||
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
      // 持有同一产品写锁时，仍是原步的 K 活动可安全继续原卷。
      tx.delete(kernelAttemptRefreezes).where(key).run();
      return attempt.activatedAt === null
        ? projectKernelDraftActivity(db, attempt, runtime)
        : attempt;
    }
    if (!isOpenEmpty(db, attempt)) kernelAttemptUnavailable();
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
    verifyKernelMaterialContext(
      db,
      runtime.read(principal, attempt.id),
      binding.assignmentId,
      frozen,
    );
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
    tx.update(kernelAttemptBindings)
      .set({
        practiceVersion: receipt.practiceVersion,
        stepAttemptId: receipt.stepAttemptId,
      })
      .where(eq(kernelAttemptBindings.attemptId, attempt.id))
      .run();
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
): void {
  if (!pendingKernelRefreeze(db, attempt.id)) return;
  db.transaction(
    (tx) => {
      const current = requireOwnAttempt(db, attempt.studentId, attempt.id);
      const ticket = pendingKernelRefreeze(tx, attempt.id);
      if (ticket) finishKernelRefreeze(db, tx, dataDir, current, ticket, false);
    },
    { behavior: "immediate" },
  );
}
