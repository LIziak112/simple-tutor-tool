import type { QueryClient } from "@tanstack/react-query";
import { captureAccountIdentity } from "./account-identity";

/** 取消旧请求并清理本角色的数据，保留身份查询对象以便活动守卫接收新状态。 */
export async function clearAccountQueries(
  queryClient: QueryClient,
  role: "student" | "teacher",
  ownsEntry: () => boolean = () => true,
) {
  const identity = captureAccountIdentity(queryClient, role);
  const isCurrent = () => ownsEntry() && identity.isCurrent();
  try {
    if (!isCurrent()) return;
    const belongsToAccount = (key: readonly unknown[]) =>
      key[0] === role || (role === "teacher" && key[0] === "admin");
    await queryClient.cancelQueries({
      predicate: (query) => belongsToAccount(query.queryKey),
    });
    // 取消等待期间入口可能已切换；旧A不得再删除新B的查询。
    if (!isCurrent()) return;
    queryClient.removeQueries({
      predicate: (query) =>
        isCurrent() &&
        belongsToAccount(query.queryKey) &&
        !(
          query.queryKey.length === 2 &&
          query.queryKey[0] === role &&
          query.queryKey[1] === "me"
        ),
    });
  } finally {
    identity.finish();
  }
}
