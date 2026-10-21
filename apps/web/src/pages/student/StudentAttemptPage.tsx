import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { AttemptSession } from "@/features/attempt/AttemptSession";
import { useAttemptDetail } from "@/features/attempt/attempt-queries";
import { lessonHref } from "@/features/student/lesson-navigation";
import {
  aiQueueReturnTarget,
  recordsReturnTarget,
} from "@/features/student/record-review-navigation";
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
  const [searchParams] = useSearchParams();
  const recordsTarget = recordsReturnTarget(searchParams.get("returnTo"));
  // SAI-23 队列跳转来源（aiFrom 白名单独立于回看 returnTo）：优先级在其后——
  // 队列入口只在无回看上下文时改写返回目标
  const queueTarget = aiQueueReturnTarget(searchParams.get("aiFrom"));
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
  // 退出目标：课程练习回单元落地页（继续「再做一次/历次记录」动线）；错题重练
  // 回错题本（2026-10，交卷后能直接看到轮次史新增一轮与攻克状态）；讲练回讲练
  // 页（2026-10 讲练一体——恒可回看/再做一次，courseId 上下文随行）；作业回首页。
  // T2A.7：attempt.unitId 可空（assignment 来源多单元化为 null）——course 来源
  // 恒有值，仅在两者齐备时才构造单元落地页地址，否则回首页兜底。
  const exitTarget =
    data.attempt.sourceType === "wrong"
      ? "/s/wrong"
      : data.attempt.sourceType === "lesson" && data.attempt.lectureId !== null
        ? lessonHref(data.attempt.lectureId, data.attempt.courseId)
        : data.attempt.sourceType === "course" &&
            data.attempt.courseId !== null &&
            data.attempt.unitId !== null
          ? `/s/courses/${data.attempt.courseId}/units/${encodeURIComponent(data.attempt.unitId)}`
          : "/s/home";
  return (
    <AttemptSession
      data={data}
      exitLabel={
        recordsTarget ? "返回我的记录" : queueTarget ? "返回原页面" : undefined
      }
      onExit={() => void navigate(recordsTarget ?? queueTarget ?? exitTarget)}
      onRefresh={() => void detailQuery.refetch()}
    />
  );
}
