import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { assignments, attempts } from "../db/schema.ts";

/**
 * D4 删除条件：课程是否关联作答/作业记录（T2A.7 口径，直接按 courseId 判）：
 * - ∃ attempts.courseId = 该课程（课程练习作答，含未交卷草稿）；
 * - ∃ assignments.courseId = 该课程（按课程布置的作业——多单元作业 attempt 的
 *   unitId 为 null，原「按单元交集」口径会漏判；assignments 命中也挡删除，
 *   保护 assignments.courseId 外键）。
 * 任一命中即拒删（提示改用归档）。
 */
export function courseHasAttempts(db: Db, courseId: string): boolean {
  const attemptHit =
    db
      .select({ id: attempts.id })
      .from(attempts)
      .where(eq(attempts.courseId, courseId))
      .get() !== undefined;
  if (attemptHit) return true;
  return (
    db
      .select({ id: assignments.id })
      .from(assignments)
      .where(eq(assignments.courseId, courseId))
      .get() !== undefined
  );
}
