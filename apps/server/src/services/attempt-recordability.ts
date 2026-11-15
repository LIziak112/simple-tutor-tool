import { and, asc, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { attempts } from "../db/schema.ts";

/** 与契约 isRecordableAttempt 同口径：仅进行中或完成且未作废的卷入账。 */
export function recordableAttemptWhere() {
  return and(
    isNull(attempts.abandonedAt),
    or(isNotNull(attempts.activatedAt), ne(attempts.status, "draft")),
  );
}

/** 课程完成矩阵与单元历史使用同一入账集合。 */
export function recordableCourseAttempts(db: Db, courseId: string) {
  return db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.courseId, courseId),
        eq(attempts.sourceType, "course"),
        recordableAttemptWhere(),
      ),
    )
    .orderBy(asc(attempts.attemptNo))
    .all();
}
