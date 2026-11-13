import type { LearningContext, MemoAnchor } from "@tutor/contract";
import { learningContextSchema, MEMO_ANCHOR_LABEL_MAX } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, courses, questions, students, units } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { frozenRowsInDisplayOrder } from "./attempt-service";
import { requireVisibleCourseUnit } from "./course-service";
import { assertDraftCourseVisible } from "./practice-workflow-wiring";
import { requireVisibleStudentLecture } from "./student-course-service";

function notFound(): never {
  throw new HttpError(
    404,
    "MEMO_ANCHOR_NOT_FOUND",
    "随笔来源不存在，或不是本人可见的",
  );
}

/** 新上下文可独立传入，兼容锚与旧列表索引由同一份已核对坐标生成。 */
export function memoAnchorFromContext(
  context: LearningContext | null,
): MemoAnchor {
  if (
    context?.session !== null &&
    context?.session !== undefined &&
    context.content.questionId !== null
  ) {
    return {
      kind: "question",
      attemptId: context.session.attemptId,
      questionId: context.content.questionId,
      label:
        `第 ${context.session.questionNo} 题 · ${context.content.titles.unit ?? context.content.titles.course ?? "作答"}`.slice(
          0,
          MEMO_ANCHOR_LABEL_MAX,
        ),
    };
  }
  if (context?.content.lectureId != null)
    return {
      kind: "lecture",
      lectureId: context.content.lectureId,
      sectionId: context.content.sectionId,
      label: (context.content.titles.lecture ?? "讲义").slice(
        0,
        MEMO_ANCHOR_LABEL_MAX,
      ),
    };
  return { kind: "none" };
}

/** 从本人可见的旧锚恢复稳定坐标。历史来源缺失时调用方保留 NULL，不猜题目版本。 */
export function contextFromMemoAnchor(
  db: Db,
  studentId: string,
  anchor: MemoAnchor,
  now = new Date(),
  historical = false,
): LearningContext | null {
  if (anchor.kind === "none") return null;
  if (anchor.kind === "lecture") {
    const visible = requireVisibleStudentLecture(
      db,
      studentId,
      anchor.lectureId,
      undefined,
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
  const index = entries.findIndex(
    (entry) => entry.row.questionId === anchor.questionId,
  );
  const entry = entries[index];
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
      questionCount: entries.length,
      settlementSeq: null,
    },
    view: null,
    deviceId: null,
  });
}

/** 客户端坐标必须核对；名称快照以本人可见的服务端资料为准。 */
export function resolveMemoContext(
  db: Db,
  studentId: string,
  input: LearningContext | undefined,
  anchor: MemoAnchor,
  now = new Date(),
): LearningContext | null {
  if (input === undefined) {
    try {
      return contextFromMemoAnchor(db, studentId, anchor, now);
    } catch (error) {
      if (error instanceof HttpError) return null;
      throw error;
    }
  }
  let canonical: LearningContext | null;
  const session = input.session;
  if (session !== null) {
    if (input.content.questionId === null) return notFound();
    if (
      anchor.kind !== "none" &&
      (anchor.kind !== "question" ||
        anchor.attemptId !== session.attemptId ||
        anchor.questionId !== input.content.questionId)
    )
      return notFound();
    canonical = contextFromMemoAnchor(
      db,
      studentId,
      {
        kind: "question",
        attemptId: session.attemptId,
        questionId: input.content.questionId,
        label: "作答",
      },
      now,
    );
    if (
      canonical?.session === null ||
      canonical === null ||
      canonical.session.questionRevisionId !== session.questionRevisionId ||
      canonical.session.questionNo !== session.questionNo ||
      canonical.session.questionCount !== session.questionCount ||
      session.settlementSeq !== null
    )
      return notFound();
  } else if (
    input.content.lectureId !== null &&
    input.content.questionId === null
  ) {
    if (
      anchor.kind !== "none" &&
      (anchor.kind !== "lecture" ||
        anchor.lectureId !== input.content.lectureId ||
        anchor.sectionId !== input.content.sectionId)
    )
      return notFound();
    canonical = contextFromMemoAnchor(
      db,
      studentId,
      {
        kind: "lecture",
        lectureId: input.content.lectureId,
        sectionId: input.content.sectionId,
        label: "讲义",
      },
      now,
    );
  } else if (
    input.content.courseId !== null &&
    input.content.unitId !== null &&
    anchor.kind === "none"
  ) {
    const { courseId, unitId, questionId } = input.content;
    requireVisibleCourseUnit(db, studentId, courseId, unitId, now);
    const teacherId = db
      .select({ teacherId: students.teacherId })
      .from(students)
      .where(eq(students.id, studentId))
      .get()?.teacherId;
    if (teacherId == null) return notFound();
    const unit = db
      .select()
      .from(units)
      .where(and(eq(units.id, unitId), eq(units.teacherId, teacherId)))
      .get();
    const course = db
      .select()
      .from(courses)
      .where(eq(courses.id, courseId))
      .get();
    if (
      questionId !== null &&
      db
        .select({ id: questions.id })
        .from(questions)
        .where(
          and(
            eq(questions.id, questionId),
            eq(questions.unitId, unitId),
            eq(questions.teacherId, teacherId),
          ),
        )
        .get() === undefined
    )
      return notFound();
    canonical = {
      ...input,
      content: {
        ...input.content,
        lectureId: null,
        sectionId: null,
        titles: {
          course: course?.title ?? null,
          unit: unit?.title ?? null,
          lecture: null,
        },
      },
    };
  } else if (
    Object.entries(input.content).every(
      ([key, value]) => key === "titles" || value === null,
    ) &&
    anchor.kind === "none"
  ) {
    canonical = {
      ...input,
      content: {
        ...input.content,
        titles: { course: null, unit: null, lecture: null },
      },
    };
  } else return notFound();
  if (
    canonical === null ||
    (
      ["courseId", "unitId", "lectureId", "sectionId", "questionId"] as const
    ).some((key) => input.content[key] !== canonical.content[key])
  )
    return notFound();
  return { ...canonical, view: input.view, deviceId: input.deviceId };
}
