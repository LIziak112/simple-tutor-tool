import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, responses } from "../db/schema";
import { recordableAttemptWhere } from "./attempt-recordability.ts";
import { requireVisibleCourseUnit } from "./course-service";
import { requireOwnMemoRow, toMemo } from "./memo-read";
import { assertDraftCourseVisible } from "./practice-workflow-wiring";
import {
  requireStudentCourseAccess,
  requireVisibleStudentLecture,
} from "./student-course-service";

/** 只解析目标，绝不读取题面、创建/激活作答或改写历史来源。 */
export function memoSourceTarget(db: Db, studentId: string, memoId: string) {
  const memo = toMemo(requireOwnMemoRow(db, studentId, memoId));
  const context = memo.context;
  const content = context?.content;
  const unavailable = { kind: "unavailable" as const };
  const attemptTarget = (
    attemptId: string,
    questionId: string,
    revisionId?: string,
  ) => {
    const attempt = db
      .select()
      .from(attempts)
      .where(and(eq(attempts.id, attemptId), eq(attempts.studentId, studentId)))
      .get();
    if (attempt === undefined) return null;
    try {
      assertDraftCourseVisible(db, studentId, attempt);
    } catch {
      return null;
    }
    const row = db
      .select({ id: responses.id })
      .from(responses)
      .innerJoin(attempts, eq(attempts.id, responses.attemptId))
      .where(
        and(
          eq(attempts.id, attemptId),
          eq(attempts.studentId, studentId),
          recordableAttemptWhere(),
          eq(responses.questionId, questionId),
          isNotNull(responses.questionSnapshotJson),
          revisionId === undefined ? undefined : eq(responses.id, revisionId),
        ),
      )
      .get();
    return row === undefined
      ? null
      : { kind: "attempt" as const, attemptId, questionId };
  };
  // 原卷仅使用本人的冻结行，保留已完成历史卷可读政策。
  if (memo.anchor.kind === "question") {
    const original = attemptTarget(
      memo.anchor.attemptId,
      memo.anchor.questionId,
      context?.session?.questionRevisionId,
    );
    if (original !== null) return { ...original, replaced: false };
  }
  if (memo.anchor.kind === "lecture") {
    try {
      requireVisibleStudentLecture(db, studentId, memo.anchor.lectureId);
      return {
        kind: "lecture" as const,
        lectureId: memo.anchor.lectureId,
        sectionId: memo.anchor.sectionId,
      };
    } catch {
      return unavailable;
    }
  }
  if (content?.courseId == null) return unavailable;
  try {
    requireStudentCourseAccess(db, studentId, content.courseId);
    if (content.unitId !== null) {
      try {
        requireVisibleCourseUnit(
          db,
          studentId,
          content.courseId,
          content.unitId,
        );
        if (content.questionId !== null) {
          const recent = db
            .select({ id: attempts.id })
            .from(attempts)
            .innerJoin(responses, eq(responses.attemptId, attempts.id))
            .where(
              and(
                eq(attempts.studentId, studentId),
                eq(attempts.courseId, content.courseId),
                // 旧单单元冻结行未记unitId时，可用明确的卷级坐标；多单元卷不可猜。
                or(
                  eq(responses.unitId, content.unitId),
                  and(
                    isNull(responses.unitId),
                    eq(attempts.unitId, content.unitId),
                  ),
                ),
                eq(responses.questionId, content.questionId),
                isNotNull(responses.questionSnapshotJson),
                recordableAttemptWhere(),
              ),
            )
            .orderBy(desc(attempts.startedAt))
            .all();
          for (const a of recent) {
            const target = attemptTarget(a.id, content.questionId);
            if (target !== null) return { ...target, replaced: true };
          }
        }
        return {
          kind: "unit" as const,
          courseId: content.courseId,
          unitId: content.unitId,
        };
      } catch {
        /* 只降级到当前可见的课程，不区分隐藏和已删。 */
      }
    }
    return { kind: "course" as const, courseId: content.courseId };
  } catch {
    return unavailable;
  }
}
