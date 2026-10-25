import { dispatchIsAnswered, type StudentAnswer } from "@tutor/contract";

/**
 * 「未做」判定（#6980-3，2026-10；QM 二轮同步起委托契约登记表单一出处）：
 * 答案对象缺失，或有对象但无实际作答内容——多选空选、填空全空、手写题未填
 * 最终答案、判断旧版空串写法（登记表 isAnswered 口径，matching/ordering 空
 * 配对/空序列同判未做）。与判分口径正交：未做仍按 D1 判错进分母（判分不变），
 * 本函数只提供「是否有实际作答」的统一事实，供判分写点落 responses.answered
 * 与错题本入本谓词共用，防口径漂移。纯函数：无 IO、无异常出口。
 */
export function isUnanswered(
  answer: StudentAnswer | null | undefined,
): boolean {
  if (answer === null || answer === undefined) return true;
  return !dispatchIsAnswered(answer);
}
