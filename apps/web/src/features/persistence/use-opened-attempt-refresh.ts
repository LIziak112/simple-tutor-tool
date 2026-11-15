import { useQueryClient } from "@tanstack/react-query";
import type { AttemptSummary } from "@tutor/contract";
import { useEffect } from "react";

/**
 * 没动过的卷不入账：我的记录、单元 / 讲练落地页、作业列表里都没有它。学生动笔
 * 时服务端随那次写入把卷激活，这些列表跟着变，但没有哪个前端操作会通知它们
 * ——它们各有十几秒的缓存，学生答了题马上回落地页，看到的还是「再做一次」
 * 而不是「继续作答」。
 *
 * 所以：页面拿到的卷是未激活的，那么看到它已激活、或者离开这份卷的时候，把
 * 学生端的列表类查询标记为过期（在屏的立即重取，其余回到页面时重取）。卷自己
 * 的详情、上下文和讲练开卷投影不动。
 */
export function useOpenedAttemptListRefresh(
  attempt: AttemptSummary | undefined,
): void {
  const queryClient = useQueryClient();
  const attemptId = attempt?.id;
  const opened = attempt?.phase === "opened";
  useEffect(() => {
    if (attemptId === undefined || !opened) return;
    return () => {
      void queryClient.invalidateQueries({
        predicate: ({ queryKey }) =>
          queryKey[0] === "student" &&
          queryKey[1] !== "attempt" &&
          queryKey[1] !== "lesson",
      });
    };
  }, [attemptId, opened, queryClient]);
}
