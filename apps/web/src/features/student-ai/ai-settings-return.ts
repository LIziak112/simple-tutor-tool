import type { PortalRoutes } from "@/features/runtime/portal-runtime";
import { aiDisplayReturnTo } from "./ai-display-return";

export function aiSettingsReturnSource(
  routes: PortalRoutes,
  source: { pathname: string; search: string },
  attemptId: string,
  questionId: string | null,
  taskId: string | null,
): string {
  const params = new URLSearchParams(source.search);
  for (const key of ["aiTask", "aiQuestion", "aiCompose"]) params.delete(key);
  if (questionId !== null) {
    if (taskId !== null) {
      params.set("aiTask", taskId);
      params.set("aiQuestion", questionId);
    } else params.set("aiCompose", questionId);
  }
  // 作业未激活时列表仍是未开始；返回已确认卷可保留浏览现场，无需再次开卷或伪激活。
  const pathname = routes
    .learningPattern("assignments/[^/]+$", "")
    .test(source.pathname)
    ? routes.learning(`attempts/${attemptId}`)
    : source.pathname;
  return (
    aiDisplayReturnTo(
      routes,
      `${pathname}${params.size ? `?${params}` : ""}`,
    ) ?? routes.learning(`attempts/${attemptId}`)
  );
}
