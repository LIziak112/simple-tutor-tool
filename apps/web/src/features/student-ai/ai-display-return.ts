import { assignmentsReturnTarget } from "@/features/student/assignment-list-filters";

/** 只返回本站支持助教的学生学习页面，未知查询参数与外部地址不沿用。 */
export function aiDisplayReturnTo(source: string | null): string | null {
  if (
    !source?.startsWith("/s/") ||
    source.includes("\\") ||
    Array.from(source).some((character) => character.charCodeAt(0) < 32)
  )
    return null;
  const url = new URL(source, location.origin);
  if (
    url.origin !== location.origin ||
    !/^\/s\/(?:assignments\/[^/]+|attempts\/[^/]+|lectures\/[^/]+\/lesson(?:\/run)?)$/.test(
      url.pathname,
    )
  )
    return null;
  const allowed = new URLSearchParams();
  for (const key of ["aiTask", "aiQuestion", "aiCompose"]) {
    const value = url.searchParams.get(key);
    if (
      value &&
      value.length <= 256 &&
      !Array.from(value).some((character) => character.charCodeAt(0) < 32)
    )
      allowed.set(key, value);
  }
  // 作业列表来源复用已有筛选清洗，其他来源参数不接收任意嵌套路径。
  const returnTo = url.searchParams.get("returnTo");
  const listTarget = assignmentsReturnTarget(returnTo);
  if (listTarget) allowed.set("returnTo", listTarget);
  return `${url.pathname}${allowed.size ? `?${allowed}` : ""}`;
}
