import type {
  PendingMarkListQuery,
  TeacherAttemptListQuery,
} from "@tutor/contract";
import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { attempts, responses, students } from "../db/schema.ts";
import { needsTeacherMark } from "./attempt-final-outcome.ts";
import { recordableAttemptWhere } from "./attempt-recordability.ts";
import { submittedTeacherPendingSql } from "./pending-mark.ts";
import { readTeacherKernelConfirmations } from "./teacher-kernel-confirmations.ts";

function workbenchScope(query: PendingMarkListQuery) {
  return and(
    query.studentId === undefined
      ? undefined
      : eq(attempts.studentId, query.studentId),
    query.courseId === undefined
      ? undefined
      : eq(attempts.courseId, query.courseId),
    query.assignmentId === undefined
      ? undefined
      : eq(attempts.assignmentId, query.assignmentId),
  );
}

export function readTeacherAttemptPage(
  db: Db,
  teacherId: string,
  query: TeacherAttemptListQuery,
  dataDir: string | undefined,
) {
  const activity = sql`coalesce(${attempts.submittedAt}, ${attempts.startedAt})`;
  const scope = and(
    workbenchScope(query),
    query.unitId === undefined ? undefined : eq(attempts.unitId, query.unitId),
    query.sourceType === undefined
      ? undefined
      : eq(attempts.sourceType, query.sourceType),
    query.startedFrom === undefined
      ? undefined
      : sql`julianday(${attempts.startedAt}) >= julianday(${query.startedFrom})`,
    query.startedTo === undefined
      ? undefined
      : sql`julianday(${attempts.startedAt}) <= julianday(${query.startedTo})`,
  );
  const range = and(
    query.from === undefined ? undefined : sql`${activity} >= ${query.from}`,
    query.to === undefined ? undefined : sql`${activity} <= ${query.to}`,
  );
  function read() {
    // 只有尚未恢复的正式确认会改变筛选入账和顺序；已有宿主状态的卷只补本页成绩。
    const confirmed = readTeacherKernelConfirmations(
      db,
      dataDir,
      teacherId,
      and(
        scope,
        eq(attempts.status, "draft"),
        query.status === "draft"
          ? range
          : query.to === undefined
            ? undefined
            : lte(attempts.startedAt, query.to),
      ),
    );
    const where = and(
      eq(students.teacherId, teacherId),
      recordableAttemptWhere(),
      scope,
      range,
      query.status === undefined
        ? undefined
        : eq(attempts.status, query.status),
    );
    const total =
      db
        .select({ n: sql<number>`count(*)` })
        .from(attempts)
        .innerJoin(students, eq(attempts.studentId, students.id))
        .where(where)
        .get()?.n ?? 0;
    const rows = db
      .select({ attempt: attempts, studentName: students.displayName })
      .from(attempts)
      .innerJoin(students, eq(attempts.studentId, students.id))
      .where(where)
      .orderBy(desc(activity), desc(attempts.id))
      .limit(query.limit)
      .offset(query.offset)
      .all();
    const missing = rows
      .filter(
        ({ attempt }) =>
          attempt.status !== "draft" && !confirmed.has(attempt.id),
      )
      .map(({ attempt }) => attempt.id);
    if (missing.length > 0) {
      for (const [id, facts] of readTeacherKernelConfirmations(
        db,
        dataDir,
        teacherId,
        inArray(attempts.id, missing),
      ))
        confirmed.set(id, facts);
    }
    return {
      rows: rows.map(({ attempt, studentName }) => ({
        attempt: confirmed.get(attempt.id)?.attempt ?? attempt,
        studentName,
      })),
      total,
      confirmed,
    };
  }

  return dataDir === undefined
    ? read()
    : db.$client.transaction(read).immediate();
}

export function readPendingMarkRows(
  db: Db,
  teacherId: string,
  query: PendingMarkListQuery,
  dataDir: string | undefined,
) {
  const scope = workbenchScope(query);
  function read() {
    const confirmed = readTeacherKernelConfirmations(
      db,
      dataDir,
      teacherId,
      scope,
    );
    const confirmedIds = [...confirmed.keys()];
    const pending = new Map(
      [...confirmed.values()].flatMap(({ rows }) =>
        rows.filter(needsTeacherMark).map((row) => [row.id, row] as const),
      ),
    );
    return db
      .select({
        response: responses,
        attempt: attempts,
        studentName: students.displayName,
      })
      .from(responses)
      .innerJoin(attempts, eq(responses.attemptId, attempts.id))
      .innerJoin(students, eq(attempts.studentId, students.id))
      .where(
        and(
          eq(students.teacherId, teacherId),
          or(
            and(
              submittedTeacherPendingSql,
              confirmedIds.length === 0
                ? undefined
                : sql`${attempts.id} not in (select value from json_each(${JSON.stringify(confirmedIds)}))`,
            ),
            pending.size === 0
              ? undefined
              : sql`${responses.id} in (select value from json_each(${JSON.stringify([...pending.keys()])}))`,
          ),
          scope,
        ),
      )
      .orderBy(
        asc(attempts.submittedAt),
        asc(attempts.id),
        asc(responses.questionId),
      )
      .all()
      .flatMap((row) => {
        const facts = confirmed.get(row.attempt.id);
        if (!facts) return [row];
        const response = pending.get(row.response.id);
        return response ? [{ ...row, response, attempt: facts.attempt }] : [];
      });
  }
  return dataDir === undefined
    ? read()
    : db.$client.transaction(read).immediate();
}
