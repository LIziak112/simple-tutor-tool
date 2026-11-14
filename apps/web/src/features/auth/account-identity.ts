import type { QueryClient } from "@tanstack/react-query";

/** 观察既有me查询的同步写代次；不保存另一份认证数据，ABA/同内容写也失效。 */
export function captureAccountIdentity(
  client: QueryClient,
  role: "student" | "teacher",
) {
  const cache = client.getQueryCache();
  const find = () => cache.find({ queryKey: [role, "me"], exact: true });
  const query = find();
  const data = query?.state.data;
  const count = query?.state.dataUpdateCount;
  let writes = 0;
  let removed = false;
  let resets = 0;
  const finish = cache.subscribe((event) => {
    if (
      event.query.queryKey.length !== 2 ||
      event.query.queryKey[0] !== role ||
      event.query.queryKey[1] !== "me"
    )
      return;
    if (event.type === "removed") removed = true;
    if (event.type === "updated" && event.action.type === "success") writes++;
    if (
      event.type === "updated" &&
      event.action.type === "setState" &&
      (query?.state.data !== data || query?.state.dataUpdateCount !== count)
    )
      resets++;
  });
  const isCurrent = () =>
    !removed &&
    writes === 0 &&
    resets === 0 &&
    find() === query &&
    query?.state.data === data &&
    query?.state.dataUpdateCount === count;
  return {
    isCurrent,
    /** 同步事务只允许本次一个me写入；嵌套监听触发外部写入也不能认领。 */
    commit(write: () => void) {
      if (!isCurrent()) return false;
      write();
      return !removed && writes === 1;
    },
    commitReset(write: () => void) {
      if (!isCurrent()) return false;
      write();
      return !removed && writes === 0 && resets <= 1;
    },
    finish,
  };
}
