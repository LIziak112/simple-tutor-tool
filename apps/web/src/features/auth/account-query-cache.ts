import type { QueryClient } from "@tanstack/react-query";
import { captureAccountIdentity } from "./account-identity";
import { AuthCancelledError } from "./auth-operation";

/** 取消旧请求并清理本角色的数据，保留身份查询对象以便活动守卫接收新状态。 */
export async function clearAccountQueries(
  queryClient: QueryClient,
  role: "student" | "teacher",
  ownsEntry: () => boolean = () => true,
) {
  const identity = captureAccountIdentity(queryClient, role);
  const isCurrent = () => ownsEntry() && identity.isCurrent();
  try {
    if (!isCurrent()) throw new AuthCancelledError();
    const belongsToAccount = (key: readonly unknown[]) =>
      key[0] === role || (role === "teacher" && key[0] === "admin");
    await queryClient.cancelQueries({
      predicate: (query) => belongsToAccount(query.queryKey),
    });
    // 取消等待期间入口可能已切换；旧A不得再删除新B的查询。
    if (!isCurrent()) throw new AuthCancelledError();
    const cache = queryClient.getQueryCache();
    const targets = cache.findAll({
      predicate: (query) =>
        belongsToAccount(query.queryKey) &&
        !(
          query.queryKey.length === 2 &&
          query.queryKey[0] === role &&
          query.queryKey[1] === "me"
        ),
    });
    for (const query of targets) {
      if (!isCurrent()) throw new AuthCancelledError();
      if (cache.get(query.queryHash) !== query) throw new AuthCancelledError();
      cache.remove(query);
      if (!isCurrent()) throw new AuthCancelledError();
    }
  } finally {
    identity.finish();
  }
}
