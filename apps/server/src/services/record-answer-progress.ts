import type { AttemptAnswerProgress } from "@tutor/contract";
import { isUnanswered } from "@tutor/grading";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { type Attempt, ink, responses } from "../db/schema";
import { answerOf, attemptQuestionRows } from "./attempt-service";

/** 已核验归属的进行中记录，只返回已做/总题数，不计算或输出判定。 */
export function recordAnswerProgress(
  db: Db,
  attempts: readonly Attempt[],
): Map<string, AttemptAnswerProgress> {
  const result = new Map<string, AttemptAnswerProgress>();
  const drafts = attempts.filter(
    (attempt) => attempt.status === "draft" && attempt.abandonedAt === null,
  );
  for (let offset = 0; offset < drafts.length; offset += 500) {
    const batch = drafts.slice(offset, offset + 500);
    const rows = db
      .select({
        attemptId: responses.attemptId,
        questionId: responses.questionId,
        answerJson: responses.answerJson,
        submittedAt: responses.submittedAt,
        hasSnapshot: sql<number>`case when ${responses.questionSnapshotJson} is not null then 1 else 0 end`,
        formalInkId: ink.id,
      })
      .from(responses)
      .leftJoin(
        ink,
        and(
          eq(ink.attemptId, responses.attemptId),
          eq(ink.questionId, responses.questionId),
          gt(ink.strokeCount, 0),
        ),
      )
      .where(
        inArray(
          responses.attemptId,
          batch.map((attempt) => attempt.id),
        ),
      )
      .all();
    const byAttempt = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = byAttempt.get(row.attemptId) ?? [];
      group.push(row);
      byAttempt.set(row.attemptId, group);
    }
    for (const attempt of batch) {
      const answers = byAttempt.get(attempt.id) ?? [];
      // 未冻结的历史草稿沿用原有 live 取题规则；这里只读，不替学生冻结或改稿。
      const questionIds = new Set(
        attempt.frozenAt === null
          ? attemptQuestionRows(db, attempt).map((question) => question.id)
          : answers
              .filter((row) => row.hasSnapshot !== 0)
              .map((row) => row.questionId),
      );
      const answeredCount = answers.filter(
        (row) =>
          questionIds.has(row.questionId) &&
          (row.submittedAt !== null ||
            row.formalInkId !== null ||
            !isUnanswered(answerOf(row.answerJson))),
      ).length;
      result.set(attempt.id, { answeredCount, totalCount: questionIds.size });
    }
  }
  return result;
}
