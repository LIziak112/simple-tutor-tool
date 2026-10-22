import type {
  AttemptSource,
  PracticeQuestionProgress,
  PracticeRestrictionReason,
  PracticeWorkflow,
} from "@tutor/contract";

/**
 * 做题工作流纯裁决（M3-D1，计划 §6.1/§7.1/§9.1）：协议形态判别、受限文案与
 * 单题定位。授权结论只信服务端投影——practiceWorkflow 缺失即旧协议（lesson
 * 独立适配恒旧协议），客户端不得自行推断授权。
 */

/** 草稿视图的窄输入：AttemptDraftData 结构兼容（attempt.sourceType + 可选投影） */
export type PracticeDraftLike = {
  attempt: { sourceType: AttemptSource };
  practiceWorkflow?: PracticeWorkflow | undefined;
};

/**
 * 协议形态：v1 = 新协议普通卷（草稿视图携带 practiceWorkflow 且非 lesson）；
 * legacy = 历史卷或 lesson（恒既有列表呈现，行为零变化）。
 */
export function practiceProtocolOfDraft(
  data: PracticeDraftLike,
): "v1" | "legacy" {
  if (data.attempt.sourceType === "lesson") return "legacy";
  return data.practiceWorkflow !== undefined ? "v1" : "legacy";
}

/** 反馈节奏摘要文案（§7.1）：per_question=每题提交后查看；after_attempt=交卷后查看 */
export function practiceRhythmLabel(
  mode: PracticeWorkflow["feedbackMode"],
): string {
  return mode === "per_question" ? "每题提交后查看" : "交卷后查看";
}

/** 布局摘要文案：列表 / 单题 */
export function practiceLayoutLabel(layout: "list" | "single"): string {
  return layout === "single" ? "单题" : "列表";
}

/**
 * 受限文案（§7.1，紧邻被限制项展示）：canSubmitQuestion=false 时按
 * restrictionReason 给出原因；未受限或未知原因返回 null（不臆造文案）。
 */
export function practiceRestrictionCopy(
  workflow: PracticeWorkflow,
): string | null {
  if (workflow.canSubmitQuestion) return null;
  switch (workflow.restrictionReason) {
    case "teacher_after_attempt":
      return "老师要求交卷后公布";
    case "teacher_after_due":
      return "老师要求截止后公布";
    default:
      return null;
  }
}

/** 统一公布节奏下已提交行的反馈文案（§10.4 pending_attempt 投影同义） */
export const PENDING_ATTEMPT_FEEDBACK_COPY = "已提交，交卷后统一公布";

/**
 * 题级反馈受限文案（§10.4 restricted 三原因，M3-D2）：与 practiceRestrictionCopy
 * 同源口径，但覆盖三枚举全量（含 legacy_attempt——历史卷不可逐题反馈）；
 * QuestionFeedback 的 restricted 态与不可读行的本地呈现共用。
 */
export function practiceFeedbackRestrictedCopy(
  reason: PracticeRestrictionReason,
): string {
  switch (reason) {
    case "teacher_after_attempt":
      return "老师要求交卷后公布";
    case "teacher_after_due":
      return "老师要求截止后公布";
    case "legacy_attempt":
      return "本练习不支持逐题反馈";
  }
}

/**
 * 已提交但反馈不可读行的本地文案（不发题级反馈请求时的呈现依据）：
 * 教师受限按原因；否则按统一公布节奏（§10.4——不可读行零题目秘密，
 * 服务端裁决经专用端点，本文案只描述节奏事实）。
 */
export function practiceUnreadableFeedbackCopy(
  workflow: PracticeWorkflow,
): string {
  return !workflow.canSubmitQuestion && workflow.restrictionReason !== null
    ? practiceFeedbackRestrictedCopy(workflow.restrictionReason)
    : PENDING_ATTEMPT_FEEDBACK_COPY;
}

/**
 * 第一道未提交题（进入单题模式的默认定位，§11 纪律 7）：progress 缺行按未
 * 提交处理；全部已提交返回 null，由调用方兜底第一题。
 */
export function firstUnsubmittedQuestionId(
  questionIds: readonly string[],
  progress: readonly PracticeQuestionProgress[],
): string | null {
  const submitted = new Set(
    progress
      .filter((row) => row.submittedAt !== null)
      .map((row) => row.questionId),
  );
  return questionIds.find((id) => !submitted.has(id)) ?? null;
}

/** 已提交题计数（紧凑进度行用） */
export function countSubmittedQuestions(
  progress: readonly PracticeQuestionProgress[],
): number {
  return progress.filter((row) => row.submittedAt !== null).length;
}
