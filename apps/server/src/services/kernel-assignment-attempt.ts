import { createHash } from "node:crypto";
import type {
  AttemptStartData,
  PracticeWorkflowStartOptions,
} from "@tutor/contract";
import { and, eq, max } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Attempt, attempts } from "../db/schema.ts";
import {
  kernelAssignmentVersions,
  kernelAttemptBindings,
} from "../db/schema-kernel-assignments.ts";
import { canonicalJsonOf } from "../lib/canonical-json.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  requireAssignmentVisible,
  requireOwnAttempt,
} from "./attempt-access.ts";
import { insertFrozenResponses } from "./attempt-freeze.ts";
import { withAllowRedo } from "./attempt-redo-policy.ts";
import { attemptSummaryOf } from "./attempt-summary.ts";
import { startOpenedAttemptTimer } from "./attempt-timing.ts";
import {
  assertKernelAssignmentPolicy,
  kernelDraftForAssignment,
  loadKernelAssignmentChoices,
} from "./kernel-assignment-input.ts";
import { kernelAssignmentPublication } from "./kernel-assignment-publication.ts";
import { isKernelAttempt } from "./kernel-assignment-routing.ts";
import {
  kernelAttemptUnavailable,
  withKernelRuntime,
} from "./kernel-assignment-runtime.ts";
import { freezeAttemptContextSnapshotsWithin } from "./material-repository.ts";
import { studentSelfReviewEnabledOf } from "./practice-feedback-settings-service.ts";
import { resolveNewAttemptWorkflow } from "./practice-workflow-wiring.ts";

function verifyKernelBinding(db: Db, dataDir: string, attempt: Attempt): void {
  const binding = db
    .select()
    .from(kernelAttemptBindings)
    .where(eq(kernelAttemptBindings.attemptId, attempt.id))
    .get();
  if (!binding || binding.assignmentId !== attempt.assignmentId)
    kernelAttemptUnavailable();
  withKernelRuntime(db, dataDir, false, (runtime) => {
    const activity = runtime.read(
      { role: "student", id: attempt.studentId },
      attempt.id,
    );
    if (
      activity.activityId !== attempt.id ||
      !("stepAttemptId" in activity) ||
      activity.stepAttemptId !== binding.stepAttemptId ||
      !("startedAt" in activity) ||
      activity.startedAt !== attempt.startedAt
    )
      kernelAttemptUnavailable();
  });
}

export function verifyKernelStudentAttempt(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
): void {
  const attempt = requireOwnAttempt(db, studentId, attemptId);
  if (isKernelAttempt(db, attempt)) verifyKernelBinding(db, dataDir, attempt);
}

export function startKernelAssignmentAttempt(
  db: Db,
  dataDir: string,
  studentId: string,
  assignmentId: string,
  options: PracticeWorkflowStartOptions,
): AttemptStartData {
  return db.transaction(
    (tx) => {
      const assignment = requireAssignmentVisible(db, studentId, assignmentId);
      const existing = tx
        .select()
        .from(attempts)
        .where(
          and(
            eq(attempts.assignmentId, assignmentId),
            eq(attempts.studentId, studentId),
          ),
        )
        .get();
      if (existing) {
        verifyKernelBinding(db, dataDir, existing);
        return withAllowRedo(
          attemptSummaryOf(
            startOpenedAttemptTimer(db, existing, options.timeLimitMinutes),
          ),
          false,
        );
      }
      if (options.redo === true)
        throw new HttpError(409, "REDO_NOT_ALLOWED", "这份作业不允许重做");
      assertKernelAssignmentPolicy(assignment);
      const workflow =
        options.workflowVersion === 1
          ? resolveNewAttemptWorkflow(db, {
              sourceType: "assignment",
              studentId,
              assignmentId,
              unitId: null,
              studentChoice: options.feedbackMode ?? null,
            })
          : undefined;
      if (workflow && workflow.feedbackMode !== "after_attempt")
        throw new HttpError(
          422,
          "M04_PRACTICE_INELIGIBLE",
          "内核作业仅支持整卷反馈",
        );
      const { freeze, questions } = loadKernelAssignmentChoices(
        db,
        assignment,
        studentId,
      );
      const publication = kernelAssignmentPublication(assignment, 1, questions);
      const fingerprint = createHash("sha256")
        .update(
          canonicalJsonOf({
            publication,
            frozen: freeze.liveRows.map(({ id, unitId, version }) => ({
              id,
              unitId,
              version,
            })),
          }),
        )
        .digest("hex");
      const known = tx
        .select()
        .from(kernelAssignmentVersions)
        .where(
          and(
            eq(kernelAssignmentVersions.assignmentId, assignmentId),
            eq(kernelAssignmentVersions.fingerprint, fingerprint),
          ),
        )
        .get();
      const latest = known
        ? undefined
        : tx
            .select({ version: max(kernelAssignmentVersions.practiceVersion) })
            .from(kernelAssignmentVersions)
            .where(eq(kernelAssignmentVersions.assignmentId, assignmentId))
            .get();
      const practiceVersion =
        known?.practiceVersion ?? (latest?.version ?? 0) + 1;
      const canInitialize =
        !known &&
        practiceVersion === 1 &&
        !tx
          .select({ assignmentId: kernelAssignmentVersions.assignmentId })
          .from(kernelAssignmentVersions)
          .limit(1)
          .get();
      const receipt = withKernelRuntime(
        db,
        dataDir,
        canInitialize,
        (runtime) => {
          if (!known)
            runtime.publish(
              kernelAssignmentPublication(
                assignment,
                practiceVersion,
                questions,
              ),
            );
          return runtime.start(
            { role: "student", id: studentId },
            {
              protocolVersion: 1,
              operationId: `open:${assignmentId}`,
              practiceId: assignmentId,
              practiceVersion,
            },
          );
        },
      );
      if (!known)
        tx.insert(kernelAssignmentVersions)
          .values({ assignmentId, practiceVersion, fingerprint })
          .run();
      const attempt = kernelDraftForAssignment(
        assignment,
        studentId,
        receipt.activityId,
        receipt.startedAt,
        {
          timeLimitMinutes: options.timeLimitMinutes,
          ...(workflow && {
            practiceWorkflowVersion: workflow.practiceWorkflowVersion,
            feedbackMode: workflow.feedbackMode,
            workflowRevision: workflow.workflowRevision,
          }),
        },
      );
      tx.insert(attempts).values(attempt).run();
      insertFrozenResponses(
        tx,
        attempt.id,
        freeze.liveRows,
        freeze.knowledgeByQuestion,
        studentSelfReviewEnabledOf(db, freeze.teacherId),
      );
      freezeAttemptContextSnapshotsWithin(
        tx,
        attempt.id,
        [],
        attempt.startedAt,
      );
      tx.insert(kernelAttemptBindings)
        .values({
          attemptId: attempt.id,
          assignmentId,
          practiceVersion,
          stepAttemptId: receipt.stepAttemptId,
        })
        .run();
      return withAllowRedo(attemptSummaryOf(attempt), false);
    },
    { behavior: "immediate" },
  );
}
