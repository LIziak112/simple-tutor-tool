import type { QuestionPublic } from "@tutor/contract";

/** 懒挂载占位高度估算：题头 + 题干行数 + 选项行数（不含答案区/反馈区）。 */
export function placeholderHeight(question: QuestionPublic): number {
  const stemLength = question.stemMd?.length ?? 0;
  const options = Array.isArray(question.options) ? question.options.length : 0;
  const stemRows = Math.ceil(stemLength / 32);
  return Math.min(1200, 132 + stemRows * 28 + options * 56);
}
