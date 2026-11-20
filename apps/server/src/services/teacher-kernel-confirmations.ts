import type { AttemptResultCounts } from "@tutor/contract";
import { and, eq, isNotNull, isNull, ne, or, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  assignments,
  attempts,
  type ResponseRow,
  students,
} from "../db/schema.ts";
import {
  kernelAssignments,
  kernelAttemptBindings,
  kernelAttemptConfirmations,
} from "../db/schema-kernel-assignments.ts";
import { projectKernelDraftActivity } from "./kernel-assignment-activity.ts";
import {
  type RecoverKernelConfirmation,
  withKernelConfirmationReader,
} from "./kernel-assignment-confirmation-recovery.ts";
import { kernelDraftRowsOf } from "./kernel-assignment-facts.ts";
import { requireNoPendingKernelRefreeze } from "./kernel-assignment-refreeze-guard.ts";
import { hasKernelAssignmentTables } from "./kernel-assignment-routing.ts";
import {
  kernelAttemptUnavailable,
  readBoundKernelActivity,
} from "./kernel-assignment-runtime.ts";
import { recoverKernelChoiceSnapshot } from "./kernel-choice-amendments.ts";

interface TeacherKernelConfirmation
  extends ReturnType<RecoverKernelConfirmation> {
  resultCounts: AttemptResultCounts;
}

/** 单次读取已确认的教师域内作答。调用方另行缩小课程、学生和时间范围。 */
export function readTeacherKernelConfirmations(
  db: Db,
  dataDir: string | undefined,
  teacherId: string,
  filter: SQL | undefined,
): Map<string, TeacherKernelConfirmation> {
  return readTeacherKernelFacts(db, dataDir, teacherId, filter).confirmed;
}

/** 调用方锁定宿主、先收窄范围；一次连接读取正式确认和可选的有效草稿。 */
export function readTeacherKernelFacts(
  db: Db,
  dataDir: string | undefined,
  teacherId: string,
  filter: SQL | undefined,
  includeDrafts = false,
) {
  const confirmed = new Map<string, TeacherKernelConfirmation>();
  const drafts: ResponseRow[] = [];
  if (dataDir === undefined || !hasKernelAssignmentTables(db))
    return { confirmed, drafts };
  const scopes = db
    .select({
      attempt: attempts,
      binding: kernelAttemptBindings,
      ticket: kernelAttemptConfirmations,
    })
    .from(attempts)
    .innerJoin(students, eq(students.id, attempts.studentId))
    .innerJoin(
      kernelAssignments,
      eq(kernelAssignments.assignmentId, attempts.assignmentId),
    )
    .innerJoin(assignments, eq(assignments.id, attempts.assignmentId))
    .leftJoin(
      kernelAttemptBindings,
      eq(kernelAttemptBindings.attemptId, attempts.id),
    )
    .leftJoin(
      kernelAttemptConfirmations,
      eq(kernelAttemptConfirmations.attemptId, attempts.id),
    )
    .where(
      and(
        eq(students.teacherId, teacherId),
        eq(assignments.teacherId, teacherId),
        eq(attempts.sourceType, "assignment"),
        isNull(attempts.abandonedAt),
        includeDrafts
          ? undefined
          : or(
              ne(attempts.status, "draft"),
              isNotNull(kernelAttemptConfirmations.attemptId),
            ),
        filter,
      ),
    )
    .all();
  if (scopes.length === 0) return { confirmed, drafts };

  return withKernelConfirmationReader(db, dataDir, (runtime, recover) => {
    for (const { attempt, binding, ticket } of scopes) {
      if (binding === null) kernelAttemptUnavailable();
      if (includeDrafts && attempt.status === "draft") {
        requireNoPendingKernelRefreeze(db, attempt);
        recoverKernelChoiceSnapshot(db, dataDir, attempt.id);
      }
      const activity = readBoundKernelActivity(runtime, attempt, binding);
      if (activity.status === "completed") {
        if (ticket === null) kernelAttemptUnavailable();
        const facts = recover(attempt, binding, ticket);
        confirmed.set(attempt.id, {
          ...facts,
          resultCounts: {
            correctCount: facts.rows.filter((row) => row.finalCorrect === true)
              .length,
            totalCount: facts.rows.length,
            pendingCount: 0,
            pendingSelfReviewCount: 0,
          },
        });
        continue;
      }
      if (activity.status !== "active" || attempt.status !== "draft")
        kernelAttemptUnavailable();
      if (
        includeDrafts &&
        projectKernelDraftActivity(db, attempt, runtime).activatedAt !== null
      ) {
        for (const row of kernelDraftRowsOf(db, attempt, activity))
          drafts.push(row);
      }
    }
    return { confirmed, drafts };
  });
}
