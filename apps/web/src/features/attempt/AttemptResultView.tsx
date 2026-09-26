import type { AttemptResultData, AttemptResultQuestion } from "@tutor/contract";
import { cn } from "cn";
import { CheckCircle2, ChevronDown, Clock, XCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { formatCnTime } from "@/lib/time";
import {
  formatReferenceAnswers,
  formatStudentAnswer,
  letterOf,
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "./answer-format";

/**
 * 交卷后的结果视图（T2.6）：顶部得分汇总（scoreAuto/对错待批数/提交时间）+
 * 逐题结果卡（✓/✗/待批图标、题干快照、本人答案 vs 参考答案、详解默认折叠）。
 * 详解只在交卷后由服务端下发（AGENTS 第 3 条对「未交卷题目」的限制已解除）。
 */

/** 判定图标：true=绿勾、false=红叉、null=待批（含未作答，琥珀时钟） */
function VerdictIcon({ autoCorrect }: { autoCorrect: boolean | null }) {
  if (autoCorrect === true) {
    return (
      <CheckCircle2
        aria-label="答对"
        className="size-5 shrink-0 text-emerald-600"
      />
    );
  }
  if (autoCorrect === false) {
    return (
      <XCircle aria-label="答错" className="size-5 shrink-0 text-red-600" />
    );
  }
  return (
    <Clock aria-label="待批改" className="size-5 shrink-0 text-amber-500" />
  );
}

/** 判定文字（与图标一致的辅助文本） */
function verdictLabel(autoCorrect: boolean | null): string {
  if (autoCorrect === true) return "答对";
  if (autoCorrect === false) return "答错";
  return "待批改";
}

/** 选项行（含正确项与学生所选标记；仅 choice/multi） */
function ResultOptions({ question }: { question: AttemptResultQuestion }) {
  const options = question.snapshot.options;
  if (options === undefined) return null;
  const picked =
    question.answer?.kind === "choice"
      ? [question.answer.index]
      : question.answer?.kind === "multi"
        ? question.answer.indexes
        : [];
  const correct =
    question.answers?.kind === "choice"
      ? [question.answers.index]
      : question.answers?.kind === "multi"
        ? question.answers.indexes
        : [];
  return (
    <ol className="flex flex-col gap-1.5" aria-label="选项">
      {options.map((option, index) => {
        const isPicked = picked.includes(index);
        const isCorrect = correct.includes(index);
        return (
          <li
            key={option}
            className={cn(
              "flex min-h-11 items-start gap-2 rounded-lg border px-3 py-2 text-sm",
              isCorrect
                ? "border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10"
                : isPicked
                  ? "border-red-300 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10"
                  : "border-transparent",
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
            {isPicked && !isCorrect && (
              <span className="shrink-0 text-xs font-medium text-red-700 dark:text-red-300">
                你的选择
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** 详解折叠（默认收起，触控 ≥44px） */
function SolutionFold({ solutionMd }: { solutionMd: string | null }) {
  const [open, setOpen] = useState(false);
  if (solutionMd === null) {
    return <p className="text-sm text-muted-foreground">这道题没有详解。</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="outline"
        className="min-h-11 w-fit"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        查看详解
        <ChevronDown
          aria-hidden
          className={cn("size-4 transition-transform", open && "rotate-180")}
        />
      </Button>
      {open && (
        <div className="rounded-lg border border-border bg-muted/40 p-4">
          <RichMarkdown source={solutionMd} className="text-sm" />
        </div>
      )}
    </div>
  );
}

/** 单题结果卡 */
function ResultQuestionCard({
  index,
  question,
}: {
  index: number;
  question: AttemptResultQuestion;
}) {
  return (
    <article
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 text-card-foreground sm:p-5"
      aria-label={`第 ${index + 1} 题`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <VerdictIcon autoCorrect={question.autoCorrect} />
          {verdictLabel(question.autoCorrect)}
        </span>
        <p className="text-sm font-semibold">第 {index + 1} 题</p>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${QUESTION_TYPE_BADGE_CLASS[question.snapshot.type]}`}
        >
          {QUESTION_TYPE_LABELS[question.snapshot.type]}
        </span>
        <span
          role="img"
          className="text-xs text-amber-500"
          aria-label={`难度 ${question.snapshot.difficulty} 星`}
        >
          {"★".repeat(question.snapshot.difficulty)}
          <span className="text-muted-foreground/60">
            {"★".repeat(5 - question.snapshot.difficulty)}
          </span>
        </span>
        {question.snapshot.knowledge.map((name) => (
          <span
            key={name}
            className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
          >
            {name}
          </span>
        ))}
      </div>

      {/* 题干快照（交卷时冻结的原文，[[答案]] 渲染为空框定位） */}
      <RichMarkdown source={question.snapshot.stemMd} className="text-base" />
      <ResultOptions question={question} />

      <div className="flex flex-col gap-1.5 rounded-lg bg-muted/40 px-4 py-3 text-sm sm:flex-row sm:gap-6">
        <p className="flex flex-wrap gap-1.5">
          <span className="shrink-0 text-muted-foreground">你的答案：</span>
          <span
            className={cn(
              "font-medium",
              question.answer === null && "text-muted-foreground",
            )}
          >
            {formatStudentAnswer(question.answer)}
          </span>
        </p>
        <p className="flex flex-wrap gap-1.5">
          <span className="shrink-0 text-muted-foreground">参考答案：</span>
          <span className="font-medium">
            {question.answers === null
              ? "由老师批改后公布"
              : formatReferenceAnswers(question.answers)}
          </span>
        </p>
      </div>

      <SolutionFold solutionMd={question.solutionMd} />
    </article>
  );
}

/** 结果视图本体 */
export function AttemptResultView({
  data,
  onBackHome,
}: {
  data: AttemptResultData;
  onBackHome: () => void;
}) {
  const { attempt, summary } = data;
  return (
    <div className="flex flex-col gap-5">
      {/* 得分汇总卡 */}
      <section
        aria-labelledby="result-summary"
        className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
      >
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 id="result-summary" className="text-base font-semibold">
            {data.title} · 批改结果
          </h2>
          {attempt.submittedAt !== null && (
            <p className="text-xs text-muted-foreground">
              交卷时间：{formatCnTime(attempt.submittedAt)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <p className="flex items-baseline gap-2">
            <span className="text-4xl font-bold text-primary">
              {attempt.scoreAuto === null ? "待批" : attempt.scoreAuto}
            </span>
            <span className="text-sm text-muted-foreground">
              {attempt.scoreAuto === null
                ? "暂无可自动判分的题目"
                : "自动判分得分（满分 100）"}
            </span>
          </p>
          <p className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
            <span>
              共 <b className="text-foreground">{summary.total}</b> 题
            </span>
            <span>
              答对 <b className="text-emerald-600">{summary.correct}</b> 题
            </span>
            <span>
              答错 <b className="text-red-600">{summary.wrong}</b> 题
            </span>
            <span>
              待批 <b className="text-amber-600">{summary.pending}</b> 题
              {summary.unanswered > 0 && `（含未答 ${summary.unanswered} 题）`}
            </span>
          </p>
        </div>
        <Button
          variant="outline"
          className="min-h-11 w-fit"
          onClick={onBackHome}
        >
          返回首页
        </Button>
      </section>

      {/* 逐题结果 */}
      <ol className="flex flex-col gap-4">
        {data.questions.map((question, index) => (
          <li key={question.questionId}>
            <ResultQuestionCard index={index} question={question} />
          </li>
        ))}
      </ol>
    </div>
  );
}
