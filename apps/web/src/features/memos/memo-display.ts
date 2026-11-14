import type { Memo, MemoSourceTarget } from "@tutor/contract";
import type { PortalRoutes } from "@/features/runtime/portal-runtime";
export function memoAbsoluteTime(
  iso: string,
  locale = "zh-CN",
  timeZone = "UTC",
): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "时间不详";
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "longOffset",
    }).format(date);
  } catch {
    return memoAbsoluteTime(iso, "zh-CN", "UTC");
  }
}
export function memoSourceLabel(memo: Memo): string | null {
  const c = memo.context?.content;
  if (c == null) return memo.anchor.kind === "none" ? null : memo.anchor.label;
  const parts = [
    c.titles.course,
    c.titles.unit,
    c.titles.lecture,
    memo.context?.session
      ? `第${memo.context.session.questionNo}题`
      : c.questionId,
  ];
  return parts.filter(Boolean).join(" › ") || null;
}
export function memoSourceHref(
  routes: PortalRoutes,
  target: MemoSourceTarget,
): string | null {
  switch (target.kind) {
    case "attempt":
      return routes.learning(
        `attempts/${encodeURIComponent(target.attemptId)}?q=${encodeURIComponent(target.questionId)}`,
      );
    case "lecture":
      return routes.learning(
        `lectures/${encodeURIComponent(target.lectureId)}${target.sectionId === null ? "" : `#${encodeURIComponent(target.sectionId)}`}`,
      );
    case "unit":
      return routes.learning(
        `courses/${encodeURIComponent(target.courseId)}/units/${encodeURIComponent(target.unitId)}`,
      );
    case "course":
      return routes.learning(`courses/${encodeURIComponent(target.courseId)}`);
    default:
      return null;
  }
}
