import type { ExportCsvQuery } from "@tutor/contract";
import { and, asc, eq, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { attempts, students } from "../db/schema.ts";
import { readTeacherKernelConfirmations } from "./teacher-kernel-confirmations.ts";

/** 先恢复范围内可能已确认的卷，再以真实提交时刻筛选并排序。 */
export function readCsvAttempts(
  db: Db,
  teacherId: string,
  query: ExportCsvQuery,
  dataDir: string | undefined,
) {
  const source = and(
    query.studentId === undefined
      ? undefined
      : eq(attempts.studentId, query.studentId),
    query.courseId === undefined
      ? undefined
      : eq(attempts.courseId, query.courseId),
    query.assignmentId === undefined
      ? undefined
      : eq(attempts.assignmentId, query.assignmentId),
    query.sourceType === undefined
      ? undefined
      : eq(attempts.sourceType, query.sourceType),
  );
  const lastActivity = sql`coalesce(${attempts.submittedAt}, ${attempts.startedAt})`;
  const range = and(
    query.from === undefined
      ? undefined
      : sql`${lastActivity} >= ${query.from}`,
    query.to === undefined ? undefined : sql`${lastActivity} <= ${query.to}`,
  );
  const submitted = and(ne(attempts.status, "draft"), range);
  function read() {
    const confirmed = readTeacherKernelConfirmations(
      db,
      dataDir,
      teacherId,
      and(
        source,
        or(
          submitted,
          and(
            eq(attempts.status, "draft"),
            query.to === undefined
              ? undefined
              : lte(attempts.startedAt, query.to),
          ),
        ),
      ),
    );
    const rows = db
      .select({ attempt: attempts, studentName: students.displayName })
      .from(attempts)
      .innerJoin(students, eq(students.id, attempts.studentId))
      .where(and(eq(students.teacherId, teacherId), source, submitted))
      .orderBy(asc(lastActivity), asc(attempts.id))
      .all();
    return { rows, confirmed };
  }

  return dataDir === undefined
    ? read()
    : db.$client.transaction(read).immediate();
}
