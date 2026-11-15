import { type AttemptResultQuestion, reviewVerdictOf } from "@tutor/contract";

/**
 * 判定徽章显示参数（QM-11，TT-09b）：结果视图/题级反馈/讲练题卡三面共用的
 * 单一出处——reference_self 行（教师未判）按自评三态显示
 * 「已完成、待自评／自评正确／自评错误」，其余行（auto/manual_only/旧行/
 * 教师已判）沿既有 finalCorrect 路径不变（细项 3：完成状态三态明确，
 * 无答案状态不假装可自动判断——manual_only 行徽章仍为待批，另有
 * SelfReviewSection 的待批提示）。
 *
 * 只读服务端已公布投影（selfReview/gradingPolicy/teacherMark），客户端不
 * 推断未公布答案；聚合口径（reviewCounts/summary）不在本助手范围（QM-12）。
 */
export interface VerdictBadgeDisplay {
  readonly verdict: boolean | null;
  readonly pendingLabel?: string;
  readonly correctLabel?: string;
  readonly wrongLabel?: string;
  /**
   * 判错但未做（#6980-3）：verdict=false 且 answered=false 且无人工显式判定
   * （teacherMark / 自评 record）——徽章灰显「未做」不套判错红；显式判定的
   * 未做行不被掩盖（错题本 P0-1 同口径）。仅 verdict=false 时有意义。
   */
  readonly notDone?: boolean;
}

export function verdictBadgeDisplayOf(
  question: Pick<
    AttemptResultQuestion,
    | "gradingPolicy"
    | "teacherMark"
    | "selfReview"
    | "finalCorrect"
    | "autoCorrect"
    | "answered"
  >,
): VerdictBadgeDisplay {
  const { source: _source, ...display } = reviewVerdictOf({
    ...question,
    selfReviewVerdict: question.selfReview?.record?.verdict ?? null,
  });
  return display;
}
