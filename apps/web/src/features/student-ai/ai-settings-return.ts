import type { PortalRoutes } from "@/features/runtime/portal-runtime";
import { aiDisplayReturnTo } from "./ai-display-return";

/**
 * 从 AI 设置返回时落到哪里。`attemptOpened` = 这份卷还没有实质动作（未激活）。
 */
export function aiSettingsReturnSource(
  routes: PortalRoutes,
  source: { pathname: string; search: string },
  attemptId: string,
  questionId: string | null,
  taskId: string | null,
  attemptOpened: boolean,
): string {
  const params = new URLSearchParams(source.search);
  for (const key of ["aiTask", "aiQuestion", "aiCompose"]) params.delete(key);
  if (questionId !== null) {
    if (taskId !== null) {
      params.set("aiTask", taskId);
      params.set("aiQuestion", questionId);
    } else params.set("aiCompose", questionId);
  }
  // 作业未激活时列表仍是未开始，回作业页会再出一次「开始作业」：改回已确认的这份
  // 卷，保留浏览现场，无需再次开卷或伪激活。已经动过笔的卷照旧回作业页。
  const pathname =
    attemptOpened &&
    routes.learningPattern("assignments/[^/]+$", "").test(source.pathname)
      ? routes.learning(`attempts/${attemptId}`)
      : source.pathname;
  return (
    aiDisplayReturnTo(
      routes,
      `${pathname}${params.size ? `?${params}` : ""}`,
    ) ?? routes.learning(`attempts/${attemptId}`)
  );
}
