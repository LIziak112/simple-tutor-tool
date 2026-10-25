import type { AttemptResultCounts } from "@tutor/contract";

/** 缺少新计数的旧响应不从百分比分数猜测题数。 */
export function formatResultCounts(
  counts: AttemptResultCounts | null | undefined,
  includePending = true,
): string {
  if (!counts) return "—";
  const parts = [`做对 ${counts.correctCount} / ${counts.totalCount} 题`];
  if (includePending && counts.pendingCount > 0)
    parts.push(`待批 ${counts.pendingCount} 题`);
  if (includePending && counts.pendingSelfReviewCount > 0)
    parts.push(`待自评 ${counts.pendingSelfReviewCount} 题`);
  return parts.join(" · ");
}
