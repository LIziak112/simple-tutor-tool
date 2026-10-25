import type { AnswerKindBehavior } from "./types.ts";

/**
 * judge 纯行为（三口径逐字对齐现网实现，I15）：
 * - display「对/错」（answer-format judgeLabelOf）；
 * - teacher-queue/ai-context「正确/错误」（mark-response serializeStudentAnswer；
 *   ai-context 的 judge 经 serializeStudentAnswer 同口径）；
 * - 历史字符串写法（旧版 √/F 等）三口径一律原样保留（§7.1 不改写历史值，
 *   不调用 judgeOf 归一化）；judge 无结构需求，历史字符串合法、无形状问题可报。
 */
export const judgeBehavior: AnswerKindBehavior<
  { kind: "judge"; value: boolean | string },
  null
> = {
  isAnswered: () => true,
  formatStudent: (answer, profile) => {
    if (typeof answer.value === "boolean") {
      if (profile === "display") return answer.value ? "对" : "错";
      return answer.value ? "正确" : "错误";
    }
    // 历史字符串写法：三口径一律原样保留（I02/§7.1 不改写历史值）；
    // 空串按「未做」序列化为 null（#6980-3：v2 起 queue/ai 同口径——ai-context
    // 的 judge 经 serializeStudentAnswer 委托，空串不伪造文本）
    if (
      (profile === "teacher-queue" || profile === "ai-context") &&
      answer.value.trim() === ""
    ) {
      return null;
    }
    return answer.value;
  },
  inspectShape: () => [],
};
