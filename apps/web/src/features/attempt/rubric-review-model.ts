import type { QueryClient } from "@tanstack/react-query";
import type {
  RubricDecision,
  RubricRating,
  RubricReview,
} from "@tutor/contract";
import { rubricRatingsEqual } from "@tutor/contract";
import { useEffect } from "react";

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

/** 在途判卷任务存在期间按周期失效本卷缓存；回信落地（pending 归零）后停止 */
export function useRubricPendingPoll(
  client: QueryClient,
  attemptId: string,
  pendingTask: string | null,
): void {
  useEffect(() => {
    if (pendingTask === null) return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void client.invalidateQueries({
        queryKey: ["student", "attempt", attemptId],
      });
    };
    const timer = window.setInterval(refresh, RUBRIC_PENDING_POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [pendingTask, attemptId, client]);
}
