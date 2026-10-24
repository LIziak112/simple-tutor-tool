import {
  hasReferenceAnswer,
  isSelfReviewQuestion,
  type Question,
  type SelfReviewState,
} from "@tutor/contract";
import type { ResponseRow } from "../db/schema.ts";

/** 教师判定优先，自评与自动结果保留各自事实。 */
export function effectiveCorrect(
  row: Pick<ResponseRow, "teacherMark" | "selfCorrect" | "autoCorrect">,
): boolean | null {
  if (row.teacherMark === "correct") return true;
  if (row.teacherMark === "wrong") return false;
  return row.selfCorrect ?? row.autoCorrect;
}

export function reviewSourceOf(
  row: Pick<ResponseRow, "teacherMark" | "selfCorrect" | "autoCorrect">,
): SelfReviewState["source"] {
  return row.teacherMark !== null
    ? "teacher"
    : row.selfCorrect !== null
      ? "self"
      : row.autoCorrect !== null
        ? "automatic"
        : null;
}

/** 仅授权反馈/结果使用，普通草稿投影不得携带判断来源。 */
export function selfReviewStateOf(
  row: ResponseRow,
  question: Question,
): SelfReviewState {
  const eligible =
    isSelfReviewQuestion(question) && hasReferenceAnswer(question);
  const teacher = row.teacherMark === "correct" || row.teacherMark === "wrong";
  return {
    mark: row.selfCorrect,
    revision: row.reviewRevision,
    reviewedAt: row.reviewedAt,
    source: reviewSourceOf(row),
    canReview: eligible && !teacher,
    awaitingSelfReview:
      eligible &&
      row.reviewEligible &&
      !teacher &&
      row.selfCorrect === null &&
      row.autoCorrect === null,
  };
}
