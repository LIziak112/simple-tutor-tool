import {
  type AttemptQuestionPublic,
  attemptQuestionPublicSchema,
  lessonQuestionIdsInDisplayOrder,
} from "@tutor/contract";
import { splitLessonBlocks } from "@tutor/md-dsl";
import type { Db } from "../db/client.ts";
import type { Attempt } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { requireUsableAttempt } from "./attempt-access.ts";
import {
  frozenMemberRefs,
  incompleteFrozenAttempt,
} from "./attempt-frozen-integrity.ts";
import { getStudentAttemptPaper } from "./attempt-service.ts";
import { requireVisibleStudentLecture } from "./student-course-service.ts";

/** 保留既有MCP入口名；通用冻结成员校验由共享职责承担。 */
export function assertStudentMcpFrozenMembers(db: Db, attemptId: string): void {
  frozenMemberRefs(db, attemptId);
}

/** 一次公开取卷建立目录，绝不逐题调用canonical重解析整卷。 */
export function studentMcpPublicQuestions(
  db: Db,
  studentId: string,
  attemptId: string,
): AttemptQuestionPublic[] {
  // 先完成旧卷合法lazy补全，再校验全体；不让损坏ref先进入公开schema抛INTERNAL。
  requireUsableAttempt(db, studentId, attemptId);
  const revisions = frozenMemberRefs(db, attemptId);
  const questions = getStudentAttemptPaper(
    db,
    studentId,
    attemptId,
  ).units.flatMap((unit) => unit.questions);
  if (
    questions.length !== revisions.size ||
    new Set(questions.map((question) => question.id)).size !== revisions.size ||
    questions.some(
      (question) => revisions.get(question.id) !== question.questionRevisionId,
    )
  )
    incompleteFrozenAttempt();
  return questions.map((question) =>
    attemptQuestionPublicSchema.parse(question),
  );
}

/** 只消费公开文本，包括所有可见干扰选项；不查看答案或答案侧布尔标记。 */
export function studentMcpQuestionMarkdowns(
  question: AttemptQuestionPublic,
): string[] {
  return [
    question.stemMd,
    ...(question.options ?? []),
    ...(question.matchingOptions?.options.map((option) => option.text) ?? []),
    ...(question.orderingItems?.map((item) => item.text) ?? []),
  ];
}

/** lesson当前正文序也须经真实来源课的可见门，排序规则仅消费公共helper。 */
export function studentMcpQuestionsInDisplayOrder(
  db: Db,
  studentId: string,
  attempt: Attempt,
  questions: AttemptQuestionPublic[],
  now: Date,
): AttemptQuestionPublic[] {
  if (attempt.sourceType !== "lesson") return questions;
  if (attempt.lectureId === null)
    throw new HttpError(404, "QUESTION_NOT_FOUND", "题目不存在或不可见");
  const { lecture } = requireVisibleStudentLecture(
    db,
    studentId,
    attempt.lectureId,
    attempt.courseId ?? undefined,
    now,
  );
  const byId = new Map(questions.map((question) => [question.id, question]));
  return lessonQuestionIdsInDisplayOrder(
    splitLessonBlocks(lecture.markdown),
    questions.map((question) => question.id),
  ).map((id) => {
    const question = byId.get(id);
    if (!question)
      throw new HttpError(404, "QUESTION_NOT_FOUND", "题目不存在或不可见");
    return question;
  });
}
