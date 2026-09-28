import type { AttemptResultData, AttemptResultQuestion } from "@tutor/contract";
import { cn } from "cn";
import {
  CheckCircle2,
  ChevronDown,
  Clock,
  Lightbulb,
  PenLine,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { HintEntryList } from "@/features/attempt/HintPanel";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { studentInkPngUrl } from "@/lib/api";
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
 * T2.8：手写题（solve/apply/find-error）追加「我的手写笔迹」缩略图——学生本人
 * 笔迹 PNG 经 GET /api/student/attempts/:id/ink/:questionId.png 文件直出
 * （不进 base64/不进库）；无笔迹时该区块整体隐藏（img onerror 兜底）。
 * T2.11：做题时解锁过的提示在此回看（hintsOpened，只含学生自己请求过的条目；
 * 未解锁提示内容服务端从不下发）。详解只在交卷后由服务端下发
 * （AGENTS 第 3 条对「未交卷题目」的限制已解除）。
 * T2A.8（D11）：answersReleased=false（作业「截止后公布」且未到截止）时——
 * 汇总卡替换为「已交卷，答案将在截止后公布」横幅（含截止时间与已答统计），
 * 逐题卡只渲染题干（公开化版）、选项、本人答案、笔迹与已解锁提示；
 * 不显示对错判定、参考答案与详解（服务端本就不下发，前端双保险不渲染）。
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

/** 手写题的笔迹缩略图（学生本人 PNG 直出；无笔迹整块隐藏） */
function InkThumbnail({
  attemptId,
  questionId,
}: {
  attemptId: string;
  questionId: string;
}) {
  const [available, setAvailable] = useState(true);
  if (!available) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <PenLine aria-hidden className="size-4" />
        我的手写笔迹
      </p>
      <img
        src={studentInkPngUrl(attemptId, questionId)}
        alt={`第 ${questionId} 题的手写笔迹`}
        loading="lazy"
        className="w-full rounded-lg border border-border bg-white"
        onError={() => setAvailable(false)}
      />
    </div>
  );
}

/** 单题结果卡；released=false（T2A.8 截止后公布且未到截止）时只渲染本人作答内容 */
function ResultQuestionCard({
  index,
  question,
  attemptId,
  released,
}: {
  index: number;
  question: AttemptResultQuestion;
  attemptId: string;
  released: boolean;
}) {
  const isHandwritten =
    question.snapshot.type === "solve" ||
    question.snapshot.type === "apply" ||
    question.snapshot.type === "find-error";
  return (
    <article
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 text-card-foreground sm:p-5"
      aria-label={`第 ${index + 1} 题`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* T2A.8：未公布时不显示对错判定（autoCorrect 已置 null，避免误读为待批） */}
        {released && (
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            <VerdictIcon autoCorrect={question.autoCorrect} />
            {verdictLabel(question.autoCorrect)}
          </span>
        )}
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

      {/* 题干快照（released=false 时为公开化题干，服务端已替换 [[答案]] 标记） */}
      <RichMarkdown source={question.snapshot.stemMd} className="text-base" />
      <ResultOptions question={question} />

      {/* 手写题：我的手写笔迹缩略图（T2.8；无笔迹时隐藏） */}
      {isHandwritten && (
        <InkThumbnail attemptId={attemptId} questionId={question.questionId} />
      )}

      {/* 做题时看过的提示（T2.11 回看；没解锁过则整块隐藏。
          未公布时照常回看——只含学生自己请求过的条目，不构成泄露） */}
      {question.hintsOpened.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Lightbulb aria-hidden className="size-4" />
            做题时看过的提示（{question.hintsOpened.length} 条）
          </p>
          <HintEntryList entries={question.hintsOpened} />
        </div>
      )}

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
        {/* 参考答案走 RichMarkdown（T2.13 规范约定：填空答案需公式展示时写 $…$，
            判分归一化自动剥 $；此处按同一管线渲染，无 $ 的普通答案原样显示）。
            外层 p→div：RichMarkdown 是块级 div，不能嵌在 <p> 内。
            T2A.8：未公布时整块不下发（服务端 answers=null） */}
        {released && (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            <span className="shrink-0 text-muted-foreground">参考答案：</span>
            {question.answers === null ? (
              <span className="font-medium">由老师批改后公布</span>
            ) : (
              <RichMarkdown
                source={formatReferenceAnswers(question.answers)}
                className="min-w-0 font-medium [&_p]:my-0"
              />
            )}
          </div>
        )}
      </div>

      {/* T2A.8：详解只在公布后渲染（未公布时服务端 solutionMd=null） */}
      {released && <SolutionFold solutionMd={question.solutionMd} />}
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
  // T2A.8：答案是否已公布（on_submit / 课程练习 / 已到截止 = true）
  const released = data.answersReleased;
  // T2A.7：逐题结果按单元分组；题号全卷连续（累计 index）。
  // 多单元时渲染节标题（单元标题），单单元不显示节头（与答题视图一致）。
  const flatQuestions = data.units.flatMap((unit) => unit.questions);
  const showUnitHeaders = data.units.length > 1;
  return (
    <div className="flex flex-col gap-5">
      {/* 得分汇总卡（未公布时替换为「已交卷」横幅 + 已答统计，不显示对错与得分） */}
      <section
        aria-labelledby="result-summary"
        className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
      >
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 id="result-summary" className="text-base font-semibold">
            {data.title} · {released ? "批改结果" : "已交卷"}
          </h2>
          {/* 来源行（T2A.6，与答题视图同口径）：课程练习带次数（历次回看可分辨
              第几次）；作业标「作业」（挂课程时「作业 · 课程名」，T2A.7） */}
          <p className="text-xs text-muted-foreground">
            {attempt.sourceType === "course"
              ? `课程：${data.courseName ?? ""} · 第 ${attempt.attemptNo} 次`
              : data.courseName !== null
                ? `作业 · ${data.courseName}`
                : "作业"}
          </p>
          {attempt.submittedAt !== null && (
            <p className="text-xs text-muted-foreground">
              交卷时间：{formatCnTime(attempt.submittedAt)}
            </p>
          )}
        </div>
        {released ? (
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
                {summary.unanswered > 0 &&
                  `（含未答 ${summary.unanswered} 题）`}
              </span>
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
            <p className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-300">
              <Clock aria-hidden className="size-4 shrink-0" />
              已交卷，答案将在截止后公布
              {data.dueAt !== null &&
                `（截止时间：${formatCnTime(data.dueAt)}）`}
            </p>
            <p className="text-amber-800 dark:text-amber-300">
              截止前只显示你的作答内容；截止后将自动公布对错、参考答案与详解
              （已作答 {summary.answered} 题 / 共 {summary.total} 题）。
            </p>
          </div>
        )}
        <Button
          variant="outline"
          className="min-h-11 w-fit"
          onClick={onBackHome}
        >
          返回首页
        </Button>
      </section>

      {/* 逐题结果（T2A.7：多单元按节分组，题号全卷连续） */}
      <ol className="flex flex-col gap-4">
        {data.units.map((unit) => (
          <li key={unit.id} className="flex flex-col gap-4">
            {showUnitHeaders && (
              <h3 className="border-b border-border pb-1.5 text-sm font-semibold text-muted-foreground">
                {unit.title}
              </h3>
            )}
            <ol className="flex flex-col gap-4">
              {unit.questions.map((question) => (
                <li key={question.questionId}>
                  <ResultQuestionCard
                    index={flatQuestions.indexOf(question)}
                    question={question}
                    attemptId={attempt.id}
                    released={released}
                  />
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </div>
  );
}
