import type { LearningPackExportRequest } from "@tutor/contract";
import {
  and,
  asc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  assignments,
  attempts,
  courses,
  type ResponseRow,
  responses,
  students,
} from "../db/schema.ts";
import { chunk } from "../lib/chunk.ts";
import { HttpError } from "../lib/http-error.ts";
import { readTeacherKernelConfirmations } from "./teacher-kernel-confirmations.ts";

type Scope = LearningPackExportRequest["scope"];

// ---------- 范围校验（D7：域内逐个校验，404 不暴露存在性） ----------

/** 学生域校验：不存在或非本教师 → 404 STUDENT_NOT_FOUND；通过返回展示行 */
export function requireOwnedStudent(
  db: Db,
  teacherId: string,
  studentId: string,
): { id: string; displayName: string; archivedAt: string | null } {
  const row = db
    .select({
      id: students.id,
      displayName: students.displayName,
      archivedAt: students.archivedAt,
    })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.teacherId, teacherId)))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "STUDENT_NOT_FOUND", "学生不存在");
  }
  return row;
}

/** 课程域校验（D7）：不存在或非本教师 → 404 COURSE_NOT_FOUND */
function requireOwnedCourse(db: Db, teacherId: string, courseId: string): void {
  const row = db
    .select({ id: courses.id })
    .from(courses)
    .where(and(eq(courses.id, courseId), eq(courses.teacherId, teacherId)))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "COURSE_NOT_FOUND", "课程不存在");
  }
}

/** 作业域校验（D7）：不存在或非本教师 → 404 ASSIGNMENT_NOT_FOUND（软删作业可导出历史） */
function requireOwnedAssignment(
  db: Db,
  teacherId: string,
  assignmentId: string,
): void {
  const row = db
    .select({ id: assignments.id })
    .from(assignments)
    .where(
      and(
        eq(assignments.id, assignmentId),
        eq(assignments.teacherId, teacherId),
      ),
    )
    .get();
  if (row === undefined) {
    throw new HttpError(404, "ASSIGNMENT_NOT_FOUND", "作业不存在");
  }
}

export function authorizeLearningPackScope(
  db: Db,
  teacherId: string,
  scope: Scope,
) {
  // 去重保序，维持化名编号及原有逐项授权顺序。
  const roster = [...new Set(scope.studentIds)].map((id) =>
    requireOwnedStudent(db, teacherId, id),
  );
  if (scope.courseId !== undefined)
    requireOwnedCourse(db, teacherId, scope.courseId);
  if (scope.assignmentId !== undefined)
    requireOwnedAssignment(db, teacherId, scope.assignmentId);
  return roster;
}

/** 先恢复范围内已确认的内核卷，再按实际提交时刻选择整卷和冻结行。 */
export function readLearningPackAttempts(
  db: Db,
  dataDir: string,
  teacherId: string,
  scope: Scope,
  { fromIso, asOfIso }: { fromIso: string | null; asOfIso: string },
) {
  const courseId = scope.courseId;
  const scopeFilter = and(
    eq(students.teacherId, teacherId),
    scope.studentIds === undefined
      ? undefined
      : inArray(attempts.studentId, [...new Set(scope.studentIds)]),
    scope.assignmentId === undefined
      ? undefined
      : eq(attempts.assignmentId, scope.assignmentId),
    courseId === undefined
      ? undefined
      : or(
          eq(attempts.courseId, courseId),
          // 作业卷沿用原导出：快照课程或作业所在课程任一命中。
          exists(
            db
              .select({ id: assignments.id })
              .from(assignments)
              .where(
                and(
                  eq(assignments.id, attempts.assignmentId),
                  eq(assignments.teacherId, teacherId),
                  eq(assignments.courseId, courseId),
                ),
              ),
          ),
        ),
  );
  const submittedInWindow = and(
    ne(attempts.status, "draft"),
    isNotNull(attempts.submittedAt),
    lte(attempts.submittedAt, asOfIso),
    fromIso === null ? undefined : gte(attempts.submittedAt, fromIso),
  );
  return db.$client
    .transaction(() => {
      // 普通草稿由权威读取排除。仅尚未回写的确认需要按内核实际时刻再过滤。
      const confirmed = readTeacherKernelConfirmations(
        db,
        dataDir,
        teacherId,
        and(
          scopeFilter,
          or(
            submittedInWindow,
            and(eq(attempts.status, "draft"), lte(attempts.startedAt, asOfIso)),
          ),
        ),
      );
      const scopeAttempts = db
        .select({ attempt: attempts })
        .from(attempts)
        .innerJoin(students, eq(attempts.studentId, students.id))
        .where(and(scopeFilter, submittedInWindow))
        .orderBy(asc(attempts.submittedAt), asc(attempts.id))
        .all()
        .map(({ attempt }) => confirmed.get(attempt.id)?.attempt ?? attempt);
      const responsesByAttempt = new Map<string, ResponseRow[]>();
      const legacyIds = [];
      for (const { id } of scopeAttempts) {
        const facts = confirmed.get(id);
        if (facts === undefined) legacyIds.push(id);
        else responsesByAttempt.set(id, facts.rows);
      }
      for (const ids of chunk(legacyIds)) {
        for (const row of db
          .select()
          .from(responses)
          .where(inArray(responses.attemptId, ids))
          .orderBy(sql`rowid`)
          .all()) {
          const list = responsesByAttempt.get(row.attemptId);
          if (list === undefined) responsesByAttempt.set(row.attemptId, [row]);
          else list.push(row);
        }
      }
      return { scopeAttempts, responsesByAttempt };
    })
    .immediate();
}
