import type { PortalRoutes } from "@/features/runtime/portal-runtime";
import {
  parseStudentRecordsUrl,
  studentRecordsUrlQuery,
} from "./records-filters";

/** 返回上下文只允许记录页，不接受协议、外链、任意路由或未知字段。 */
export function recordsReturnTarget(
  routes: PortalRoutes,
  raw: string | null,
): string | null {
  if (!raw?.startsWith(routes.learning("records")) || raw.startsWith("//"))
    return null;
  try {
    const url = new URL(raw, "https://student.invalid");
    if (
      url.origin !== "https://student.invalid" ||
      url.pathname !== routes.learning("records")
    )
      return null;
    const state = parseStudentRecordsUrl(url.searchParams);
    const query = studentRecordsUrlQuery(state).toString();
    return routes.learning(`records${query ? `?${query}` : ""}`);
  } catch {
    return null;
  }
}

export function recordReviewHref(
  routes: PortalRoutes,
  attemptId: string,
  search: URLSearchParams,
): string {
  const origin =
    recordsReturnTarget(routes, routes.learning(`records?${search}`)) ??
    routes.learning("records");
  return routes.learning(
    `attempts/${encodeURIComponent(attemptId)}?${new URLSearchParams({ returnTo: origin })}`,
  );
}

/**
 * SAI-23 助教队列的返回来源白名单：接受任意 /s/ 同源路径（含筛选 query，
 * 跨作答跳转再返回保留来源位置），拒绝 //、协议外链与非学生端路径。
 * 与 recordsReturnTarget 分开：回看链路的白名单语义（只认 /s/records）不变。
 */
export function aiQueueReturnTarget(
  routes: PortalRoutes,
  raw: string | null,
): string | null {
  if (
    raw === null ||
    !raw.startsWith(routes.learning("/")) ||
    raw.startsWith("//")
  ) {
    return null;
  }
  try {
    const url = new URL(raw, "https://student.invalid");
    if (url.origin !== "https://student.invalid") return null;
    return url.pathname + url.search;
  } catch {
    return null;
  }
}
