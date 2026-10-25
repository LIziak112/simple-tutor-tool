import { lettersOf } from "../content.ts";
import type { AnswerKindBehavior, OptionsPublicStructure } from "./types.ts";

/**
 * choice/multi 共用的纯行为（三口径逐字对齐现网实现，I15）：
 * - display：choice=lettersOf（26→AA 电子表格进位）；multi=升序**不去重**、
 *   字母直接拼接「AC」（answer-format formatStudentAnswer）；
 * - teacher-queue：choice=optionLabel（≥26 用数字本身，**与 display 的 AA
 *   进位有意不同**）；multi=去重+升序、「、」连接（mark-response
 *   serializeStudentAnswer）；
 * - ai-context：字母后附选项正文（student-ai-context optionTextOf；选项缺失
 *   回落字母，等价旧实现 snapshot.options?.[index] 为 undefined 的分支）。
 */
export const choiceMultiBehavior: AnswerKindBehavior<
  { kind: "choice"; index: number } | { kind: "multi"; indexes: number[] },
  OptionsPublicStructure
> = {
  isAnswered: (answer) => answer.kind === "choice" || answer.indexes.length > 0,
  formatStudent: (answer, profile, structure) => {
    if (answer.kind === "choice") {
      if (profile === "display") return lettersOf(answer.index);
      if (profile === "teacher-queue") return queueOptionLabel(answer.index);
      return aiOptionTextOf(structure, answer.index);
    }
    const indexes = answer.indexes;
    if (profile === "display") {
      // display：升序不去重、字母拼接（AA 进位）
      return [...indexes]
        .sort((a, b) => a - b)
        .map((index) => lettersOf(index))
        .join("");
    }
    // teacher-queue/ai-context：去重+升序、「、」连接（§7.1 与 display 有意不同）；
    // 空选按「未做」序列化为 null（#6980-3：queue/ai 统一口径，不伪造空串）
    const unique = [...new Set(indexes)].sort((a, b) => a - b);
    if (unique.length === 0) return null;
    if (profile === "teacher-queue") {
      return unique.map((index) => queueOptionLabel(index)).join("、");
    }
    return unique.map((index) => aiOptionTextOf(structure, index)).join("、");
  },
  inspectShape: (answer, structure) => {
    const issues: { code: string; message: string }[] = [];
    const indexes = answer.kind === "choice" ? [answer.index] : answer.indexes;
    const outOfRange = indexes.filter(
      (index) => !structure.options.some((option) => option.index === index),
    );
    for (const index of outOfRange) {
      issues.push({
        code: "OPTION_INDEX_OUT_OF_RANGE",
        message: `选项下标 ${index} 超出题面选项范围（历史数据保留原值，不自动修复）`,
      });
    }
    return issues;
  },
};

/**
 * teacher-queue/ai-context 的选项字母（mark-response optionLabel 逐字复刻：
 * ≥26 用数字本身，与 display 的 lettersOf AA 进位有意不同）。
 */
export function queueOptionLabel(index: number): string {
  return index >= 0 && index < 26
    ? String.fromCharCode(65 + index)
    : String(index);
}

/** ai-context 的选项文本增强（student-ai-context optionTextOf 逐字复刻） */
function aiOptionTextOf(
  structure: OptionsPublicStructure,
  index: number,
): string {
  const option = structure.options.find((item) => item.index === index);
  return option === undefined
    ? queueOptionLabel(index)
    : `${queueOptionLabel(index)}（${option.text}）`;
}
