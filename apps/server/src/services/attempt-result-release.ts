import type { AttemptResultQuestion } from "@tutor/contract";

/**
 * 结果视图的「未公布」受限形态（T2A.8 after_due 截止前；buildResultData 的
 * releaseAwareQuestion 单一消费方）。入参已经过 studentFacingResultOf 学生端
 * 投影（题干防泄露），这里只负责把公布后才能看的字段置 null：
 * - 答案 / 解析 / 自动判分；
 * - D9 教师批注与最终判定——教师已批也不在截止前泄露对错与评语；
 * - QM-11 自评状态与行策略——未公布形态无自评入口；
 * - 模块 3 量表三份记录（自评 / Agent 意见 / 裁定）——意见不能先于答案公布
 *   进入结果页（审查 #99-01）；键缺省（题没有量表）时保持缺省，不凭空补 null。
 */
export function restrictedResultQuestionOf(
  projected: AttemptResultQuestion,
): AttemptResultQuestion {
  return {
    ...projected,
    answers: null,
    solutionMd: null,
    autoCorrect: null,
    teacherMark: null,
    teacherComment: null,
    finalCorrect: null,
    selfReview: null,
    gradingPolicy: null,
    ...("rubricReview" in projected ? { rubricReview: null } : {}),
  };
}
