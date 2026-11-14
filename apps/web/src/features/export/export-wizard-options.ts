import type { LearningPackGoal } from "@tutor/contract";
export const GOAL_OPTIONS: ReadonlyArray<{
  value: LearningPackGoal;
  description: string;
}> = [
  {
    value: "diagnose-weakness",
    description:
      "按考点归纳错误模式，区分「不会」与「失误」，输出按薄弱程度排序的诊断报告与改进点",
  },
  {
    value: "lesson-prep",
    description:
      "针对错误最集中的知识点给出下节课讲解路线（分环节含时长）与课堂检查问题",
  },
  {
    value: "variant-practice",
    description:
      "基于错题生成变式练习，输出内容 DSL v2 文档，可直接回到「导入」流程使用",
  },
  {
    value: "period-summary",
    description:
      "面向家长的阶段性学习总结（教师审阅后转发），用数据说话并给家庭配合建议",
  },
  {
    value: "per-question-review",
    description:
      "逐题核对图片与步骤、指出最早可确定错误、区分事实与假设、给最小提示与验证题（v2：需勾选证据附件）",
  },
];
export const QUESTION_LEVEL_OPTIONS = [
  { value: "none", label: "不包含题目" },
  { value: "stem", label: "仅题干（题干中的答案标记会隐去）" },
  { value: "answer", label: "题干 + 参考答案" },
  { value: "solution", label: "题干 + 参考答案 + 解析" },
] as const;
