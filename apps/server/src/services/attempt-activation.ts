import {
  type AttemptActivateData,
  type AttemptActivateRequest,
  type AttemptOpenedQuery,
  attemptActivateDataSchema,
} from "@tutor/contract";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { attempts } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  requireAssignmentVisible,
  requireOwnAttempt,
} from "./attempt-access.ts";
import { touchAttemptActivity } from "./attempt-activity.ts";
import { attemptSummaryOf } from "./attempt-summary.ts";
import { requireVisibleCourseUnit } from "./course-service.ts";
import { assertDraftCourseVisible } from "./practice-workflow-wiring.ts";
import { requireVisibleStudentLecture } from "./student-course-service.ts";

/** 本机材料笔迹恢复先激活原快照；版本不符时绝不激活新快照。 */
export function activateAttempt(
  db: Db,
  studentId: string,
  attemptId: string,
  input: AttemptActivateRequest,
  now = new Date().toISOString(),
): AttemptActivateData {
  return db.transaction(
    () => {
      const attempt = requireOwnAttempt(db, studentId, attemptId);
      if (attempt.abandonedAt !== null)
        throw new HttpError(409, "ATTEMPT_ABANDONED", "这份作答已作废");
      assertDraftCourseVisible(db, studentId, attempt);
      if (attempt.frozenAt !== input.expectedFrozenAt) {
        throw new HttpError(
          409,
          "ATTEMPT_SNAPSHOT_CHANGED",
          "题目冻结版本已变化，请保留本机草稿并刷新练习",
        );
      }
      if (attempt.activatedAt === null) {
        if (attempt.status === "draft")
          touchAttemptActivity(db, attemptId, now);
        else
          db.update(attempts)
            .set({ activatedAt: attempt.startedAt })
            .where(eq(attempts.id, attemptId))
            .run();
      }
      const fresh = db
        .select()
        .from(attempts)
        .where(eq(attempts.id, attemptId))
        .get();
      return attemptActivateDataSchema.parse({
        attemptId,
        activatedAt: fresh?.activatedAt,
        phase: fresh?.status === "draft" ? "active" : "finished",
        frozenAt: fresh?.frozenAt,
      });
    },
    { behavior: "immediate" },
  );
}

/** 仅返回原冻结卷的安全摘要；只读、不创建、不重冻。 */
export function getOpenedAttempt(
  db: Db,
  studentId: string,
  input: AttemptOpenedQuery,
) {
  const conditions = [
    eq(attempts.studentId, studentId),
    eq(attempts.sourceType, input.sourceType),
    eq(attempts.status, "draft"),
    isNull(attempts.activatedAt),
    isNull(attempts.abandonedAt),
  ];
  if (input.sourceType === "course") {
    requireVisibleCourseUnit(db, studentId, input.courseId, input.unitId);
    conditions.push(
      eq(attempts.courseId, input.courseId),
      eq(attempts.unitId, input.unitId),
    );
  } else if (input.sourceType === "assignment") {
    requireAssignmentVisible(db, studentId, input.assignmentId);
    conditions.push(eq(attempts.assignmentId, input.assignmentId));
  } else {
    requireVisibleStudentLecture(
      db,
      studentId,
      input.lectureId,
      input.courseId,
    );
    conditions.push(eq(attempts.lectureId, input.lectureId));
  }
  const row = db
    .select()
    .from(attempts)
    .where(and(...conditions))
    .orderBy(desc(attempts.attemptNo))
    .get();
  return { attempt: row === undefined ? null : attemptSummaryOf(row) };
}
