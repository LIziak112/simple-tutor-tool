import type { AnalyticsAnomalyQuestion } from "@tutor/contract";
import {
  ArrowLeft,
  Clock3,
  Lightbulb,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { lazy, Suspense, useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { QUESTION_TYPE_LABELS } from "@/features/attempt/answer-format";
import { useTeacherCourses } from "@/features/courses/course-queries";
import {
  AnalyticsFilterBar,
  type AnalyticsUrlState,
  analyticsApiParams,
  analyticsUrlQuery,
  parseAnalyticsUrl,
} from "@/features/insights/analytics-filters";
import { useAnalyticsStudent } from "@/features/insights/analytics-queries";
import {
  formatPercent,
  formatScore,
} from "@/features/insights/insights-format";
import { LectureReadingMapView } from "@/features/insights/LectureReadingMapView";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { formatActiveSec } from "@/features/teacher-attempts/AttemptDetailQuestionCard";
import { ApiError } from "@/lib/api";
import { formatDueTime, formatRelativeTime } from "@/lib/time";

/**
 * /t/insights/students/:id 学生画像（T4.2）：
 * - 正确率周趋势折线（ECharts 按需 chunk，D5 自然周）；
 * - 考点正确率横向条形图（D25：升序 top N、薄弱在上）+ 全量考点表（薄弱在前）；
 * - 错题列表（T4.2 契约补齐：qualifying 中 finalCorrect=false 的逐题行，待批
 *   不在列；整行点击跳 T3.1 作答详情 /t/data/attempts/:attemptId）；
 * - 用时异常题卡片（D6：slow/hints 两类，跳作答详情）；
 * - 重做概览（独立指标 D1，不受时间范围限制）、离线作答占比；
 * - 讲义阅读地图（T4.0 §4.4.4：目录树逐项状态 + 行为推断标注 + 含挂机时长）；
 * - AI 报告列表区占位（T4.6 后接入，不做假数据）；
 * - 学生不存在 / 非本教师 → 接口 404 STUDENT_NOT_FOUND，页面呈现错误态。
 * 筛选（时间范围/课程）同步 URL，从总览矩阵点入时携带上下文。
 */

// 图表按需 chunk：echarts 注册与渲染全部在独立异步模块内（禁全量 import "echarts"）
const TrendLineChart = lazy(() =>
  import("@/features/insights/charts").then((m) => ({
    default: m.TrendLineChart,
  })),
);
const KnowledgeBarChart = lazy(() =>
  import("@/features/insights/charts").then((m) => ({
    default: m.KnowledgeBarChart,
  })),
);

/** 图表懒加载兜底（骨架级提示） */
const chartFallback = (
  <p className="py-8 text-center text-sm text-muted-foreground">图表加载中…</p>
);

/** D6 异常原因中文 */
const ANOMALY_REASON_LABELS: Record<"slow" | "hints", string> = {
  slow: "用时偏慢",
  hints: "提示过多",
};

/** 一张异常题卡片（点击跳作答详情） */
function AnomalyCard({ item }: { item: AnalyticsAnomalyQuestion }) {
  return (
    <li className="rounded-xl border border-border bg-card p-4">
      <p className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
          {QUESTION_TYPE_LABELS[item.type]} · 难度 {item.difficulty}
        </span>
        {item.reasons.map((reason) => (
          <span
            key={reason}
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
              reason === "slow"
                ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                : "bg-violet-500/15 text-violet-700 dark:text-violet-300"
            }`}
          >
            {reason === "slow" ? (
              <Clock3 aria-hidden className="size-3" />
            ) : (
              <Lightbulb aria-hidden className="size-3" />
            )}
            {ANOMALY_REASON_LABELS[reason]}
          </span>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {formatRelativeTime(item.submittedAt)}
        </span>
      </p>
      <RichMarkdown source={item.stemMd} className="mt-2 text-sm" />
      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>用时 {formatActiveSec(item.activeSec)}</span>
        {item.medianSec !== null && (
          <span>
            全域中位数 {formatActiveSec(item.medianSec)}
            {item.multipleOfMedian !== null &&
              `（约 ${item.multipleOfMedian} 倍）`}
          </span>
        )}
        <span>提示 {item.hintsUsed} 次</span>
      </p>
      <Link
        to={`/t/data/attempts/${item.attemptId}`}
        className="mt-2 inline-flex min-h-11 items-center rounded-lg border border-border bg-background px-4 text-sm font-medium outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        查看作答详情
      </Link>
    </li>
  );
}

export function InsightsStudentPage() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useMemo(() => parseAnalyticsUrl(searchParams), [searchParams]);

  const coursesQuery = useTeacherCourses(false);
  const studentQuery = useAnalyticsStudent(
    id,
    analyticsApiParams(state, false),
  );

  function applyPatch(patch: Partial<AnalyticsUrlState>): void {
    void setSearchParams(analyticsUrlQuery({ ...state, ...patch }));
  }

  const data = studentQuery.data;

  // 404：学生不存在或不属于本教师（不暴露存在性，T2B 口径）
  if (
    studentQuery.isError &&
    studentQuery.error instanceof ApiError &&
    studentQuery.error.code === "STUDENT_NOT_FOUND"
  ) {
    return (
      <section className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 px-4 py-24 text-center">
        <TriangleAlert aria-hidden className="size-10 text-muted-foreground" />
        <h1 className="text-lg font-semibold">找不到这名学生</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          学生不存在或已不属于你，无法查看画像。
        </p>
        <Button variant="outline" className="min-h-11" asChild>
          <Link to="/t/insights">返回学情总览</Link>
        </Button>
      </section>
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
            {data?.studentName ?? "学生画像"}
            {data?.archived && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                已归档
              </span>
            )}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {data !== undefined && (
              <>
                正确率 {formatPercent(data.totals.correctRate)}（对{" "}
                {data.totals.correctCount} / 已判定 {data.totals.judgedCount}{" "}
                题）· 待批 {data.totals.pendingCount} 题
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* T4.4：导出给 AI 入口（带 studentId 预填该生进入向导第①步） */}
          <Button variant="outline" className="min-h-11" asChild>
            <Link
              to={{
                pathname: "/t/export",
                search:
                  id !== undefined
                    ? `?studentId=${encodeURIComponent(id)}`
                    : "",
              }}
            >
              <Sparkles aria-hidden />
              导出给 AI
            </Link>
          </Button>
          <Button variant="outline" className="min-h-11" asChild>
            <Link
              to={{
                pathname: "/t/data",
                search:
                  id !== undefined
                    ? `?studentId=${encodeURIComponent(id)}`
                    : "",
              }}
            >
              <ArrowLeft aria-hidden />
              查看该生全部作答
            </Link>
          </Button>
        </div>
      </header>

      <AnalyticsFilterBar
        state={state}
        courses={coursesQuery.data?.courses ?? []}
        showFocusDays={false}
        onPatch={applyPatch}
        onReset={() => void setSearchParams(new URLSearchParams())}
      />

      {studentQuery.isPending && (
        <div
          role="status"
          aria-label="正在加载学生画像"
          className="flex flex-col gap-3"
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-32 animate-pulse rounded-xl border border-border bg-muted/50"
            />
          ))}
          <p className="text-sm text-muted-foreground">正在加载学生画像…</p>
        </div>
      )}

      {studentQuery.isError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            学生画像加载失败
          </p>
          <p className="text-sm text-muted-foreground">
            {studentQuery.error instanceof Error
              ? studentQuery.error.message
              : "网络异常，请稍后重试"}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => void studentQuery.refetch()}
          >
            重试
          </Button>
        </div>
      )}

      {data !== undefined && (
        <>
          <section aria-label="正确率周趋势" className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">
              正确率周趋势
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                自然周（北京周一起算，按提交时间）
              </span>
            </h2>
            <Suspense fallback={chartFallback}>
              <TrendLineChart points={data.trend} />
            </Suspense>
          </section>

          <section aria-label="考点正确率" className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">
              考点正确率
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                条形图为最薄弱的前几项（正确率升序，薄弱在上）
              </span>
            </h2>
            <Suspense fallback={chartFallback}>
              <KnowledgeBarChart rows={data.knowledge} />
            </Suspense>
            {data.knowledge.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full border-collapse text-sm">
                  <caption className="sr-only">
                    考点正确率明细（按错误数降序，薄弱在前）
                  </caption>
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-3 py-2 font-medium">
                        考点
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        答对
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        答错
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        待批
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        正确率
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.knowledge.map((row) => (
                      <tr
                        key={row.knowledge}
                        className="border-b border-border last:border-b-0"
                      >
                        <th
                          scope="row"
                          className="px-3 py-2 text-left font-normal"
                        >
                          {row.knowledge}
                        </th>
                        <td className="px-3 py-2">{row.correctCount}</td>
                        <td className="px-3 py-2">{row.wrongCount}</td>
                        <td className="px-3 py-2">{row.pendingCount}</td>
                        <td className="px-3 py-2 font-medium">
                          {formatPercent(row.correctRate)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-label="错题列表" className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">
              错题列表
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                当前范围内判错的题（同题多次判错取最近一次）；点击查看作答详情
              </span>
            </h2>
            {data.wrongQuestions.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
                该生在当前范围内没有判错的题目。
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.wrongQuestions.map((row) => (
                  <li key={`${row.attemptId}:${row.questionId}`}>
                    <Link
                      to={`/t/data/attempts/${row.attemptId}`}
                      aria-label={`查看错题 ${row.questionId} 的作答详情`}
                      className="flex flex-col gap-1.5 rounded-xl border border-border bg-card px-4 py-3 outline-none transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="rounded-full bg-muted px-2 py-0.5">
                          {row.unitTitle ?? "（已移出单元）"}
                        </span>
                        <span>
                          {QUESTION_TYPE_LABELS[row.type]} · 难度{" "}
                          {row.difficulty}
                        </span>
                        <span className="ml-auto">
                          {formatRelativeTime(row.submittedAt)}
                        </span>
                      </p>
                      <RichMarkdown source={row.stemMd} className="text-sm" />
                      <p className="text-xs text-muted-foreground">
                        学生答案：{row.answerText ?? "未作答"}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="用时异常题" className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">
              用时异常题
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                有效用时超全域中位数 2 倍或提示 ≥2 次
              </span>
            </h2>
            {data.anomalies.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
                没有命中异常的题目。
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {data.anomalies.map((item) => (
                  <AnomalyCard
                    key={`${item.attemptId}:${item.questionId}`}
                    item={item}
                  />
                ))}
              </ul>
            )}
          </section>

          <section aria-label="重做概览" className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">
              课程练习重做
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                独立指标，不受时间范围限制
              </span>
            </h2>
            {data.redo.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
                该生还没有课程练习作答。
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full border-collapse text-sm">
                  <caption className="sr-only">
                    课程练习重做概览（全部课程练习单元）
                  </caption>
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-3 py-2 font-medium">
                        课程
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        单元
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        做过
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        重做
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        首次得分
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        最近交卷
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.redo.map((row) => (
                      <tr
                        key={`${row.courseId ?? "none"}:${row.unitId}`}
                        className="border-b border-border last:border-b-0"
                      >
                        <th
                          scope="row"
                          className="px-3 py-2 text-left font-normal"
                        >
                          {row.courseName ?? "—"}
                        </th>
                        <td className="px-3 py-2">{row.unitTitle}</td>
                        <td className="px-3 py-2">{row.attemptCount} 次</td>
                        <td className="px-3 py-2">{row.redoCount} 次</td>
                        <td className="px-3 py-2">
                          {formatScore(row.firstScore)}
                        </td>
                        <td className="px-3 py-2">
                          {row.latestSubmittedAt === null
                            ? "—"
                            : formatDueTime(row.latestSubmittedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section
            aria-label="离线作答"
            className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4"
          >
            <h2 className="text-sm font-semibold">离线作答占比</h2>
            <p className="text-2xl font-semibold">
              {formatPercent(data.offline.offlineShare)}
            </p>
            <p className="text-xs text-muted-foreground">
              离线 {Math.round(data.offline.offlineSecTotal / 60)} 分钟 / 有效{" "}
              {Math.round(data.offline.activeSecTotal / 60)} 分钟（按设备联网
              状态标记，统计窗口内的已交卷作答）
            </p>
          </section>

          <section aria-label="讲义阅读地图" className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">讲义阅读地图</h2>
            <LectureReadingMapView entries={data.lectures} />
          </section>

          {/* T4.6 后接入报告实数据；本阶段占位空态，不做假数据 */}
          <section aria-label="AI 报告" className="flex flex-col gap-2">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Sparkles aria-hidden className="size-4 text-primary" />
              AI 报告
            </h2>
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-10 text-center">
              <p className="text-sm font-medium">AI 报告将在连接 AI 后出现</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                连接 AI（MCP）后，AI 可以基于这名学生的学情数据生成诊断与
                讲解建议，报告会列在这里供你查看。
              </p>
            </div>
          </section>
        </>
      )}
    </section>
  );
}

// 供 App.tsx 路由级懒加载
export default InsightsStudentPage;
