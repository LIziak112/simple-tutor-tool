import { School } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { AttemptSession } from "@/features/attempt/AttemptSession";
import { useAttemptDetail } from "@/features/attempt/attempt-queries";
import {
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";
import { ApiError } from "@/lib/api";

/**
 * /s/attempts/:attemptId 通用答题页（T2A.6，D9 两种来源共用）：
 * 按 attemptId 直接加载详情（draft→答题视图，已交→只读结果视图——历次记录
 * 的回看入口）。与作业入口页（/s/assignments/:id）渲染同一 AttemptSession。
 * 403/404（如课程练习被移出成员，D7/D22）→ 终态错误面板「已无权限访问该练习」，
 * 不做无限重试；交卷后的返回目标按来源分派（课程练习回单元落地页）。
 */
export default function StudentAttemptPage() {
  const { attemptId = "" } = useParams();
  const navigate = useNavigate();
  const detailQuery = useAttemptDetail(attemptId || undefined);

  if (detailQuery.isPending) {
    return <StudentListSkeleton label="正在打开练习" />;
  }
  if (detailQuery.isError || detailQuery.data === undefined) {
    const denied =
      detailQuery.error instanceof ApiError &&
      (detailQuery.error.status === 403 || detailQuery.error.status === 404);
    if (denied) {
      return (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
        >
          <p className="text-sm font-medium">已无权限访问该练习</p>
          <p className="text-sm text-muted-foreground">
            这份练习可能已被老师收回，或你已不在对应课程中。有疑问请联系老师。
          </p>
          <Link
            to="/s/home"
            className="flex min-h-11 items-center rounded-lg border border-border px-4 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            返回首页
          </Link>
        </div>
      );
    }
    return (
      <StudentErrorPanel
        title="练习加载失败"
        message={
          detailQuery.error instanceof Error
            ? detailQuery.error.message
            : "网络异常，请稍后重试"
        }
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }

  const data = detailQuery.data;
  // 退出目标：课程练习回单元落地页（继续「再做一次/历次记录」动线）；作业回首页
  const exitTarget =
    data.attempt.sourceType === "course" && data.attempt.courseId !== null
      ? `/s/courses/${data.attempt.courseId}/units/${encodeURIComponent(data.attempt.unitId)}`
      : "/s/home";
  return (
    <div className="flex flex-col gap-3">
      {data.attempt.sourceType === "course" && (
        <nav aria-label="返回" className="flex items-center gap-2">
          <Link
            to={exitTarget}
            aria-label="返回单元练习"
            className="flex min-h-11 items-center gap-1 rounded-lg text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <School aria-hidden className="size-4" />
            返回单元练习
          </Link>
        </nav>
      )}
      <AttemptSession data={data} onExit={() => void navigate(exitTarget)} />
    </div>
  );
}
