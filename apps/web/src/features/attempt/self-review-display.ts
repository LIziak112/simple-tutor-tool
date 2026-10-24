import type { AttemptResultQuestion } from "@tutor/contract";

/**
 * 判定徽章显示参数（QM-11，TT-09b）：结果视图/题级反馈/讲练题卡三面共用的
 * 单一出处——reference_self 行（教师未判）按自评三态显示
 * 「已完成、待自评／自评正确／自评错误」，其余行（auto/manual_only/旧行/
 * 教师已判）沿既有 finalCorrect 路径不变（细项 3：完成状态三态明确，
 * 无答案状态不假装可自动判断——manual_only 行徽章仍为待批，另有
 * SelfReviewSection 的「暂无参考答案」提示行）。
 *
 * 只读服务端已公布投影（selfReview/gradingPolicy/teacherMark），客户端不
 * 推断未公布答案；聚合口径（reviewCounts/summary）不在本助手范围（QM-12）。
 */
export interface VerdictBadgeDisplay {
  readonly verdict: boolean | null;
  readonly pendingLabel?: string;
  readonly correctLabel?: string;
  readonly wrongLabel?: string;
}

export function verdictBadgeDisplayOf(
  question: Pick<
    AttemptResultQuestion,
    | "gradingPolicy"
    | "teacherMark"
    | "selfReview"
    | "finalCorrect"
    | "autoCorrect"
  >,
): VerdictBadgeDisplay {
  if (
    (question.gradingPolicy ?? null) === "reference_self" &&
    question.teacherMark === null
  ) {
    // reference_self 行 autoCorrect/finalCorrect 恒 null（TT-09a 判分口径，
    // 自评不写 finalCorrect），有效显示 = 自评记录；未评/已撤回
    // （record=null）→ 已完成、待自评
    const verdict = question.selfReview?.record?.verdict ?? null;
    if (verdict !== null) {
      return {
        verdict: verdict === "correct",
        correctLabel: "自评正确",
        wrongLabel: "自评错误",
      };
    }
    return { verdict: null, pendingLabel: "已完成、待自评" };
  }
  // 其余行（auto/manual_only/旧行/教师已判）沿既有 finalCorrect 路径零变化
  // （reviewQuestionState 同口径）：finalCorrect 优先、autoCorrect 兜底，
  // 两者均空才是待批（M6 授权题级反馈口径，与服务端 effectiveVerdictOf
  // 的自动回落一致；进行中单题反馈的行级 finalCorrect 尚未写入，丢兜底
  // 会让客观题误报待批、汇总与徽章漂移）
  return { verdict: question.finalCorrect ?? question.autoCorrect };
}
