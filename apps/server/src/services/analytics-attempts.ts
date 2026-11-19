import type { AnalyticsQuery } from "@tutor/contract";
import {
  and,
  asc,
  eq,
  exists,
  gte,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { assignments, attempts, students } from "../db/schema.ts";
import { recordableAttemptWhere } from "./attempt-recordability.ts";
import { readTeacherKernelConfirmations } from "./teacher-kernel-confirmations.ts";

export type AnalyticsView = (
  | { kind: "overview" | "questions" }
  | { kind: "student"; studentId: string }
) & { dataDir?: string | undefined };

/** 先按原筛选恢复可能入账的内核确认，再按宿主时间与状态构建学情输入。 */
export function loadAnalyticsAttempts(
  db: Db,
  teacherId: string,
  query: AnalyticsQuery,
  fromIso: string | null,
  nowIso: string,
  view: AnalyticsView,
  courseScopeValid: boolean,
) {
  // 旧作业卷的 courseId 为空时才回看作业所属课程。快照归属优先。
  const courseId = query.courseId;
  const courseCondition =
    courseId === undefined
      ? undefined
      : or(
          eq(attempts.courseId, courseId),
          and(
            isNull(attempts.courseId),
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
  const timeCondition = and(
    ne(attempts.status, "draft"),
    isNotNull(attempts.submittedAt),
    fromIso === null ? undefined : gte(attempts.submittedAt, fromIso),
    lte(attempts.submittedAt, nowIso),
    ne(attempts.sourceType, "wrong"),
    or(eq(attempts.sourceType, "assignment"), eq(attempts.attemptNo, 1)),
  );
  if (!courseScopeValid)
    return {
      allAttempts: [],
      qualifying: [],
      confirmed: new Map() as ReturnType<typeof readTeacherKernelConfirmations>,
    };
  const studentCondition =
    view.kind === "student"
      ? eq(attempts.studentId, view.studentId)
      : undefined;
  const confirmed = readTeacherKernelConfirmations(
    db,
    view.dataDir,
    teacherId,
    and(
      courseCondition,
      studentCondition,
      view.kind === "questions"
        ? and(
            lte(attempts.startedAt, nowIso),
            or(eq(attempts.status, "draft"), timeCondition),
          )
        : undefined,
    ),
  );
  const rows = db
    .select({
      attempt: attempts,
      qualifies: sql<number>`case when ${timeCondition} then 1 else 0 end`,
    })
    .from(attempts)
    .innerJoin(students, eq(attempts.studentId, students.id))
    .where(
      and(
        eq(students.teacherId, teacherId),
        recordableAttemptWhere(),
        courseCondition,
        studentCondition,
        view.kind === "questions" ? timeCondition : undefined,
      ),
    )
    .orderBy(asc(attempts.submittedAt), asc(attempts.id))
    .all()
    .map(({ attempt, qualifies }) => ({
      attempt: confirmed.get(attempt.id)?.attempt ?? attempt,
      qualifies,
    }));
  return {
    allAttempts: rows.map(({ attempt }) => attempt),
    qualifying: rows
      .filter(({ qualifies }) => qualifies === 1)
      .map(({ attempt }) => attempt),
    confirmed,
  };
}
