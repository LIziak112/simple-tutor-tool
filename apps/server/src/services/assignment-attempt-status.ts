import type { AssignmentStatus } from "@tutor/contract";
import { isRecordableAttempt } from "@tutor/contract";
import type { Assignment } from "../db/schema.ts";

/** 单个学生在一道作业下的作答摘要（列表/详情四态统计由查询填充） */
export interface AssignmentAttemptSummary {
  /** attempts.status：draft=进行中、submitted=已交、graded=已批 */
  status: "draft" | "submitted" | "graded";
  /** attempts.id：详情名单行的 attemptId（D8 点击状态跳 attempt 详情的定位 id） */
  attemptId: string;
  /** attempts.startedAt：重做语义下的最新卷排序键（hall-15313，与开卷取最近同序） */
  startedAt: string;
  /** attempts.attemptNo：startedAt 并列时的次序兜底（重做卷 > 1） */
  attemptNo: number;
  activatedAt?: string | null;
  abandonedAt?: string | null;
}

/**
 * 计算学生在某作业下的完成状态（§5.8 完成矩阵）。
 * 纯函数：输入作业 + 该学生相关的作答记录，按优先级 graded > submitted > draft > 无记录。
 */
export function computeAssignmentStatus(
  _assignment: Pick<Assignment, "id" | "dueAt">,
  attemptsOfStudent: ReadonlyArray<
    Pick<
      AssignmentAttemptSummary,
      "status" | "startedAt" | "attemptNo" | "activatedAt" | "abandonedAt"
    >
  >,
): AssignmentStatus {
  // 最新卷推导（hall-15313 重做语义）：排序与开卷入口取最近同序
  //（startedAt desc, attemptNo desc）——重做进行中 → in_progress、重交待批 →
  // submitted；旧「graded > submitted > draft」优先级在重做后卡在已批，
  // 不再反映最新一卷
  const latest = latestAttemptOf(attemptsOfStudent.filter(isRecordableAttempt));
  if (latest === undefined) return "not_started";
  return latest.status === "draft" ? "in_progress" : latest.status;
}

/**
 * 最新卷（hall-15313）：startedAt desc、attemptNo desc，与开卷入口取最近同序。
 * 导出（hall-15658 F1/F2）：analytics 矩阵格子与开卷入口共用同一选卷单一出处，
 * 防止「状态按一套、点击/回看按另一套」的分叉再现。
 */
export function latestAttemptOf<
  T extends { startedAt: string; attemptNo: number },
>(attempts: readonly T[]): T | undefined {
  return [...attempts].sort(
    (a, b) =>
      b.startedAt.localeCompare(a.startedAt) || b.attemptNo - a.attemptNo,
  )[0];
}
