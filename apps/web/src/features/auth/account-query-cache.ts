import type { QueryClient } from "@tanstack/react-query";

/** 取消旧请求并清理本角色的数据，保留身份查询对象以便活动守卫接收新状态。 */
export async function clearAccountQueries(
  queryClient: QueryClient,
  role: "student" | "teacher",
) {
  const belongsToAccount = (key: readonly unknown[]) =>
    key[0] === role || (role === "teacher" && key[0] === "admin");
  await queryClient.cancelQueries({
    predicate: (query) => belongsToAccount(query.queryKey),
  });
  queryClient.removeQueries({
    predicate: (query) =>
      belongsToAccount(query.queryKey) &&
      !(
        query.queryKey.length === 2 &&
        query.queryKey[0] === role &&
        query.queryKey[1] === "me"
      ),
  });
}
