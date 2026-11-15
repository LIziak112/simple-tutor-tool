import { z } from "zod";
import type { PortalRoutes } from "@/features/runtime/portal-runtime";
import { assignmentsReturnTarget } from "@/features/student/assignment-list-filters";
import {
  aiQueueReturnTarget,
  recordsReturnTarget,
} from "@/features/student/record-review-navigation";

/** 只返回本站支持助教的学生学习页面，未知查询参数与外部地址不沿用。 */
export function aiDisplayReturnTo(
  routes: PortalRoutes,
  source: string | null,
): string | null {
  if (
    !source?.startsWith(routes.learning("/")) ||
    source.includes("\\") ||
    Array.from(source).some((character) => character.charCodeAt(0) < 32)
  )
    return null;
  const url = new URL(source, location.origin);
  if (
    url.origin !== location.origin ||
    !routes
      .learningPattern(
        "(?:assignments\\/[^/]+|attempts\\/[^/]+|lectures\\/[^/]+\\/lesson(?:\\/run)?)$",
        "",
      )
      .test(url.pathname)
  )
    return null;
  const allowed = new URLSearchParams();
  for (const key of ["aiTask", "aiQuestion", "aiCompose", "q", "question"]) {
    const value = url.searchParams.get(key);
    if (
      value &&
      value.length <= 256 &&
      !Array.from(value).some((character) => character.charCodeAt(0) < 32)
    )
      allowed.set(key, value);
  }
  const courseId = url.searchParams.get("courseId");
  if (
    courseId &&
    routes
      .learningPattern("lectures/[^/]+/lesson(?:/run)?$", "")
      .test(url.pathname) &&
    z.uuid().safeParse(courseId).success
  )
    allowed.set("courseId", courseId);
  const aiFrom = aiQueueReturnTarget(routes, url.searchParams.get("aiFrom"));
  if (aiFrom) allowed.set("aiFrom", aiFrom);
  // 作业列表来源复用已有筛选清洗，其他来源参数不接收任意嵌套路径。
  const returnTo = url.searchParams.get("returnTo");
  const listTarget =
    assignmentsReturnTarget(routes, returnTo) ??
    recordsReturnTarget(routes, returnTo);
  if (listTarget) allowed.set("returnTo", listTarget);
  return `${url.pathname}${allowed.size ? `?${allowed}` : ""}`;
}
