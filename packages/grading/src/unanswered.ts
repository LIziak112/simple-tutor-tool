import type { StudentAnswer } from "@tutor/contract";

/**
 * 「未做」判定（#6980-3，2026-10）：答案对象缺失，或有对象但无实际作答内容
 * ——多选空选（indexes=[]）、填空全空（values 全为空白）、手写题未填最终答案
 * （finalAnswer 空白）；判断/单选存在答案对象即已作答（旧版空串判断写法算
 * 未做）。与判分口径正交：未做仍按 D1 判错进分母（判分不变），本函数只提供
 * 「是否有实际作答」的统一事实，供判分写点落 responses.answered 与错题本
 * 入本谓词共用，防口径漂移。纯函数：无 IO、无异常出口。
 */
export function isUnanswered(
  answer: StudentAnswer | null | undefined,
): boolean {
  if (answer === null || answer === undefined) return true;
  switch (answer.kind) {
    case "judge":
      return typeof answer.value === "string" && answer.value.trim() === "";
    case "choice":
      return false;
    case "multi":
      return answer.indexes.length === 0;
    case "fill":
      return answer.values.every((value) => value.trim() === "");
    case "final":
      return answer.finalAnswer.trim() === "";
  }
}
