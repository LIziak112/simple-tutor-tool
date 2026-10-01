import type { AnalyticsQuestionRow } from "@tutor/contract";
import { ChevronDown, Clock3, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { QUESTION_TYPE_LABELS } from "@/features/attempt/answer-format";
import { useTeacherCourses } from "@/features/courses/course-queries";
import {
  AnalyticsFilterBar,
  type AnalyticsUrlState,
  analyticsApiParams,
  analyticsUrlQuery,
  InsightsViewSwitcher,
  parseAnalyticsUrl,
} from "@/features/insights/analytics-filters";
import { useAnalyticsQuestions } from "@/features/insights/analytics-queries";
import { formatPercent } from "@/features/insights/insights-format";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { formatActiveSec } from "@/features/teacher-attempts/AttemptDetailQuestionCard";
import { formatDueTime } from "@/lib/time";

/**
 * /t/insights/questions 题目视角（T4.2）：
 * - 题目/考点正确率、平均/中位用时、高频错误答案分布（top N）；
 * - 表格行可展开：题干快照全文（RichMarkdown）+ 高频错误答案清单；
 * - 筛选（时间范围/课程）与总览同款、同 URL 参数，视图切换不丢；
 * - 行序为服务端稳定序（单元内题序，快照兜底行追加在末尾），前端不重排。
 */

/** 题干截断展示长度（字符） */
const STEM_EXCERPT_LEN = 24;

/** 题干截断（去 Markdown 标记的粗略文本，全文在展开行渲染） */
function stemExcerpt(stemMd: string): string {
  const flat = stemMd
    .replace(/\[\[[^\]]*\]\]/g, "____")
    .replace(/[#>*_`$|-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > STEM_EXCERPT_LEN
    ? `${flat.slice(0, STEM_EXCERPT_LEN)}…`
    : flat;
}

/** 一行题目统计（点击展开题干与高频错误答案） */
function QuestionRow({
  row,
  expanded,
  onToggle,
}: {
  row: AnalyticsQuestionRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-b border-border">
        <td className="px-3 py-1.5 text-xs text-muted-foreground">
          {row.unitTitle ?? "（已移出单元）"}
        </td>
        <th scope="row" className="px-3 py-1.5 text-left font-normal">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="flex min-h-11 w-full items-center gap-1.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronDown
              aria-hidden
              className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                expanded ? "rotate-180" : ""
              }`}
            />
            <span className="min-w-0 truncate text-sm">
              {stemExcerpt(row.stemMd)}
            </span>
          </button>
        </th>
        <td className="px-3 py-1.5 text-xs">
          {QUESTION_TYPE_LABELS[row.type]} · 难度 {row.difficulty}
        </td>
        <td className="px-3 py-1.5">{row.submittedCount}</td>
        <td className="px-3 py-1.5 font-medium">
          {formatPercent(row.correctRate)}
        </td>
        <td className="px-3 py-1.5">
          {row.pendingCount > 0 ? (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
              待批 {row.pendingCount}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-3 py-1.5 text-xs">{formatActiveSec(row.avgSec)}</td>
        <td className="px-3 py-1.5 text-xs">
          {formatActiveSec(row.medianSec)}
        </td>
        <td className="px-3 py-1.5">
          {row.anomalyCount > 0 ? (
            <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
              <TriangleAlert aria-hidden className="size-3" />
              {row.anomalyCount}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border bg-muted/20">
          <td colSpan={9} className="px-4 py-3">
            <p className="mb-1 text-xs text-muted-foreground">
              考点：{row.knowledge.length > 0 ? row.knowledge.join("、") : "—"}
            </p>
            <RichMarkdown source={row.stemMd} className="text-sm" />
            <div className="mt-2">
              <p className="flex items-center gap-1 text-xs font-medium">
                <Clock3 aria-hidden className="size-3 text-muted-foreground" />
                高频错误答案
              </p>
              {row.wrongAnswers.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  无错误答案分布（题型不聚合或窗口内没有判错）。
                </p>
              ) : (
                <ul className="mt-1 flex flex-wrap gap-2">
                  {row.wrongAnswers.map((wrong) => (
                    <li
                      key={`${wrong.answerText ?? "未作答"}`}
                      className="rounded-full bg-red-500/10 px-2.5 py-1 text-xs text-red-700 dark:text-red-300"
                    >
                      {wrong.answerText ?? "（未作答）"} × {wrong.count}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                最近提交{" "}
                {row.lastSubmittedAt === null
                  ? "—"
                  : formatDueTime(row.lastSubmittedAt)}
              </p>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function InsightsQuestionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useMemo(() => parseAnalyticsUrl(searchParams), [searchParams]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const coursesQuery = useTeacherCourses(false);
  const questionsQuery = useAnalyticsQuestions(
    analyticsApiParams(state, false),
  );

  function applyPatch(patch: Partial<AnalyticsUrlState>): void {
    void setSearchParams(analyticsUrlQuery({ ...state, ...patch }));
  }

  const data = questionsQuery.data;

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">题目视角</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            逐题看正确率、用时与高频错误答案——哪道题全班都错，一眼定位；
            点击行可展开题干全文。
          </p>
        </div>
        <InsightsViewSwitcher
          view="questions"
          query={analyticsUrlQuery(state).toString()}
        />
      </header>

      <AnalyticsFilterBar
        state={state}
        courses={coursesQuery.data?.courses ?? []}
        showFocusDays={false}
        onPatch={applyPatch}
        onReset={() => void setSearchParams(new URLSearchParams())}
      />

      {data && (
        <p className="text-xs text-muted-foreground">
          统计窗口：
          {data.range.from === null
            ? "全部时间"
            : `${formatDueTime(data.range.from)} 起`}{" "}
          至今（按提交时间）；行序按单元内题序。
        </p>
      )}

      {questionsQuery.isPending && (
        <div
          role="status"
          aria-label="正在加载题目统计"
          className="flex flex-col gap-3"
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-xl border border-border bg-muted/50"
            />
          ))}
          <p className="text-sm text-muted-foreground">正在加载题目统计…</p>
        </div>
      )}

      {questionsQuery.isError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            题目统计加载失败
          </p>
          <p className="text-sm text-muted-foreground">
            {questionsQuery.error instanceof Error
              ? questionsQuery.error.message
              : "网络异常，请稍后重试"}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => void questionsQuery.refetch()}
          >
            重试
          </Button>
        </div>
      )}

      {data !== undefined &&
        (data.questions.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
            <p className="text-sm font-medium">当前范围内没有题目统计</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              换一个时间范围或课程再看看；学生交卷后题目统计会出现在这里。
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                题目统计：正确率、用时与高频错误答案
              </caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="min-w-24 px-3 py-2 font-medium">
                    单元
                  </th>
                  <th scope="col" className="min-w-48 px-3 py-2 font-medium">
                    题干
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    题型
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    提交
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    对率
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    待批
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    均时
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    中位
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    异常
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.questions.map((row) => (
                  <QuestionRow
                    key={row.questionId}
                    row={row}
                    expanded={expandedId === row.questionId}
                    onToggle={() =>
                      setExpandedId((prev) =>
                        prev === row.questionId ? null : row.questionId,
                      )
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

// 供 App.tsx 路由级懒加载
export default InsightsQuestionsPage;
