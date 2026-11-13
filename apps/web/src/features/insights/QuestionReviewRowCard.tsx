import type { QuestionReviewRow } from "@tutor/contract";
import { Link } from "react-router";
import { QUESTION_TYPE_LABELS } from "@/features/attempt/answer-format";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { formatRelativeTime } from "@/lib/time";

/** 聚合行判定列文案（finalCorrect 三态） */
function reviewVerdictLabel(finalCorrect: boolean | null): string {
  if (finalCorrect === false) return "判错";
  if (finalCorrect === true) return "判对";
  return "待批";
}

/** 「错题与存疑」聚合行卡片（Web-2②；整行点击跳代表作答详情） */
export function QuestionReviewRowCard({ row }: { row: QuestionReviewRow }) {
  const verdict =
    row.effectiveVerdict === undefined
      ? row.finalCorrect
      : (row.effectiveVerdict?.value ?? null);
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
              verdict === false
                ? "font-medium text-red-600"
                : verdict === true
                  ? "font-medium text-emerald-600"
                  : ""
            }
          >
            {reviewVerdictLabel(verdict)}
          </span>
          {row.effectiveVerdict?.source === "self" && <span>学生自评</span>}
          {row.studentFlag === "unsure" && <span>自标「不会」</span>}
          {row.hasCorrection && <span>已订正</span>}
          {row.hasAiHelp && <span>问过 AI</span>}
          {row.redoCount > 0 && <span>重做 {row.redoCount} 次</span>}
        </p>
      </Link>
    </li>
  );
}
