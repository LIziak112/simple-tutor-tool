import type {
  AnalyticsCellStatus,
  AnalyticsFoldStatus,
  AnalyticsSectionStatus,
  AnalyticsStepsStatus,
} from "@tutor/contract";

/**
 * 学情页共用的中文标签与数值格式化（T4.2）：
 * - 契约枚举（英文）→ 界面文案（中文）集中在此，页面与测试共用同一词表；
 * - 口径词与契约注释保持一致（如 not-assigned=未指派——「未指派不是没完成」）。
 */

/** 完成矩阵单元格状态（D2；词表同契约 analyticsCellStatusSchema 注释） */
export const CELL_STATUS_LABELS: Record<AnalyticsCellStatus, string> = {
  "not-assigned": "未指派",
  "not-started": "未开始",
  "in-progress": "进行中",
  submitted: "已交",
  graded: "已批",
};

/** 讲义阅读地图：节状态（时间代理的行为推断，非注意力测量） */
export const SECTION_STATUS_LABELS: Record<AnalyticsSectionStatus, string> = {
  "not-reached": "未到达",
  skimmed: "掠过",
  partial: "部分阅读",
  read: "已读",
  deep: "细读",
};

/** 讲义阅读地图：折叠指令状态 */
export const FOLD_STATUS_LABELS: Record<AnalyticsFoldStatus, string> = {
  "not-opened": "未打开",
  "opened-unread": "打开未读",
  read: "已读",
};

/** 讲义阅读地图：steps 容器状态 */
export const STEPS_STATUS_LABELS: Record<AnalyticsStepsStatus, string> = {
  "not-started": "未开始",
  "rush-skipped": "连点跳过",
  "step-by-step": "逐步阅读",
  incomplete: "未走完",
};

/** 折叠指令名的中文（hostHeadingIndex 行内展示；未知名原样显示） */
export const FOLD_NAME_LABELS: Record<string, string> = {
  hint: "提示",
  solution: "解析",
  fold: "折叠块",
  example: "例题",
};

/** 正确率（0–1）→ 展示文本（"83%"；四舍五入；null → "—"） */
export function formatPercent(rate: number | null): string {
  if (rate === null) return "—";
  return `${Math.round(rate * 100)}%`;
}
