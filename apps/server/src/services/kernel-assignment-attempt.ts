import type {
  AttemptStartData,
  PracticeWorkflowStartOptions,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Assignment, type Attempt, attempts } from "../db/schema.ts";
import {
  kernelAssignmentOpenings,
  kernelAttemptBindings,
} from "../db/schema-kernel-assignments.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  requireAssignmentVisible,
  requireOwnAttempt,
  requireUsableAttempt,
} from "./attempt-access.ts";
import type { AttemptStartClient } from "./attempt-opened-refresh.ts";
import { withAllowRedo } from "./attempt-redo-policy.ts";
import { attemptSummaryOf } from "./attempt-summary.ts";
import { startOpenedAttemptTimer } from "./attempt-timing.ts";
import { projectKernelDraftActivity } from "./kernel-assignment-activity.ts";
import {
  insertKernelFrozenResponses,
  reserveKernelAssignmentVersion,
} from "./kernel-assignment-freeze.ts";
import {
  assertKernelAssignmentPolicy,
  kernelDraftForAssignment,
  kernelOpeningDraftSchema,
  loadKernelAssignmentQuestions,
} from "./kernel-assignment-input.ts";
import {
  finishKernelRefreeze,
  reserveKernelRefreeze,
  resolveKernelRefreezeForRead,
} from "./kernel-assignment-refreeze.ts";
import { pendingKernelRefreeze } from "./kernel-assignment-refreeze-guard.ts";
import { isKernelAttempt } from "./kernel-assignment-routing.ts";
import {
  kernelAttemptUnavailable,
  verifyKernelMaterialContext,
  verifyStoredKernelMaterialContext,
  withBoundKernelActivity,
  withKernelRuntime,
} from "./kernel-assignment-runtime.ts";
import { readQuestionDeliveryFacts } from "./kernel-question-delivery.ts";
import { freezeAttemptContextSnapshotsWithin } from "./material-repository.ts";
import { resolveNewAttemptWorkflow } from "./practice-workflow-wiring.ts";
import type { Tx } from "./question-sync.ts";

function verifyKernelBinding(db: Db, dataDir: string, attempt: Attempt): void {
  withBoundKernelActivity(db, dataDir, attempt, (_, activity) => {
    verifyStoredKernelMaterialContext(db, activity, attempt);
  });
}

export function verifyKernelStudentAttempt(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
): void {
  const attempt = requireOwnAttempt(db, studentId, attemptId);
  if (attempt.abandonedAt === null && isKernelAttempt(db, attempt)) {
    if (attempt.sourceType === "lesson") {
      if (
        !readQuestionDeliveryFacts(
          db,
          dataDir,
          requireUsableAttempt(db, studentId, attempt.id),
        )
      )
        kernelAttemptUnavailable();
      return;
    }
    resolveKernelRefreezeForRead(db, dataDir, attempt);
    verifyKernelBinding(db, dataDir, attempt);
  }
}

function findKernelAttempt(
  db: Db,
  studentId: string,
  assignmentId: string,
): Attempt | undefined {
  return db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.assignmentId, assignmentId),
        eq(attempts.studentId, studentId),
      ),
    )
    .get();
}

function summarize(
  db: Db,
  attempt: Attempt,
  timeLimitMinutes: number | undefined,
): AttemptStartData {
  return withAllowRedo(
    attemptSummaryOf(startOpenedAttemptTimer(db, attempt, timeLimitMinutes)),
    false,
  );
}

function openingKey(assignmentId: string, studentId: string) {
  return and(
    eq(kernelAssignmentOpenings.assignmentId, assignmentId),
    eq(kernelAssignmentOpenings.studentId, studentId),
  );
}

function reserveKernelOpening(
  db: Db,
  tx: Tx,
  dataDir: string,
  assignment: Assignment,
  studentId: string,
  options: PracticeWorkflowStartOptions,
): void {
  const assignmentId = assignment.id;
  if (
    tx
      .select()
      .from(kernelAssignmentOpenings)
      .where(openingKey(assignmentId, studentId))
      .get()
  )
    return;
  if (options.redo === true)
    throw new HttpError(409, "REDO_NOT_ALLOWED", "这份作业不允许重做");
  assertKernelAssignmentPolicy(assignment);
  if (options.workflowVersion === 1) {
    const workflow = resolveNewAttemptWorkflow(db, {
      sourceType: "assignment",
      studentId,
      assignmentId,
      unitId: null,
      studentChoice: options.feedbackMode ?? null,
    });
    if (workflow.feedbackMode !== "after_attempt")
      throw new HttpError(
        422,
        "M04_PRACTICE_INELIGIBLE",
        "内核作业仅支持整卷反馈",
      );
  }

  const definition = loadKernelAssignmentQuestions(db, assignment, studentId);
  const version = reserveKernelAssignmentVersion(
    db,
    tx,
    dataDir,
    assignment,
    definition,
  );
  tx.insert(kernelAssignmentOpenings)
    .values({
      assignmentId,
      studentId,
      ...version,
      draft: kernelOpeningDraftSchema.parse({
        courseId: assignment.courseId,
        timeLimitMinutes: options.timeLimitMinutes,
        workflowVersion: options.workflowVersion,
        responses: definition.responses,
        ...(definition.context.length > 0 && { context: definition.context }),
        prepared:
          definition.slotType === "questionDelivery" ||
          options.timeLimitMinutes === undefined
            ? true
            : undefined,
      }),
    })
    .run();
}

export function startKernelAssignmentAttempt(
  db: Db,
  dataDir: string,
  studentId: string,
  assignmentId: string,
  options: PracticeWorkflowStartOptions,
  client: AttemptStartClient,
): AttemptStartData {
  const { timeLimitMinutes } = options;
  const existing = db.transaction(
    (tx) => {
      const assignment = requireAssignmentVisible(db, studentId, assignmentId);
      const attempt = findKernelAttempt(db, studentId, assignmentId);
      if (attempt) {
        if (pendingKernelRefreeze(tx, attempt.id)) return undefined;
        return withBoundKernelActivity(
          db,
          dataDir,
          attempt,
          (runtime, activity) => {
            const fresh =
              attempt.activatedAt === null
                ? projectKernelDraftActivity(db, attempt, runtime)
                : attempt;
            if (
              client.snapshotProof === true &&
              reserveKernelRefreeze(
                db,
                tx,
                dataDir,
                assignment,
                fresh,
                activity,
              )
            )
              return undefined;
            return summarize(db, fresh, timeLimitMinutes);
          },
        );
      }
      reserveKernelOpening(db, tx, dataDir, assignment, studentId, options);
      return undefined;
    },
    { behavior: "immediate" },
  );
  if (existing) return existing;

  return db.transaction(
    (tx) => {
      requireAssignmentVisible(db, studentId, assignmentId);
      const attempt = findKernelAttempt(db, studentId, assignmentId);
      if (attempt) {
        const ticket = pendingKernelRefreeze(tx, attempt.id);
        if (ticket)
          return summarize(
            db,
            finishKernelRefreeze(
              db,
              tx,
              dataDir,
              attempt,
              ticket,
              client.snapshotProof === true,
            ),
            timeLimitMinutes,
          );
        return withBoundKernelActivity(db, dataDir, attempt, (runtime) =>
          summarize(
            db,
            attempt.activatedAt === null
              ? projectKernelDraftActivity(db, attempt, runtime)
              : attempt,
            timeLimitMinutes,
          ),
        );
      }
      const key = openingKey(assignmentId, studentId);
      const opening = tx
        .select()
        .from(kernelAssignmentOpenings)
        .where(key)
        .get();
      if (
        !opening ||
        opening.publication.practice.id !== assignmentId ||
        opening.publication.practice.version !== opening.practiceVersion
      )
        kernelAttemptUnavailable();
      const draft = kernelOpeningDraftSchema.parse(opening.draft);
      const receipt = withKernelRuntime(db, dataDir, false, (runtime) => {
        runtime.publish(opening.publication);
        const start = draft.prepared ? runtime.prepare : runtime.start;
        const actor = { role: "student", id: studentId } as const;
        const opened = start(actor, {
          protocolVersion: 1,
          operationId: `open:${assignmentId}`,
          practiceId: assignmentId,
          practiceVersion: opening.practiceVersion,
        });
        verifyKernelMaterialContext(
          db,
          runtime.read(actor, opened.activityId),
          assignmentId,
          draft,
        );
        return opened;
      });
      const projected = kernelDraftForAssignment(
        { id: assignmentId, courseId: draft.courseId },
        studentId,
        receipt.activityId,
        receipt.startedAt,
        {
          timeLimitMinutes: draft.timeLimitMinutes,
          ...(draft.workflowVersion === 1 && {
            practiceWorkflowVersion: 1,
            feedbackMode: "after_attempt",
            workflowRevision: 0,
          }),
        },
      );
      tx.insert(attempts).values(projected).run();
      insertKernelFrozenResponses(tx, projected.id, draft.responses);
      freezeAttemptContextSnapshotsWithin(
        tx,
        projected.id,
        draft.context ?? [],
        projected.startedAt,
      );
      tx.insert(kernelAttemptBindings)
        .values({
          attemptId: projected.id,
          assignmentId,
          practiceVersion: opening.practiceVersion,
          stepAttemptId: receipt.stepAttemptId,
        })
        .run();
      tx.delete(kernelAssignmentOpenings).where(key).run();
      return withAllowRedo(attemptSummaryOf(projected), false);
    },
    { behavior: "immediate" },
  );
}
