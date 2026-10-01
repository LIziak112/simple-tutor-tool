import { ClipboardCheck, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { useTeacherCourses } from "@/features/courses/course-queries";
import {
  AnalyticsFilterBar,
  type AnalyticsUrlState,
  analyticsApiParams,
  analyticsUrlQuery,
  InsightsViewSwitcher,
  parseAnalyticsUrl,
} from "@/features/insights/analytics-filters";
import { useAnalyticsOverview } from "@/features/insights/analytics-queries";
import { FocusCard } from "@/features/insights/FocusCard";
import { InsightsMatrix } from "@/features/insights/InsightsMatrix";
import { formatPercent } from "@/features/insights/insights-format";
import { formatDueTime } from "@/lib/time";

/**
 * /t/insights 学情总览（T4.2）：
 * - 顶部：时间范围快捷项（7/30/90 天/全部，默认 30）+ 课程筛选（含「全部」，
 *   D3）+ 下节课重点周期 focusDays（默认 14，与时间范围独立，D5）——全部同步
 *   在 URL query，刷新/切换视图不丢；
 * - 关键计数区：待批数（链接 T3.1 待批队列 /t/data/pending，携带课程筛选）、
 *   重做计数、离线作答占比（离线/有效分钟）、总正确率（D4：判对 ÷ 已判定）；
 * - 「下节课重点」卡片：周期内错误最多 3 考点 + 代表错题（跳作答详情）；
 * - 完成矩阵（D2）：学生 × 作业 + 可见课程单元，五状态分色，学生名进画像。
 * 纯消费 T4.1 overview 接口，前端不重算任何口径（契约 analytics-api.ts）。
 */

/** 加载骨架（不白屏） */
function OverviewSkeleton() {
  return (
    <div
      role="status"
      aria-label="正在加载学情总览"
      className="flex flex-col gap-3"
    >
      <div className="h-24 animate-pulse rounded-xl border border-border bg-muted/50" />
      <div className="h-32 animate-pulse rounded-xl border border-border bg-muted/50" />
      <div className="h-48 animate-pulse rounded-xl border border-border bg-muted/50" />
      <p className="text-sm text-muted-foreground">正在加载学情总览…</p>
    </div>
  );
}

/** 错误态（原因 + 重试） */
function OverviewError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
    >
      <p className="flex items-center gap-2 text-sm font-medium text-destructive">
        <TriangleAlert aria-hidden className="size-4 shrink-0" />
        学情总览加载失败
      </p>
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" className="min-h-11" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

export function InsightsOverviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // URL query 是筛选的单一事实来源（与 /t/data 同模式）
  const state = useMemo(() => parseAnalyticsUrl(searchParams), [searchParams]);

  // 课程筛选项取未归档课程（归档课程学生侧已不可见）
  const coursesQuery = useTeacherCourses(false);
  const overviewQuery = useAnalyticsOverview(analyticsApiParams(state, true));

  /** 筛选变化：合并补丁写回 URL（默认值不写，保持地址干净） */
  function applyPatch(patch: Partial<AnalyticsUrlState>): void {
    void setSearchParams(analyticsUrlQuery({ ...state, ...patch }));
  }

  function resetFilters(): void {
    void setSearchParams(new URLSearchParams());
  }

  const query = analyticsUrlQuery(state).toString();
  const data = overviewQuery.data;

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">学情总览</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            一页看全完成情况与薄弱点：矩阵看谁没做，重点卡片备下节课，
            计数区待批与离线一目了然。
          </p>
        </div>
        <InsightsViewSwitcher view="overview" query={query} />
      </header>

      <AnalyticsFilterBar
        state={state}
        courses={coursesQuery.data?.courses ?? []}
        showFocusDays
        onPatch={applyPatch}
        onReset={resetFilters}
      />

      {data && (
        <p className="text-xs text-muted-foreground">
          统计窗口：
          {data.range.from === null
            ? "全部时间"
            : `${formatDueTime(data.range.from)} 起`}{" "}
          至今（按提交时间）；完成矩阵为当下状态，不受时间范围影响。
        </p>
      )}

      {overviewQuery.isPending && <OverviewSkeleton />}

      {overviewQuery.isError && (
        <OverviewError
          message={
            overviewQuery.error instanceof Error
              ? overviewQuery.error.message
              : "网络异常，请稍后重试"
          }
          onRetry={() => void overviewQuery.refetch()}
        />
      )}

      {data !== undefined &&
        (data.studentCount === 0 &&
        data.matrix.assignmentColumns.length === 0 &&
        data.matrix.unitColumns.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
            <p className="text-sm font-medium">还没有可统计的学情数据</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              布置作业或开放课程练习后，这里会出现完成矩阵、下节课重点与关键
              计数。
            </p>
          </div>
        ) : (
          <>
            {/* 关键计数区：待批（去待批队列）/ 重做 / 离线 / 总正确率 */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Link
                to={{
                  pathname: "/t/data/pending",
                  search:
                    state.courseId !== null
                      ? `?courseId=${encodeURIComponent(state.courseId)}`
                      : "",
                }}
                className="flex min-h-24 flex-col justify-center gap-1 rounded-xl border border-border bg-card p-4 outline-none transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ClipboardCheck aria-hidden className="size-3.5" />
                  待批题
                </p>
                <p className="text-2xl font-semibold">
                  {data.pendingMarkCount}
                </p>
                <p className="text-xs text-primary">去待批队列 →</p>
              </Link>
              <div className="flex min-h-24 flex-col justify-center gap-1 rounded-xl border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground">课程练习重做</p>
                <p className="text-2xl font-semibold">{data.redoCount} 次</p>
                <p className="text-xs text-muted-foreground">统计窗口内</p>
              </div>
              <div className="flex min-h-24 flex-col justify-center gap-1 rounded-xl border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground">离线作答占比</p>
                <p className="text-2xl font-semibold">
                  {formatPercent(data.offline.offlineShare)}
                </p>
                <p className="text-xs text-muted-foreground">
                  离线 {Math.round(data.offline.offlineSecTotal / 60)} 分钟 /
                  有效 {Math.round(data.offline.activeSecTotal / 60)} 分钟
                </p>
              </div>
              <div className="flex min-h-24 flex-col justify-center gap-1 rounded-xl border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground">总正确率</p>
                <p className="text-2xl font-semibold">
                  {formatPercent(data.overall.correctRate)}
                </p>
                <p className="text-xs text-muted-foreground">
                  对 {data.overall.correctCount} / 已判定{" "}
                  {data.overall.judgedCount} 题
                </p>
              </div>
            </div>

            <FocusCard focus={data.focus} />

            <section aria-label="完成矩阵" className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold">完成矩阵</h2>
              <InsightsMatrix matrix={data.matrix} studentQuery={query} />
            </section>
          </>
        ))}
    </section>
  );
}

// 供 App.tsx 路由级懒加载
export default InsightsOverviewPage;
