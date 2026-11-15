import type { LearningContext, MemoAnchor } from "@tutor/contract";
import {
  learningContextSchema,
  lessonQuestionIdsInDisplayOrder,
} from "@tutor/contract";
import { splitLessonBlocks } from "@tutor/md-dsl";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, courses, questions, students, units } from "../db/schema";
import { HttpError } from "../lib/http-error";
import {
  frozenRowsInDisplayOrder,
  getStudentAttemptPaper,
} from "./attempt-service";
import { assertDraftCourseVisible } from "./practice-workflow-wiring";
import { requireVisibleStudentLecture } from "./student-course-service";

function notFound(): never {
  throw new HttpError(
    404,
    "MEMO_ANCHOR_NOT_FOUND",
    "随笔来源不存在，或不是本人可见的",
  );
}
export interface LearningProjectionOptions {
  surface?: "attempt" | "result" | "lesson";
  courseId?: string;
}

/** 从本人可见的旧锚恢复稳定坐标。历史来源缺失时调用方保留 NULL，不猜题目版本。 */
export function contextFromMemoAnchor(
  db: Db,
  studentId: string,
  anchor: MemoAnchor,
  now = new Date(),
  historical = false,
  options: LearningProjectionOptions = {},
): LearningContext | null {
  if (anchor.kind === "none") return null;
  if (anchor.kind === "lecture") {
    const visible = requireVisibleStudentLecture(
      db,
      studentId,
      anchor.lectureId,
      options.courseId,
      now,
    );
    return learningContextSchema.parse({
      schemaVersion: 1,
      content: {
        courseId: visible.course.id,
        unitId: null,
        lectureId: anchor.lectureId,
        sectionId: anchor.sectionId,
        questionId: null,
        titles: {
          course: visible.course.title,
          unit: null,
          lecture: visible.lecture.title,
        },
      },
      session: null,
      view: null,
      deviceId: null,
    });
  }
  const attempt = db
    .select()
    .from(attempts)
    .where(
      and(eq(attempts.id, anchor.attemptId), eq(attempts.studentId, studentId)),
    )
    .get();
  if (attempt === undefined) return notFound();
  if (!historical) assertDraftCourseVisible(db, studentId, attempt);
  const entries = frozenRowsInDisplayOrder(db, attempt);
  let ids = entries.map((entry) => entry.row.questionId);
  if (options.surface !== undefined) {
    ids = getStudentAttemptPaper(db, studentId, attempt.id).units.flatMap(
      (unit) => unit.questions.map((q) => q.id),
    );
    if (options.surface === "lesson") {
      if (attempt.sourceType !== "lesson" || attempt.lectureId === null)
        return notFound();
      // 冻结题集合可读，不代表当前讲义正文可读；排序也必须经过其真实课程门。
      const { lecture } = requireVisibleStudentLecture(
        db,
        studentId,
        attempt.lectureId,
        attempt.courseId ?? undefined,
        now,
      );
      ids = lessonQuestionIdsInDisplayOrder(
        splitLessonBlocks(lecture.markdown),
        ids,
      );
    }
  }
  const index = ids.indexOf(anchor.questionId);
  const entry = entries.find(
    (entry) => entry.row.questionId === anchor.questionId,
  );
  if (index < 0) return notFound();
  if (entry === undefined) return notFound();
  const teacherId = db
    .select({ teacherId: students.teacherId })
    .from(students)
    .where(eq(students.id, studentId))
    .get()?.teacherId;
  if (teacherId == null) return notFound();
  const question = db
    .select({ unitId: questions.unitId })
    .from(questions)
    .where(
      and(
        eq(questions.id, anchor.questionId),
        eq(questions.teacherId, teacherId),
      ),
    )
    .get();
  const unitId =
    entry.unitId ??
    entry.row.unitId ??
    attempt.unitId ??
    question?.unitId ??
    null;
  const unit =
    unitId === null
      ? undefined
      : db
          .select()
          .from(units)
          .where(and(eq(units.id, unitId), eq(units.teacherId, teacherId)))
          .get();
  const course =
    attempt.courseId === null
      ? undefined
      : db
          .select()
          .from(courses)
          .where(
            and(
              eq(courses.id, attempt.courseId),
              eq(courses.teacherId, teacherId),
            ),
          )
          .get();
  const inferredLectureId = attempt.lectureId ?? unit?.lectureId ?? null;
  let lecture: { id: string; title: string } | null = null;
  if (inferredLectureId !== null) {
    try {
      lecture = requireVisibleStudentLecture(
        db,
        studentId,
        inferredLectureId,
        undefined,
        now,
      ).lecture;
    } catch (error) {
      // 推断来源不可见时不暴露其存在，也不阻断本人随笔保存。
      if (!(error instanceof HttpError)) throw error;
    }
  }
  return learningContextSchema.parse({
    schemaVersion: 1,
    content: {
      courseId: attempt.courseId,
      unitId,
      lectureId: lecture?.id ?? null,
      sectionId: null,
      questionId: anchor.questionId,
      titles: {
        course: course?.title ?? null,
        unit: unit?.title ?? null,
        lecture: lecture?.title ?? null,
      },
    },
    session: {
      attemptId: attempt.id,
      questionRevisionId: entry.row.id,
      questionNo: index + 1,
      questionCount: ids.length,
      settlementSeq: entry.row.settlementSeq,
    },
    view: null,
    deviceId: null,
  });
}
