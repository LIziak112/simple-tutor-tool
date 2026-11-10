import type { QueryClient } from "@tanstack/react-query";
import type {
  RubricDecision,
  RubricRating,
  RubricReview,
} from "@tutor/contract";
import { rubricRatingsEqual } from "@tutor/contract";
import { useEffect, useRef } from "react";
import { studentAttemptKey } from "./attempt-queries";

/**
 * 通用量表判卷（模块 3）结果页交互件的非渲染部分：按钮前提判断、单元格文案与
 * 在途判卷任务的刷新轮询。从 RubricReviewSection 抽出（文件规模软线）。
 */

export const DECISION_LABEL: Record<RubricDecision, string> = {
  self: "保留我的",
  agent: "采纳 Agent",
  custom: "自行改写",
};

export function levelCell(rating: RubricRating | undefined): string {
  return rating === undefined ? "—" : String(rating.level);
}

export function ratingOf(
  record: { ratings: readonly RubricRating[] } | null,
  id: string,
): RubricRating | undefined {
  return record?.ratings.find((rating) => rating.id === id);
}

/**
 * 「保留我的 / 采纳 Agent」是否已无事可做：裁定来源相同且档位与当前那份记录
 * 逐项一致。来源相同但档位已变（自评改过 / 新一份意见）仍可再裁（审查 #99-06）。
 */
export function decisionAlreadyApplied(
  review: RubricReview,
  decision: "self" | "agent",
): boolean {
  const source = review[decision];
  return (
    review.final !== null &&
    review.final.decision === decision &&
    source !== null &&
    rubricRatingsEqual(review.final.ratings, source.ratings)
  );
}

/**
 * 判卷任务在途时刷新本卷缓存的周期（审查 #99-05）：「回信后自动显示」靠它兑现
 * ——Agent 回信走 MCP / 页内 worker 写库，结果页没有推送通道。页面不可见时
 * 不轮询（切回后立即补刷一次）。
 */
export const RUBRIC_PENDING_POLL_MS = 15_000;

/**
 * 在途判卷任务存在期间按周期失效本卷缓存；回信落地（pending 归零）后停止。
 * - 只精确失效本卷详情键：前缀下还挂着随卷冻结的上下文查询
 *   （studentAttemptContextKey，staleTime ∞），不该跟着每 15 s 重取；
 * - 一次重取成功落地后回调 onRefetched：调用方据此清掉「刚发起」的本地在途
 *   标记——任务若没进服务端投影的在途桶（如立即被策略暂停 / 失败），投影不变
 *   也要让「判卷中」与轮询停下来。
 */
export function useRubricPendingPoll(
  client: QueryClient,
  attemptId: string,
  pendingTask: string | null,
  onRefetched?: () => void,
): void {
  const onRefetchedRef = useRef(onRefetched);
  onRefetchedRef.current = onRefetched;
  useEffect(() => {
    if (pendingTask === null) return;
    let disposed = false;
    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      const key = studentAttemptKey(attemptId);
      const before = client.getQueryState(key)?.dataUpdatedAt ?? 0;
      await client.invalidateQueries({ queryKey: key, exact: true });
      const after = client.getQueryState(key);
      if (
        !disposed &&
        after !== undefined &&
        after.status === "success" &&
        after.dataUpdatedAt > before
      ) {
        onRefetchedRef.current?.();
      }
    };
    const tick = () => void refresh();
    const timer = window.setInterval(tick, RUBRIC_PENDING_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [pendingTask, attemptId, client]);
}
