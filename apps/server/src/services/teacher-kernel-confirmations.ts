import { and, eq, isNotNull, isNull, ne, or, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { assignments, attempts, students } from "../db/schema.ts";
import {
  kernelAssignments,
  kernelAttemptBindings,
  kernelAttemptConfirmations,
} from "../db/schema-kernel-assignments.ts";
import {
  type RecoverKernelConfirmation,
  withKernelConfirmationReader,
} from "./kernel-assignment-confirmation-recovery.ts";
import { hasKernelAssignmentTables } from "./kernel-assignment-routing.ts";
import {
  kernelAttemptUnavailable,
  readBoundKernelActivity,
} from "./kernel-assignment-runtime.ts";

/** 单次读取已确认的教师域内作答。调用方另行缩小课程、学生和时间范围。 */
export function readTeacherKernelConfirmations(
  db: Db,
  dataDir: string | undefined,
  teacherId: string,
  filter: SQL | undefined,
): Map<string, ReturnType<RecoverKernelConfirmation>> {
  if (dataDir === undefined || !hasKernelAssignmentTables(db)) return new Map();
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
        or(
          ne(attempts.status, "draft"),
          isNotNull(kernelAttemptConfirmations.attemptId),
        ),
        filter,
      ),
    )
    .all();
  if (scopes.length === 0) return new Map();

  return withKernelConfirmationReader(db, dataDir, (runtime, recover) => {
    const confirmed = new Map<string, ReturnType<RecoverKernelConfirmation>>();
    for (const { attempt, binding, ticket } of scopes) {
      if (binding === null || ticket === null) kernelAttemptUnavailable();
      const activity = readBoundKernelActivity(runtime, attempt, binding);
      if (activity.status === "completed")
        confirmed.set(attempt.id, recover(attempt, binding, ticket));
      else if (activity.status !== "active" || attempt.status !== "draft")
        kernelAttemptUnavailable();
    }
    return confirmed;
  });
}
