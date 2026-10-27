import type { AttemptResultQuestion } from "@tutor/contract";
import { verdictBadgeDisplayOf } from "./self-review-display";

export type ReviewScope = "all" | "wrong" | "unanswered" | "pending";
export const REVIEW_SCOPE_LABELS: Record<ReviewScope, string> = {
  all: "全部",
  wrong: "判错",
  unanswered: "未作答",
  // QM-12：有效判定口径（教师判 > 自评 > 自动）下「待判断」同时涵盖待教师
  // 批改与待自评（逐题徽章区分两态），不再用「待批」一概而论
  pending: "待判断",
};

/**
 * 仅投影服务端判定（QM-12 起与逐题徽章同口径：verdictBadgeDisplayOf 单一
 * 出处——reference_self 行按自评三态计数，与徽章永不漂移）；作答情况与判定
 * 相互独立，不在客户端判分。
 */
export function reviewQuestionState(
  question: AttemptResultQuestion,
  released: boolean,
) {
  return {
    verdict: released ? verdictBadgeDisplayOf(question).verdict : null,
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
    // #6980-3：未做只与「答错」互斥（wrong 过 answered 门），待判断不过——
    // 未答待批行同时进未答与待判断（与服务端 scoreSummaryCoreOf 同形）
    if (state.unanswered) counts.unanswered++;
    if (!released) continue;
    if (state.verdict === true) counts.correct++;
    else if (state.verdict === false) {
      if (!state.unanswered) counts.wrong++;
    } else counts.pending++;
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
