import type { AssignmentStatus } from "@tutor/contract";

/** 学习完成态共用颜色语义；判分对错及待自评提示不使用本映射。 */
export const learningStatusClass: Record<AssignmentStatus, string> = {
  not_started: "bg-muted text-muted-foreground",
  in_progress: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300",
  submitted:
    "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  graded:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
};

export const learningStatusAccent: Record<AssignmentStatus, string> = {
  not_started: "before:bg-primary",
  in_progress: "before:bg-sky-500",
  submitted: "before:bg-amber-400",
  graded: "before:bg-emerald-400",
};
