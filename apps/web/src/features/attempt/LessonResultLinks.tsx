import { ClipboardList, FileText } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { usePortalRoutes } from "@/features/runtime/portal-runtime";
import {
  attemptReviewEntryViewOf,
  attemptReviewHref,
  useAttemptReviewEntry,
} from "@/features/student-ai/attempt-review-entry";

/**
 * 讲练完成页顶栏的结果入口：「查看结果」+ 直达结果页整卷复盘的链接。
 *
 * 整卷复盘只在结果页发起和阅读（同一个地址参数、同一处权限校验），这里不
 * 另开一套面板，只把学生一步送到位：可发起时进发起面板，报告已出时直接
 * 打开报告，链接文字随任务状态变化。能否复盘以服务端为准——列表或
 * 预检没放行就只剩「查看结果」。
 */
export function LessonResultLinks({
  attemptId,
}: {
  readonly attemptId: string;
}) {
  const routes = usePortalRoutes();

  const state = useAttemptReviewEntry(attemptId, true);
  const view = attemptReviewEntryViewOf(state);
  const Icon = state.kind === "report" ? FileText : ClipboardList;
  return (
    <>
      <Button asChild variant="outline" className="min-h-11">
        <Link to={routes.learning(`attempts/${attemptId}`)}>查看结果</Link>
      </Button>
      {view !== null && (
        <Button asChild variant="outline" className="min-h-11 gap-1.5">
          <Link to={attemptReviewHref(routes, attemptId, view.target)}>
            <Icon aria-hidden className="size-4" />
            {view.label}
            {view.unread && <span className="sr-only">（未读）</span>}
          </Link>
        </Button>
      )}
    </>
  );
}
