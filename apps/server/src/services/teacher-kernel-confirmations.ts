import type { AttemptResultCounts } from "@tutor/contract";
import {
  and,
  eq,
  exists,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
} from "drizzle-orm";
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
import {
  kernelCourseOpenings,
  kernelLessonOpenings,
  kernelQuestionDeliveries,
  kernelWrongOpenings,
} from "../db/schema-kernel-question-delivery.ts";
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
import { readQuestionDeliveryFacts } from "./kernel-question-delivery.ts";
import { attemptResultCountsOfRows } from "./result-counts.ts";

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
      lesson: kernelLessonOpenings.attemptId,
      course: kernelCourseOpenings.attemptId,
      wrong: kernelWrongOpenings.attemptId,
    })
    .from(attempts)
    .innerJoin(students, eq(students.id, attempts.studentId))
    .leftJoin(
      kernelAssignments,
      eq(kernelAssignments.assignmentId, attempts.assignmentId),
    )
    .leftJoin(assignments, eq(assignments.id, attempts.assignmentId))
    .leftJoin(
      kernelLessonOpenings,
      eq(kernelLessonOpenings.attemptId, attempts.id),
    )
    .leftJoin(
      kernelCourseOpenings,
      eq(kernelCourseOpenings.attemptId, attempts.id),
    )
    .leftJoin(
      kernelWrongOpenings,
      eq(kernelWrongOpenings.attemptId, attempts.id),
    )
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
        or(
          and(
            eq(assignments.teacherId, teacherId),
            eq(attempts.sourceType, "assignment"),
            isNotNull(kernelAssignments.assignmentId),
          ),
          and(
            eq(kernelLessonOpenings.teacherId, teacherId),
            eq(attempts.sourceType, "lesson"),
          ),
          and(
            eq(kernelCourseOpenings.teacherId, teacherId),
            eq(attempts.sourceType, "course"),
          ),
          and(
            eq(kernelWrongOpenings.teacherId, teacherId),
            eq(attempts.sourceType, "wrong"),
          ),
        ),
        isNull(attempts.abandonedAt),
        includeDrafts
          ? undefined
          : or(
              ne(attempts.status, "draft"),
              isNotNull(kernelAttemptConfirmations.attemptId),
              exists(
                db
                  .select({ id: kernelQuestionDeliveries.attemptId })
                  .from(kernelQuestionDeliveries)
                  .where(eq(kernelQuestionDeliveries.attemptId, attempts.id)),
              ),
            ),
        filter,
      ),
    )
    .all();
  if (scopes.length === 0) return { confirmed, drafts };

  return withKernelConfirmationReader(db, dataDir, (runtime, recover) => {
    for (const { attempt, binding, ticket, lesson, course, wrong } of scopes) {
      const shared = readQuestionDeliveryFacts(db, dataDir, attempt);
      if (shared) {
        const rows =
          shared.attempt.status === "draft"
            ? shared.rows.filter((row) => row.submittedAt !== null)
            : shared.rows;
        if (rows.length)
          confirmed.set(attempt.id, {
            attempt: shared.attempt,
            rows,
            resultCounts: attemptResultCountsOfRows(rows),
          });
        if (
          includeDrafts &&
          shared.attempt.status === "draft" &&
          shared.attempt.activatedAt !== null
        )
          drafts.push(...shared.rows.filter((row) => row.submittedAt === null));
        continue;
      }
      if (
        binding === null ||
        lesson !== null ||
        course !== null ||
        wrong !== null
      )
        kernelAttemptUnavailable();
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
          resultCounts: attemptResultCountsOfRows(facts.rows),
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
