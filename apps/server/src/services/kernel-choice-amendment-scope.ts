import { and, eq, isNull } from "drizzle-orm";
import type { ChoiceSnapshotReviewerScope } from "learning-kernel";
import type { Db } from "../db/client.ts";
import { type Attempt, responses, teachers } from "../db/schema.ts";
import { kernelAttemptBindings } from "../db/schema-kernel-assignments.ts";
import { HttpError } from "../lib/http-error.ts";
import { buildAttemptQuestionWhere } from "./attempt-access.ts";
import { requireNoPendingKernelRefreeze } from "./kernel-assignment-refreeze-guard.ts";
import {
  type KernelRuntime,
  kernelAttemptUnavailable,
  withKernelRuntime,
} from "./kernel-assignment-runtime.ts";
import { snapshotOfRow } from "./snapshot.ts";
import { findTeacherAttempt } from "./teacher-attempt-service.ts";
import { hasTeacherDraftSnapshotEvidence } from "./teacher-response-snapshot.ts";

export function kernelChoiceAmendmentScope(
  db: Db,
  attempt: Attempt,
  questionId: string,
) {
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

type Scope = ReturnType<typeof kernelChoiceAmendmentScope>;
type Mode =
  | { action: "read" | "amend" }
  | {
      action: "snapshot";
      operationId: string;
      baseRevision: number;
      acceptedOnly: boolean;
    };

export function isCurrentChoiceReviewer(
  db: Db,
  teacherId: string,
  attempt: Attempt,
) {
  return (
    findTeacherAttempt(db, teacherId, attempt.id)?.attempt.studentId ===
      attempt.studentId &&
    db
      .select({ id: teachers.id })
      .from(teachers)
      .where(and(eq(teachers.id, teacherId), isNull(teachers.disabledAt)))
      .get() !== undefined
  );
}

export function withChoiceAmendmentReviewer<T>(
  db: Db,
  dataDir: string,
  teacherId: string,
  attempt: Attempt,
  scope: Scope,
  mode: Mode,
  run: (
    runtime: KernelRuntime,
    reviewer: { role: "reviewer"; id: string },
  ) => T,
) {
  const permits = (
    request: Omit<ChoiceSnapshotReviewerScope, "baseRevision" | "operationId">,
  ) => {
    const { capability } = scope;
    return (
      request.reviewerId === teacherId &&
      request.studentId === attempt.studentId &&
      request.activityId === attempt.id &&
      request.stepAttemptId === capability.stepAttemptId &&
      request.slotId === capability.slotId &&
      request.questionId === capability.questionId &&
      request.questionVersion === capability.questionVersion
    );
  };
  return withKernelRuntime(
    db,
    dataDir,
    false,
    (runtime) => run(runtime, { role: "reviewer", id: teacherId }),
    {
      authorizeChoiceDraftAmendment: (request) =>
        request.action === mode.action &&
        permits(request) &&
        isCurrentChoiceReviewer(db, teacherId, attempt),
      authorizeChoiceSnapshotRevision: (request) =>
        mode.action === "snapshot" &&
        request.operationId === mode.operationId &&
        request.baseRevision === mode.baseRevision &&
        permits(request) &&
        (mode.acceptedOnly || isCurrentChoiceReviewer(db, teacherId, attempt)),
      hasChoiceSnapshotEvidence: () =>
        (mode.action === "snapshot" && mode.acceptedOnly) ||
        hasTeacherDraftSnapshotEvidence(db, scope.row),
    },
  );
}
