import { contextFromMemoAnchor } from "./learning-context-projection";

export { contextFromMemoAnchor } from "./learning-context-projection";

import type { LearningContext, MemoAnchor } from "@tutor/contract";
import { MEMO_ANCHOR_LABEL_MAX } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { courses, questions, students, units } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { requireVisibleCourseUnit } from "./course-service";

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

function sameFrozenCoordinates(
  context: LearningContext | null,
  expected: NonNullable<LearningContext["session"]>,
): boolean {
  return (
    context?.session != null &&
    context.session.attemptId === expected.attemptId &&
    context.session.questionRevisionId === expected.questionRevisionId &&
    context.session.questionNo === expected.questionNo &&
    context.session.questionCount === expected.questionCount
  );
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
      false,
      input.view?.surface === "attempt" ||
        input.view?.surface === "result" ||
        input.view?.surface === "lesson"
        ? { surface: input.view.surface }
        : { surface: "attempt" },
    );
    // 无host的公开坐标没有view可携带surface；只接受同一projector的合法公开序。
    // 明确的surface不回退猜测，view/null与客户端真实viewId均原样保留。
    if (input.view === null && !sameFrozenCoordinates(canonical, session)) {
      try {
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
          false,
          { surface: "lesson" },
        );
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        return notFound();
      }
    }
    if (!sameFrozenCoordinates(canonical, session)) return notFound();
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
      false,
      input.content.courseId === null
        ? {}
        : { courseId: input.content.courseId },
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
