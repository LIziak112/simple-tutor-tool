import type { AnalyticsFocusCard } from "@tutor/contract";
import { Target } from "lucide-react";
import { Link } from "react-router";
import { QUESTION_TYPE_LABELS } from "@/features/attempt/answer-format";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { formatDueTime, formatRelativeTime } from "@/lib/time";
import { formatPercent } from "./insights-format";

/**
 * 「下节课重点」卡片（T4.2，D5）：focusDays 周期内错误最多 3 考点 + 代表错题
 * （题干为快照原文 RichMarkdown 渲染，[[答案]] 显示为空框）。代表错题整卡
 * 链接到作答详情页（/t/data/attempts/:id），便于备课时直击错因。
 */
export function FocusCard({ focus }: { focus: AnalyticsFocusCard }) {
  return (
    <section
      aria-label="下节课重点"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      <header className="flex flex-wrap items-center gap-2">
        <Target aria-hidden className="size-4 text-primary" />
        <h2 className="text-sm font-semibold">下节课重点</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          最近 {focus.focusDays} 天 · 起自 {formatDueTime(focus.from)}
        </span>
      </header>

      {focus.points.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          周期内没有判错记录，继续保持。
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {focus.points.map((point) => (
            <li
              key={point.knowledge}
              className="rounded-lg border border-border bg-background/50 p-3"
            >
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-semibold">{point.knowledge}</span>
                <span className="text-xs text-muted-foreground">
                  判错 {point.wrongCount} 题 · 已判定 {point.judgedCount} 题
                </span>
                <span className="text-xs font-medium text-red-600 dark:text-red-400">
                  正确率 {formatPercent(point.correctRate)}
                </span>
              </p>
              <div className="mt-2 rounded-lg bg-muted/40 p-2.5">
                <p className="mb-1 text-xs text-muted-foreground">
                  代表错题（{QUESTION_TYPE_LABELS[point.representative.type]}·
                  难度 {point.representative.difficulty}）
                </p>
                <RichMarkdown
                  source={point.representative.stemMd}
                  className="min-w-0 text-sm"
                />
                <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{point.representative.studentName}</span>
                  <span>
                    学生答案：
                    {point.representative.answerText ?? "未作答"}
                  </span>
                  <span>
                    {formatRelativeTime(point.representative.submittedAt)}
                  </span>
                </p>
                <Link
                  to={`/t/data/attempts/${point.representative.attemptId}`}
                  className="mt-2 inline-flex min-h-11 items-center rounded-lg border border-border bg-card px-4 text-sm font-medium outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  查看作答详情
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
