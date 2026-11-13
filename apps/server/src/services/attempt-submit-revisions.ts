import type { AttemptSubmitRevision } from "@tutor/contract";
import {
  attemptSubmissionConflictSchema,
  frozenQuestionRevisionIdSchema,
} from "@tutor/contract";
import type { ResponseRow } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { answerOf } from "./snapshot.ts";

type SubmissionRow = Pick<
  ResponseRow,
  "id" | "questionId" | "answerRevision" | "answerJson"
>;

export function revisionStale(): HttpError {
  return new HttpError(
    409,
    "QUESTION_REVISION_STALE",
    "题目版本已变化，请刷新页面后重新交卷",
  );
}

export function assertSubmissionAnswerRevision(
  row: Pick<SubmissionRow, "questionId" | "answerRevision" | "answerJson">,
  expected: number | undefined,
): void {
  // 旧页面只可提交从未保存过答案的空题，其他题需要刷新取得可见版本。
  if (
    expected === row.answerRevision ||
    (expected === undefined &&
      row.answerRevision === 0 &&
      row.answerJson === null)
  )
    return;
  throw new HttpError(
    409,
    "ANSWER_REVISION_CONFLICT",
    expected === undefined
      ? "当前页面缺少答案版本，请刷新后核对已保存的答案再提交"
      : "本题答案已更新，请核对当前草稿再提交",
    attemptSubmissionConflictSchema.parse({
      _questionId: row.questionId,
      _current: {
        revision: row.answerRevision,
        draft: answerOf(row.answerJson),
      },
    }),
  );
}

/** 版本与原稿声明共用题目集合比对，拒绝缺项、多项与重复项。 */
export function assertExactQuestionSet<T extends { questionId: string }>(
  graded: readonly { response: { questionId: string } }[],
  items: readonly T[],
  reject: () => HttpError,
): void {
  if (items.length !== graded.length) throw reject();
  const remaining = new Set(graded.map((item) => item.response.questionId));
  for (const item of items) {
    if (!remaining.delete(item.questionId)) throw reject();
  }
}

export function validateSubmitRevisions(
  frozen: readonly { response: SubmissionRow }[],
  pending: readonly { response: SubmissionRow }[],
  revisions: readonly AttemptSubmitRevision[],
): void {
  assertExactQuestionSet(frozen, revisions, revisionStale);
  const clientByQuestion = new Map(
    revisions.map((entry) => [entry.questionId, entry]),
  );
  for (const { response } of frozen) {
    const revision = frozenQuestionRevisionIdSchema.safeParse(
      clientByQuestion.get(response.questionId)?.questionRevisionId,
    );
    if (!revision.success || revision.data !== response.id)
      throw revisionStale();
  }
  for (const { response } of pending) {
    assertSubmissionAnswerRevision(
      response,
      clientByQuestion.get(response.questionId)?.expectedAnswerRevision,
    );
  }
}
