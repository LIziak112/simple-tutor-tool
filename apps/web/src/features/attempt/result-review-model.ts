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
    // #6980-3（审查修复 P1-4）：未做口径统一服务端落库的 answered，与题卡
    // 灰显、错题本入本同一事实——不再按 answer === null 现算（空结构答案
    // 曾出现「题卡未做、汇总已答」的同页分裂）
    unanswered: !question.answered,
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
    if (state.unanswered) {
      counts.unanswered++;
      continue; // 未做只进「未作答」，不进判错/待批（#6980-3 口径统一）
    }
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
