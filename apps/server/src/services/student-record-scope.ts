import type { StudentRecordsQuery } from "@tutor/contract";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { assignmentStudents, assignments, attempts } from "../db/schema.ts";

export function studentRecordSourceWhere(query: StudentRecordsQuery) {
  return and(
    query.sourceType === undefined
      ? undefined
      : eq(attempts.sourceType, query.sourceType),
    query.courseId === undefined
      ? undefined
      : eq(attempts.courseId, query.courseId),
    query.assignmentId === undefined
      ? undefined
      : eq(attempts.assignmentId, query.assignmentId),
  );
}

export function reachableAssignmentDrafts(
  db: Db,
  studentId: string,
  assignmentId: string | typeof attempts.assignmentId,
) {
  return db
    .select({ studentId: assignmentStudents.studentId })
    .from(assignmentStudents)
    .innerJoin(assignments, eq(assignments.id, assignmentStudents.assignmentId))
    .where(
      and(
        eq(assignmentStudents.assignmentId, assignmentId),
        eq(assignmentStudents.studentId, studentId),
        isNull(assignmentStudents.removedAt),
        isNull(assignments.deletedAt),
      ),
    );
}
