import type { AttemptResultQuestion } from "@tutor/contract";

export type ReviewScope = "all" | "wrong" | "unanswered" | "pending";
export const REVIEW_SCOPE_LABELS: Record<ReviewScope, string> = {
  all: "全部",
  wrong: "判错",
  unanswered: "未作答",
  pending: "待批",
};

/** 仅投影服务端判定；作答情况与判定相互独立，不在客户端判分。 */
export function reviewQuestionState(
  question: AttemptResultQuestion,
  released: boolean,
) {
  return {
    verdict: released ? question.finalCorrect : null,
    unanswered: question.answer === null,
  };
}

export function reviewScopes(released: boolean): ReviewScope[] {
  return released
    ? ["all", "wrong", "unanswered", "pending"]
    : ["all", "unanswered"];
}

export function reviewCounts(
  questions: readonly AttemptResultQuestion[],
  released: boolean,
) {
  const counts = { correct: 0, wrong: 0, pending: 0, unanswered: 0 };
  for (const question of questions) {
    const state = reviewQuestionState(question, released);
    if (state.unanswered) counts.unanswered++;
    if (!released) continue;
    if (state.verdict === true) counts.correct++;
    else if (state.verdict === false) counts.wrong++;
    else counts.pending++;
  }
  return counts;
}

export function inReviewScope(
  question: AttemptResultQuestion,
  scope: ReviewScope,
  released: boolean,
) {
  const state = reviewQuestionState(question, released);
  if (scope === "all") return true;
  if (scope === "unanswered") return state.unanswered;
  if (!released) return false;
  return scope === "wrong" ? state.verdict === false : state.verdict === null;
}
