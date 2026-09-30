import type { WrongQuestionCard } from "@tutor/contract";
import { cn } from "cn";
import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SolutionFold } from "@/features/attempt/AttemptResultView";
import {
  formatReferenceAnswers,
  letterOf,
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "@/features/attempt/answer-format";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { formatRelativeTime } from "@/lib/time";
import { RecordSourceBadge, recordTitleOf } from "./records-views";

/**
 * /s/records/wrong 错题本的 URL 状态与卡片（T3.5，D11）：
 * - 筛选同步 URL query：knowledge（考点精确匹配，服务端参数）与
 *   includeResolved（「显示已攻克」开关）——刷新、返回不丢；
 * - 考点 chips：选项从错题本全量数据（includeResolved=true 形态）聚合，
 *   与列表查询互不影响各自缓存；
 * - 条目卡片：题干（快照 RichMarkdown 渲染，[[答案]] 标记渲染为空框不显示
 *   答案原文）、本人最近答案、正确答案、详解默认折叠（共用结果视图的
 *   SolutionFold）、首次是否做对标记、最近来源（课程/作业 + 时间）。
 */

/** 错题本页 URL 状态（单一事实来源是 URL query） */
export interface WrongQuestionsUrlState {
  /** 考点筛选（null = 不筛） */
  knowledge: string | null;
  /** 「显示已攻克」开关（false = 只列最近仍错的题，D11 默认） */
  includeResolved: boolean;
}

/** 默认状态（不筛考点、不显示已攻克） */
export const DEFAULT_WRONG_QUESTIONS_URL_STATE: WrongQuestionsUrlState = {
  knowledge: null,
  includeResolved: false,
};

/** URLSearchParams → 页面状态（knowledge 空串视为未选） */
export function parseWrongQuestionsUrl(
  search: URLSearchParams,
): WrongQuestionsUrlState {
  const knowledge = search.get("knowledge");
  return {
    knowledge: knowledge !== null && knowledge !== "" ? knowledge : null,
    includeResolved: search.get("includeResolved") === "true",
  };
}

/** 页面状态 → URLSearchParams（只写非默认项，保持地址干净） */
export function wrongQuestionsUrlQuery(
  state: WrongQuestionsUrlState,
): URLSearchParams {
  const params = new URLSearchParams();
  if (state.knowledge !== null) params.set("knowledge", state.knowledge);
  if (state.includeResolved) params.set("includeResolved", "true");
  return params;
}

/**
 * 考点 chips（全部 + 各考点；aria-pressed 表当前选中，触控 ≥44px）。
 * 选项由页面从全量形态聚合传入。
 */
export function KnowledgeChips({
  knowledge,
  options,
  onSelect,
}: {
  knowledge: string | null;
  options: string[];
  onSelect: (knowledge: string | null) => void;
}) {
  return (
    <fieldset
      className="flex flex-wrap items-center gap-2"
      aria-label="考点筛选"
    >
      <Button
        variant={knowledge === null ? "default" : "outline"}
        className="min-h-11"
        aria-pressed={knowledge === null}
        onClick={() => onSelect(null)}
      >
        全部考点
      </Button>
      {options.map((name) => (
        <Button
          key={name}
          variant={knowledge === name ? "default" : "outline"}
          className="min-h-11"
          aria-pressed={knowledge === name}
          onClick={() => onSelect(name)}
        >
          {name}
        </Button>
      ))}
    </fieldset>
  );
}

/** 「显示已攻克」开关（aria-pressed；触控 ≥44px） */
export function IncludeResolvedSwitch({
  checked,
  onToggle,
}: {
  checked: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <Button
      variant={checked ? "default" : "outline"}
      className="min-h-11"
      aria-pressed={checked}
      onClick={() => onToggle(!checked)}
    >
      显示已攻克
    </Button>
  );
}

/** 首次是否做对标记（最早一次已判定作答；D11 条目标注） */
function FirstCorrectMark({ firstCorrect }: { firstCorrect: boolean }) {
  return firstCorrect ? (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
      <CheckCircle2 aria-hidden className="size-3" />
      首次做对
    </span>
  ) : (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-300">
      <XCircle aria-hidden className="size-3" />
      首次做错
    </span>
  );
}

/** 选项列表（仅 choice/multi；正确项标记，本人选择不在此回显——答案是文本行） */
function WrongOptions({ question }: { question: WrongQuestionCard }) {
  const options = question.options;
  if (options === undefined) return null;
  const correct =
    question.answers?.kind === "choice"
      ? [question.answers.index]
      : question.answers?.kind === "multi"
        ? question.answers.indexes
        : [];
  return (
    <ol className="flex flex-col gap-1.5" aria-label="选项">
      {options.map((option, index) => {
        const isCorrect = correct.includes(index);
        return (
          <li
            key={option}
            className={cn(
              "flex min-h-11 items-start gap-2 rounded-lg border px-3 py-2 text-sm",
              isCorrect &&
                "border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10",
              !isCorrect && "border-transparent",
            )}
          >
            <span className="mt-0.5 w-5 shrink-0 font-semibold">
              {letterOf(index)}
            </span>
            <RichMarkdown source={option} className="min-w-0 flex-1 text-sm" />
            {isCorrect && (
              <span className="shrink-0 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                正确项
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** 单条错题卡片（最近仍错 / 已攻克两形态共用） */
export function WrongQuestionItem({
  question,
}: {
  question: WrongQuestionCard;
}) {
  return (
    <article className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 text-card-foreground sm:p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <FirstCorrectMark firstCorrect={question.firstCorrect} />
        {question.resolved && (
          <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            已攻克
          </span>
        )}
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${QUESTION_TYPE_BADGE_CLASS[question.type]}`}
        >
          {QUESTION_TYPE_LABELS[question.type]}
        </span>
        <span
          role="img"
          className="text-xs text-amber-500"
          aria-label={`难度 ${question.difficulty} 星`}
        >
          {"★".repeat(question.difficulty)}
          <span className="text-muted-foreground/60">
            {"★".repeat(5 - question.difficulty)}
          </span>
        </span>
        {question.knowledge.map((name) => (
          <span
            key={name}
            className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
          >
            {name}
          </span>
        ))}
      </div>

      {/* 题干快照（[[答案]] 标记渲染为空框，答案在下方面板单独展示） */}
      <RichMarkdown source={question.stemMd} className="text-base" />
      <WrongOptions question={question} />

      <div className="flex flex-col gap-1.5 rounded-lg bg-muted/40 px-4 py-3 text-sm sm:flex-row sm:gap-6">
        <p className="flex min-w-0 flex-wrap gap-1.5">
          <span className="shrink-0 text-muted-foreground">我的最近答案：</span>
          <span
            className={cn(
              "font-medium",
              question.answerText === null && "text-muted-foreground",
            )}
          >
            {question.answerText ?? "未作答"}
          </span>
        </p>
        {/* 正确答案走 RichMarkdown（填空答案 $…$ 公式与结果视图同一管线渲染） */}
        <div className="flex min-w-0 flex-wrap gap-1.5">
          <span className="shrink-0 text-muted-foreground">正确答案：</span>
          {question.answers === null ? (
            <span className="font-medium">由老师批改后公布</span>
          ) : (
            <RichMarkdown
              source={formatReferenceAnswers(question.answers)}
              className="min-w-0 font-medium [&_p]:my-0"
            />
          )}
        </div>
      </div>

      <SolutionFold solutionMd={question.solutionMd} />

      <p className="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <RecordSourceBadge sourceType={question.sourceType} />
        <span className="min-w-0 truncate">
          最近来源：{recordTitleOf(question)}
          {question.courseName !== null && `（${question.courseName}）`}
        </span>
        <span className="ml-auto shrink-0">
          {formatRelativeTime(question.lastAt)}
        </span>
      </p>
    </article>
  );
}
