import type {
  AnalyticsAnomalyQuestion,
  QuestionReviewKind,
  QuestionReviewRow,
  TeacherAttemptCard,
} from "@tutor/contract";
import {
  ArrowLeft,
  ChevronDown,
  Clock3,
  Lightbulb,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { QUESTION_TYPE_LABELS } from "@/features/attempt/answer-format";
import { formatResultCounts } from "@/features/attempt/result-counts";
import { useTeacherCourses } from "@/features/courses/course-queries";
import {
  AnalyticsFilterBar,
  type AnalyticsUrlState,
  analyticsApiParams,
  analyticsUrlQuery,
  parseAnalyticsUrl,
} from "@/features/insights/analytics-filters";
import {
  useAnalyticsStudent,
  useQuestionReview,
} from "@/features/insights/analytics-queries";
import { formatPercent } from "@/features/insights/insights-format";
import { LectureReadingMapView } from "@/features/insights/LectureReadingMapView";
import { StudentReportsSection } from "@/features/insights/StudentReportsSection";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { formatActiveSec } from "@/features/teacher-attempts/AttemptDetailQuestionCard";
import {
  AttemptStatusBadge,
  sourceContextOf,
} from "@/features/teacher-attempts/attempt-views";
import { useTeacherAttempts } from "@/features/teacher-attempts/teacher-attempt-queries";
import { ApiError } from "@/lib/api";
import { formatDueTime, formatRelativeTime } from "@/lib/time";

/**
 * /t/students/:id 学生主页（T-PR1 路由归位：内容迁自原 T4.2 学生画像页，
 * 旧 /t/insights/students/:id 保留并重定向到此——教师端以「学生」为导航单位）：
 * - T-PR4 Web-2 四区：① 作答记录（内嵌教师作答列表最近 10 卷；进行中讲练卷
 *   显示「已提交 n / 共 m」）；② 错题与存疑（聚合端点 question-review 三档
 *   kind 切换，一行 = 一题的最近代表作答，整行跳作答详情）；③ 讲义阅读地图；
 *   ④ AI 报告（默认折叠、展开才取列表——主页首屏请求 ≤ 4，方案验收）；
 * - 薄弱考点前 5 文字表（数据 /analytics/student/:id 的 knowledge，按错误数
 *   降序，薄弱在前；原周趋势折线与考点条形图随路由归位移除，不加新图表）；
 * - 用时异常题卡片（D6：slow/hints 两类，跳作答详情）；
 * - 重做概览（独立指标 D1，不受时间范围限制）、离线作答占比；
 * - 学生不存在 / 非本教师 → 接口 404 STUDENT_NOT_FOUND，页面呈现错误态。
 * 筛选（时间范围/课程）同步 URL，从总览矩阵点入时携带上下文；错题与存疑的
 * kind 档位也在 URL（?kind=unsure / corrected，缺省 wrong）。
 */

/** 薄弱考点文字表行数上限（迭代方案 T-PR1：前 5） */
const WEAK_KNOWLEDGE_LIMIT = 5;

/** 「错题与存疑」三档 kind 与中文（T-PR4 Web-2②；档位走 URL ?kind=） */
const REVIEW_KINDS = ["wrong", "unsure", "corrected"] as const;
const REVIEW_KIND_LABELS: Record<QuestionReviewKind, string> = {
  wrong: "判错",
  unsure: "自标不会",
  corrected: "已订正",
};

/** 错题与存疑单页行数（与服务端 limit 默认一致；更多给总数提示） */
const REVIEW_PAGE_LIMIT = 50;

/** 聚合行判定列文案（finalCorrect 三态） */
function reviewVerdictLabel(finalCorrect: boolean | null): string {
  if (finalCorrect === false) return "判错";
  if (finalCorrect === true) return "判对";
  return "待批";
}

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

export function StudentHomePage() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useMemo(() => parseAnalyticsUrl(searchParams), [searchParams]);

  const coursesQuery = useTeacherCourses(false);
  const studentQuery = useAnalyticsStudent(
    id,
    analyticsApiParams(state, false),
  );

  // T-PR4 Web-2②：错题与存疑（kind 走 URL ?kind=；时间下界随筛选 days 同步，
  // days=all 不限时间。from 只依赖 days，避免每渲染生成新 key 打穿缓存）
  const rawKind = searchParams.get("kind");
  const kind: QuestionReviewKind =
    rawKind === "unsure" || rawKind === "corrected" ? rawKind : "wrong";
  const reviewFrom = useMemo(
    () =>
      state.days === "all"
        ? undefined
        : new Date(Date.now() - state.days * 86_400_000).toISOString(),
    [state.days],
  );
  const reviewParams = useMemo(
    () => ({
      kind,
      ...(state.courseId !== null ? { courseId: state.courseId } : {}),
      ...(reviewFrom !== undefined ? { from: reviewFrom } : {}),
      limit: REVIEW_PAGE_LIMIT,
    }),
    [kind, state.courseId, reviewFrom],
  );
  const reviewQuery = useQuestionReview(id, reviewParams);

  // T-PR4 Web-2①：作答记录区（内嵌教师作答列表，最近 10 卷）
  const attemptsQuery = useTeacherAttempts({
    ...(id !== undefined && id !== "" ? { studentId: id } : {}),
    limit: 10,
    offset: 0,
  });

  function applyPatch(patch: Partial<AnalyticsUrlState>): void {
    void setSearchParams(analyticsUrlQuery({ ...state, ...patch }));
  }

  /** 错题与存疑换档：写 URL ?kind=（默认档 wrong 不写，保持地址干净） */
  function applyKind(next: QuestionReviewKind): void {
    const query = analyticsUrlQuery(state);
    if (next !== "wrong") query.set("kind", next);
    void setSearchParams(query);
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
          学生不存在或已不属于你，无法查看主页。
        </p>
        <Button variant="outline" className="min-h-11" asChild>
          <Link to="/t/students">返回学生列表</Link>
        </Button>
      </section>
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
            {data?.studentName ?? "学生主页"}
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
                题）· 未判断 {data.totals.pendingCount} 题
                {(data.totals.selfJudgedCount ?? 0) > 0 && (
                  <span>
                    {" "}
                    · 含自评 {data.totals.selfJudgedCount ?? 0}{" "}
                    题（学生本人判定）
                  </span>
                )}
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

      {/* Web-2① 作答记录 */}
      <section aria-label="作答记录" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">
          作答记录
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            最近 10 卷；点击查看作答详情
          </span>
        </h2>
        {attemptsQuery.isPending && (
          <p className="text-sm text-muted-foreground">正在加载作答记录…</p>
        )}
        {attemptsQuery.isError && (
          <p
            role="alert"
            className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
          >
            作答记录加载失败
            <Button
              variant="outline"
              className="min-h-9"
              onClick={() => void attemptsQuery.refetch()}
            >
              重试
            </Button>
          </p>
        )}
        {attemptsQuery.data !== undefined &&
          (attemptsQuery.data.attempts.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
              该生还没有作答记录。
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {attemptsQuery.data.attempts.map((card) => (
                <AttemptRow key={card.attemptId} card={card} />
              ))}
            </ul>
          ))}
      </section>

      {studentQuery.isPending && (
        <div
          role="status"
          aria-label="正在加载学生主页"
          className="flex flex-col gap-3"
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-32 animate-pulse rounded-xl border border-border bg-muted/50"
            />
          ))}
          <p className="text-sm text-muted-foreground">正在加载学生主页…</p>
        </div>
      )}

      {studentQuery.isError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            学生主页加载失败
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
          <section aria-label="薄弱考点" className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">
              薄弱考点前 5
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                按错误数降序，薄弱在前
              </span>
            </h2>
            {data.knowledge.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
                时间范围内还没有已判定的作答，暂无考点统计。
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full border-collapse text-sm">
                  <caption className="sr-only">
                    薄弱考点前 5（按错误数降序，薄弱在前）
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
                        未判断
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        正确率
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.knowledge
                      .slice(0, WEAK_KNOWLEDGE_LIMIT)
                      .map((row) => (
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

          {/* Web-2② 错题与存疑（聚合端点 question-review，三档 kind） */}
          <section aria-label="错题与存疑" className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">
              错题与存疑
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                按当前时间范围与课程筛选；同题多次取最近一次，点击行查看该次作答详情
              </span>
            </h2>
            <div className="flex flex-wrap gap-2">
              {REVIEW_KINDS.map((item) => (
                <Button
                  key={item}
                  variant={item === kind ? "secondary" : "outline"}
                  className="min-h-9"
                  aria-pressed={item === kind}
                  onClick={() => applyKind(item)}
                >
                  {REVIEW_KIND_LABELS[item]}
                </Button>
              ))}
            </div>
            {reviewQuery.isPending && (
              <p className="text-sm text-muted-foreground">正在加载…</p>
            )}
            {reviewQuery.isError && (
              <p
                role="alert"
                className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
              >
                错题与存疑加载失败
                <Button
                  variant="outline"
                  className="min-h-9"
                  onClick={() => void reviewQuery.refetch()}
                >
                  重试
                </Button>
              </p>
            )}
            {reviewQuery.data !== undefined &&
              (reviewQuery.data.questions.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
                  当前筛选下没有这一类题目。
                </p>
              ) : (
                <>
                  <ul className="flex flex-col gap-2">
                    {reviewQuery.data.questions.map((row) => (
                      <QuestionReviewRowCard key={row.questionId} row={row} />
                    ))}
                  </ul>
                  {reviewQuery.data.nextCursor !== null && (
                    <p className="text-xs text-muted-foreground">
                      已显示前 {reviewQuery.data.questions.length} 题（共{" "}
                      {reviewQuery.data.total} 题）
                    </p>
                  )}
                </>
              ))}
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
                        首次表现
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
                          {formatResultCounts(row.firstResultCounts)}
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

          {/* T4.7：AI 报告实数据（T4.2 占位换实）；T-PR4 Web-2④ 起默认折叠、
          展开才取列表——主页首屏请求 ≤ 4（方案验收） */}
          {id !== undefined && <ReportsDisclosure studentId={id} />}
        </>
      )}
    </section>
  );
}

// ---------- Web-2①/②/④ 子组件 ----------

/** 作答记录区的一行（Web-2①；进行中讲练卷显示「已提交 n / 共 m」） */
function AttemptRow({ card }: { card: TeacherAttemptCard }) {
  return (
    <li>
      <Link
        to={`/t/data/attempts/${card.attemptId}`}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-card px-4 py-3 text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span className="min-w-0 flex-1 truncate font-medium">
          {sourceContextOf(card)}
        </span>
        <AttemptStatusBadge status={card.status} />
        {card.status === "draft" && (
          <span className="text-xs text-muted-foreground">
            已提交 {card.submittedCount ?? 0} / 共 {card.questionCount}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {formatRelativeTime(card.submittedAt ?? card.startedAt)}
        </span>
      </Link>
    </li>
  );
}

/** 「错题与存疑」聚合行卡片（Web-2②；整行点击跳代表作答详情） */
function QuestionReviewRowCard({ row }: { row: QuestionReviewRow }) {
  return (
    <li>
      <Link
        to={`/t/data/attempts/${row.attemptId}`}
        aria-label="查看该题最近一次作答详情"
        className="flex flex-col gap-1.5 rounded-xl border border-border bg-card px-4 py-3 outline-none transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-full bg-muted px-2 py-0.5">
            {QUESTION_TYPE_LABELS[row.type]} · 难度 {row.difficulty}
          </span>
          {row.knowledge.slice(0, 3).map((item) => (
            <span key={item} className="rounded-full bg-muted px-2 py-0.5">
              {item}
            </span>
          ))}
          <span className="ml-auto">{formatRelativeTime(row.lastAt)}</span>
        </p>
        <RichMarkdown source={row.stemMd} className="text-sm" />
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span
            className={
              row.finalCorrect === false
                ? "font-medium text-red-600"
                : row.finalCorrect === true
                  ? "font-medium text-emerald-600"
                  : ""
            }
          >
            {reviewVerdictLabel(row.finalCorrect)}
          </span>
          {row.studentFlag === "unsure" && <span>自标「不会」</span>}
          {row.hasCorrection && <span>已订正</span>}
          {row.hasAiHelp && <span>问过 AI</span>}
          {row.redoCount > 0 && <span>重做 {row.redoCount} 次</span>}
        </p>
      </Link>
    </li>
  );
}

/** 报告区（Web-2④）：默认折叠、展开才请求列表——主页首屏请求 ≤ 4（方案验收） */
function ReportsDisclosure({ studentId }: { studentId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="报告" className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 w-fit items-center gap-1.5 rounded-lg text-sm font-semibold text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        AI 报告
        <ChevronDown
          aria-hidden
          className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && <StudentReportsSection studentId={studentId} />}
    </section>
  );
}

// 供 App.tsx 路由级懒加载
export default StudentHomePage;
