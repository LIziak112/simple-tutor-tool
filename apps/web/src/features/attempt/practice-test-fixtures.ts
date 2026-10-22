import type { PracticeWorkflow } from "@tutor/contract";

/**
 * 练习反馈升级（M3）测试共享夹具：四份单题工作区测试文件共用的
 * workflowOf 逐字收敛（note-fixtures.ts 先例）。submitReceipt 等场景
 * 夹具各文件语义不同，保持文件内。
 */

/** v1 工作流投影夹具：默认可逐题提交的 per_question 卷，可按需覆写 */
export const workflowOf = (
  overrides: Partial<PracticeWorkflow> = {},
): PracticeWorkflow => ({
  version: 1,
  feedbackMode: "per_question",
  revision: 0,
  canChangeFeedback: true,
  allowedFeedbackModes: ["per_question", "after_attempt"],
  canSubmitQuestion: true,
  restrictionReason: null,
  releaseAt: null,
  ...overrides,
});
