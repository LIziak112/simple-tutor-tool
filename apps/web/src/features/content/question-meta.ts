import type { QuestionType } from "@tutor/contract";
import { QUESTION_TYPE_LABELS as QUESTION_TYPE_LABELS_CONTRACT } from "@tutor/contract";

/**
 * 题目元信息的展示映射（内容列表与导入统计条共用）：
 * 题型中文徽章文案、难度星条。纯数据/纯函数，不含 React。
 */

/** 题型 → 中文标签（T3.4 起常量收归契约，前后端同一份） */
export const QUESTION_TYPE_LABELS: Record<QuestionType, string> =
  QUESTION_TYPE_LABELS_CONTRACT;

/** 题型徽章的配色（区分客观题/主观题两档即可，避免七色花哨） */
export const QUESTION_TYPE_BADGE_CLASS: Record<QuestionType, string> = {
  judge: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  choice: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  multi: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  fill: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  solve: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  apply: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  "find-error": "bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

/**
 * 难度 → ★×n 文本（如难度 3 → "★★★"）。
 * 只渲染实心星保持紧凑；完整 1–5 语义交给 aria-label（"难度 3/5"）。
 */
export function difficultyStars(difficulty: number): string {
  const clamped = Math.max(1, Math.min(5, Math.floor(difficulty)));
  return "★".repeat(clamped);
}
