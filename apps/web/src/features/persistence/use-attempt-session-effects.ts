import {
  notifyManager,
  type QueryKey,
  useQueryClient,
} from "@tanstack/react-query";
import type { AttemptSummary } from "@tutor/contract";
import { useCallback, useSyncExternalStore } from "react";
import { useLocalAttemptActivation } from "./use-local-attempt-activation";
import { useOpenedAttemptListRefresh } from "./use-opened-attempt-refresh";

/**
 * 从查询缓存里读这份卷的摘要：自己订阅缓存，不经过 useQuery 的返回值。
 *
 * useQuery 按「渲染时读过哪些属性」决定哪些变化要通知调用方。取数 hook 自己读
 * 一次 data，调用方渲染时又没读过 isError，重取失败（比如权限被撤销）就不会
 * 通知它，页面停在可写的旧卷上。所以伴随详情跑的副作用从这里拿卷，取数 hook
 * 原样返回 useQuery 的结果。
 */
export function useCachedAttempt(
  queryKey: QueryKey,
): AttemptSummary | undefined {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (notify: () => void) =>
      // 和 useQuery 的通知排在同一批里，一次数据更新只渲染一次
      queryClient.getQueryCache().subscribe(notifyManager.batchCalls(notify)),
    [queryClient],
  );
  // 结构共享下，摘要没变就是同一个对象，别的查询的缓存事件不会引起重渲染
  const read = () =>
    queryClient.getQueryData<{ attempt?: AttemptSummary }>(queryKey)?.attempt;
  return useSyncExternalStore(subscribe, read, read);
}

/** 伴随作答详情 / 讲练开卷跑的两件事：本机材料笔迹补激活、动笔后让列表缓存过期。 */
export function useAttemptSessionEffects(queryKey: QueryKey): void {
  const attempt = useCachedAttempt(queryKey);
  useLocalAttemptActivation(attempt);
  useOpenedAttemptListRefresh(attempt);
}
