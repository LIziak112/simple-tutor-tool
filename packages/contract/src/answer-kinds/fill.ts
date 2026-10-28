import type { AnswerKindBehavior, SlotsPublicStructure } from "./types.ts";

/**
 * fill 纯行为（三口径逐字对齐现网实现，I15）：
 * - isAnswered：至少一个非空答案（§7.1：完整度才是「填齐」口径，额外数组项
 *   不能填补空位也不算形状错误——I02 历史宽容，任何 values 数组都结构合法）；
 * - display：空值渲染「（空）」、「；」连接；历史多余项照常展示；
 * - teacher-queue/ai-context：values 原样「；」连接（空值不渲染占位；
 *   ai-context 的 fill 经 serializeStudentAnswer 同口径）。
 */
export const fillBehavior: AnswerKindBehavior<
  { kind: "fill"; values: string[] },
  SlotsPublicStructure
> = {
  isAnswered: (answer) => answer.values.some((value) => value.trim() !== ""),
  formatStudent: (answer, profile) => {
    if (profile === "display") {
      // 空值渲染「（空）」、「；」连接；历史多余项照常展示（§7.1）
      return answer.values
        .map((value) => (value.trim() === "" ? "（空）" : value))
        .join("；");
    }
    // teacher-queue/ai-context：全空按「未做」序列化为 null（#6980-3——v2 起
    // ai-context 的 fill 经 serializeStudentAnswer 委托，同口径不伪造分隔串）
    if (answer.values.every((value) => value.trim() === "")) {
      return null;
    }
    return answer.values.join("；");
  },
  // fill 的历史宽容（I02）：多余数组项合法（7.1「额外数组项不能填补空位」是
  // 完整度口径，不是形状错误），任何 values 数组都是结构合法的作答
  inspectShape: () => [],
};
