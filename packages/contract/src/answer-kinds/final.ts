import type { AnswerKindBehavior } from "./types.ts";

/**
 * final 纯行为（solve/apply/find-error 共用；三口径逐字对齐现网实现，I15）：
 * - isAnswered：最终答案非空文本；
 * - display：空文本→「（空）」，否则原文；
 * - teacher-queue：原文（空串就是空串——只写笔迹未填的待批行照实展示）；
 * - ai-context：空文本→「（答案在笔迹材料中）」标注（不伪造文本；材料是否
 *   实际附上由 SAI-10/11 装配，此处只是口径标注）。
 */
export const finalBehavior: AnswerKindBehavior<
  { kind: "final"; finalAnswer: string },
  null
> = {
  isAnswered: (answer) => answer.finalAnswer.trim() !== "",
  formatStudent: (answer, profile) => {
    if (profile === "display") {
      return answer.finalAnswer.trim() === "" ? "（空）" : answer.finalAnswer;
    }
    // teacher-queue：空文本按「未做」序列化为 null（#6980-3；只写笔迹未填的
    // 待批行靠笔迹材料展示，不伪造空答案文本）
    if (profile === "teacher-queue")
      return answer.finalAnswer.trim() === "" ? null : answer.finalAnswer;
    // ai-context：只写笔迹未填最终答案 → 标注在笔迹材料中（不伪造文本）
    return answer.finalAnswer.trim() === ""
      ? "（答案在笔迹材料中）"
      : answer.finalAnswer;
  },
  inspectShape: () => [],
};
