import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { attempts } from "../db/schema.ts";
import type { AssignmentAttemptSummary } from "./assignment-attempt-status.ts";
import { recordableAttemptWhere } from "./attempt-recordability.ts";

/**
 * 各作业下的 attempt 归组（assignmentId → (studentId → status 列表)）。
 * course 来源 assignmentId 为 null 天然不进组；用于 locked 判定与四态统计。
 */
export function attemptGroupsByAssignment(
  db: Db,
): Map<string, Map<string, AssignmentAttemptSummary[]>> {
  const map = new Map<string, Map<string, AssignmentAttemptSummary[]>>();
  for (const row of db
    .select({
      assignmentId: attempts.assignmentId,
      studentId: attempts.studentId,
      attemptId: attempts.id,
      status: attempts.status,
      startedAt: attempts.startedAt,
      attemptNo: attempts.attemptNo,
    })
    .from(attempts)
    .where(and(isNotNull(attempts.assignmentId), recordableAttemptWhere()))
    .all()) {
    const assignmentId = row.assignmentId;
    if (assignmentId === null) continue;
    const byStudent = map.get(assignmentId) ?? new Map();
    const list = byStudent.get(row.studentId) ?? [];
    list.push({
      status: row.status,
      attemptId: row.attemptId,
      startedAt: row.startedAt,
      attemptNo: row.attemptNo,
    });
    byStudent.set(row.studentId, list);
    map.set(assignmentId, byStudent);
  }
  return map;
}

/** 该作业是否存在任一 attempt（D14 内容锁定判定；含已移出学生的历史 attempt） */
export function hasAttempt(db: Db, assignmentId: string): boolean {
  return (
    db
      .select({ id: attempts.id })
      .from(attempts)
      .where(eq(attempts.assignmentId, assignmentId))
      .get() !== undefined
  );
}

/** 内容锁保护物理卷与FK；与是否入账的统计集合分开。 */
export function physicallyLockedAssignmentIds(
  db: Db,
  ids: string[],
): ReadonlySet<string> {
  return new Set(
    db
      .select({ id: attempts.assignmentId })
      .from(attempts)
      .where(inArray(attempts.assignmentId, ids))
      .all()
      .flatMap((row) => (row.id === null ? [] : [row.id])),
  );
}
