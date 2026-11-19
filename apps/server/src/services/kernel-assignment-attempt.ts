import { createHash } from "node:crypto";
import type {
  AttemptStartData,
  PracticeWorkflowStartOptions,
} from "@tutor/contract";
import { and, eq, max } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Assignment, type Attempt, attempts } from "../db/schema.ts";
import {
  kernelAssignmentOpenings,
  kernelAssignmentVersions,
  kernelAttemptBindings,
} from "../db/schema-kernel-assignments.ts";
import { canonicalJsonOf } from "../lib/canonical-json.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  requireAssignmentVisible,
  requireOwnAttempt,
} from "./attempt-access.ts";
import { insertFrozenResponse } from "./attempt-freeze.ts";
import { withAllowRedo } from "./attempt-redo-policy.ts";
import { attemptSummaryOf } from "./attempt-summary.ts";
import { startOpenedAttemptTimer } from "./attempt-timing.ts";
import {
  assertKernelAssignmentPolicy,
  kernelDraftForAssignment,
  kernelOpeningDraftSchema,
  loadKernelAssignmentChoices,
} from "./kernel-assignment-input.ts";
import { kernelAssignmentPublication } from "./kernel-assignment-publication.ts";
import { isKernelAttempt } from "./kernel-assignment-routing.ts";
import {
  ensureKernelRuntimeStorage,
  kernelAttemptUnavailable,
  withKernelRuntime,
} from "./kernel-assignment-runtime.ts";
import { freezeAttemptContextSnapshotsWithin } from "./material-repository.ts";
import { resolveNewAttemptWorkflow } from "./practice-workflow-wiring.ts";
import type { Tx } from "./question-sync.ts";

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

function existingKernelAttempt(
  db: Db,
  dataDir: string,
  studentId: string,
  assignmentId: string,
  timeLimitMinutes: number | undefined,
): AttemptStartData | undefined {
  const attempt = db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.assignmentId, assignmentId),
        eq(attempts.studentId, studentId),
      ),
    )
    .get();
  if (!attempt) return undefined;
  verifyKernelBinding(db, dataDir, attempt);
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

  const { questions, responses } = loadKernelAssignmentChoices(
    db,
    assignment,
    studentId,
  );
  const publication = kernelAssignmentPublication(assignment, 1, questions);
  const fingerprint = createHash("sha256")
    .update(
      canonicalJsonOf({
        publication,
        frozen: responses.map(({ question, unitId, questionVersion }) => ({
          id: question.id,
          unitId,
          version: questionVersion,
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
  const practiceVersion = known?.practiceVersion ?? (latest?.version ?? 0) + 1;
  const canInitialize = !tx
    .select({ assignmentId: kernelAssignmentVersions.assignmentId })
    .from(kernelAssignmentVersions)
    .limit(1)
    .get();
  ensureKernelRuntimeStorage(db, dataDir, canInitialize);
  if (!known)
    tx.insert(kernelAssignmentVersions)
      .values({ assignmentId, practiceVersion, fingerprint })
      .run();
  tx.insert(kernelAssignmentOpenings)
    .values({
      assignmentId,
      studentId,
      practiceVersion,
      publication:
        practiceVersion === 1
          ? publication
          : kernelAssignmentPublication(assignment, practiceVersion, questions),
      draft: kernelOpeningDraftSchema.parse({
        courseId: assignment.courseId,
        timeLimitMinutes: options.timeLimitMinutes,
        workflowVersion: options.workflowVersion,
        responses,
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
): AttemptStartData {
  const { timeLimitMinutes } = options;
  const existing = db.transaction(
    (tx) => {
      const assignment = requireAssignmentVisible(db, studentId, assignmentId);
      const attempt = existingKernelAttempt(
        db,
        dataDir,
        studentId,
        assignmentId,
        timeLimitMinutes,
      );
      if (attempt) return attempt;
      reserveKernelOpening(db, tx, dataDir, assignment, studentId, options);
      return undefined;
    },
    { behavior: "immediate" },
  );
  if (existing) return existing;

  return db.transaction(
    (tx) => {
      requireAssignmentVisible(db, studentId, assignmentId);
      const attempt = existingKernelAttempt(
        db,
        dataDir,
        studentId,
        assignmentId,
        timeLimitMinutes,
      );
      if (attempt) return attempt;
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
        return runtime.start(
          { role: "student", id: studentId },
          {
            protocolVersion: 1,
            operationId: `open:${assignmentId}`,
            practiceId: assignmentId,
            practiceVersion: opening.practiceVersion,
          },
        );
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
      for (const {
        question,
        questionVersion,
        unitId,
        gradingPolicy,
      } of draft.responses)
        insertFrozenResponse(tx, {
          attemptId: projected.id,
          questionId: question.id,
          questionVersion,
          unitId,
          gradingPolicy,
          questionSnapshotJson: JSON.stringify(question),
        });
      freezeAttemptContextSnapshotsWithin(
        tx,
        projected.id,
        [],
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
