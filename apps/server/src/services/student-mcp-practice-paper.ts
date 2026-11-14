import {
  type AttemptQuestionPublic,
  attemptQuestionPublicSchema,
  lessonQuestionIdsInDisplayOrder,
  questionRevisionIdSchema,
} from "@tutor/contract";
import { splitLessonBlocks } from "@tutor/md-dsl";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Attempt, responses } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { requireUsableAttempt } from "./attempt-access.ts";
import { getStudentAttemptPaper } from "./attempt-service.ts";
import { questionSnapshotOf } from "./snapshot.ts";
import { requireVisibleStudentLecture } from "./student-course-service.ts";

function incomplete(): never {
  throw new HttpError(
    409,
    "ATTEMPT_CONTEXT_BROKEN",
    "这份练习的冻结题目数据不完整，请联系老师检查",
  );
}

/** 不重新编号：已完成既有owner/lazy兼容门后，校验所有冻结成员和公开身份。 */
export function assertStudentMcpFrozenMembers(db: Db, attemptId: string): void {
  frozenMemberRefs(db, attemptId);
}

function frozenMemberRefs(
  db: Db,
  attemptId: string,
): ReadonlyMap<string, string> {
  const rows = db
    .select({
      id: responses.id,
      questionId: responses.questionId,
      snapshot: responses.questionSnapshotJson,
    })
    .from(responses)
    .where(eq(responses.attemptId, attemptId))
    .all();
  const revisions = new Map<string, string>();
  for (const row of rows) {
    const snapshot =
      row.snapshot === null ? null : questionSnapshotOf(row.snapshot);
    if (
      snapshot === null ||
      snapshot.id !== row.questionId ||
      revisions.has(row.questionId) ||
      !questionRevisionIdSchema.safeParse(row.id).success
    )
      incomplete();
    revisions.set(row.questionId, row.id);
  }
  return revisions;
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
    incomplete();
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
