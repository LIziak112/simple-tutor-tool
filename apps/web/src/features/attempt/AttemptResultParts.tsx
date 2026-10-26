import type { AttemptResultQuestion } from "@tutor/contract";
import { cn } from "cn";
import { CheckCircle2, Clock, XCircle } from "lucide-react";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { letterOf } from "./answer-format";

/**
 * 结果呈现的轻量共用件（从 AttemptResultView 拆出，M3-D2）：逐题反馈区
 * （QuestionFeedback）挂在**草稿视图**的题卡上，而结果视图（AttemptResultView）
 * 是交卷后才懒加载的重模块（订正/笔记/AI 复盘都在里面）——草稿渲染若静态
 * 引用结果模块会把「草稿入口不提前加载结果回看模块」的纪律（T6R.15 F）
 * 打破。本模块只含无副作用的纯呈现件，允许被作答页安全静态引用；
 * AttemptResultView 对外再导出同名件，既有调用方（讲练页题卡等）不受影响。
 */

/**
 * 判定徽章组合（图标 + 文案 + 配色单一出处）：true=绿勾、false=红叉、
 * null=琥珀时钟待批。文案/配色可经 props 覆盖（讲练页题卡、逐题反馈、
 * 结果视图三处共用，单一出处）。
 */
export function VerdictBadge({
  verdict,
  pendingLabel = "待批改",
  toned = false,
  correctLabel = "答对",
  wrongLabel = "答错",
  notDone = false,
}: {
  verdict: boolean | null;
  /** 待批（null）文案覆盖——讲练页用「待老师批改」 */
  pendingLabel?: string;
  /** 文字是否套判定配色（讲练页题卡带色；结果视图沿用默认前景色） */
  toned?: boolean;
  /** 判对（true）文案覆盖——逐题反馈用「回答正确」（M3-D2；缺省不变） */
  correctLabel?: string;
  /** 判错（false）文案覆盖——逐题反馈用「回答有误」（M3-D2；缺省不变） */
  wrongLabel?: string;
  /**
   * #6980-3 未做灰显：verdict=false 且无实际作答（AttemptResultQuestion
   * answered=false）时传 true——灰「未做」替代红「答错」。
   */
  notDone?: boolean;
}) {
  // #6980-3：判错 + 未做 → 灰「未做」（有实际作答的判错才红）
  const notDoneActive = notDone && verdict === false;
  const label = notDoneActive
    ? "未做"
    : verdict === true
      ? correctLabel
      : verdict === false
        ? wrongLabel
        : pendingLabel;
  const icon =
    verdict === true ? (
      <CheckCircle2
        aria-label={correctLabel}
        className="size-5 shrink-0 text-emerald-600"
      />
    ) : verdict === false ? (
      <XCircle
        aria-label={notDoneActive ? "未做" : wrongLabel}
        className={cn(
          "size-5 shrink-0",
          notDoneActive ? "text-muted-foreground" : "text-red-600",
        )}
      />
    ) : (
      <Clock
        aria-label={pendingLabel}
        className="size-5 shrink-0 text-amber-500"
      />
    );
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-sm font-semibold",
        toned && verdict === true && "text-emerald-700 dark:text-emerald-300",
        toned &&
          verdict === false &&
          (notDoneActive
            ? "text-muted-foreground"
            : "text-red-600 dark:text-red-400"),
        toned && verdict === null && "text-amber-700 dark:text-amber-300",
      )}
    >
      {icon}
      {label}
    </span>
  );
}

/** 选项行（含正确项与学生所选标记；仅 choice/multi）。讲练页题卡结果态、
 *  逐题反馈与结果视图共用（单一出处）。 */
export function ResultOptions({
  question,
  released,
}: {
  question: AttemptResultQuestion;
  released: boolean;
}) {
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
        const isCorrect = released && correct.includes(index);
        return (
          <li
            key={option}
            className={cn(
              "flex min-h-11 flex-wrap items-start gap-2 rounded-lg border px-3 py-2 text-sm",
              isCorrect
                ? "border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10"
                : isPicked && released
                  ? "border-red-300 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10"
                  : isPicked
                    ? "border-primary bg-primary/5"
                    : "border-transparent",
            )}
          >
            <span className="mt-0.5 w-5 shrink-0 font-semibold">
              {letterOf(index)}
            </span>
            <RichMarkdown
              source={option}
              className="min-w-0 flex-1 text-base [&_p]:my-0"
            />
            {isCorrect && (
              <span className="shrink-0 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                {isPicked ? "正确项 · 你的选择" : "正确项"}
              </span>
            )}
            {isPicked && !isCorrect && (
              <span
                className={cn(
                  "shrink-0 text-xs font-medium",
                  released
                    ? "text-red-700 dark:text-red-300"
                    : "text-foreground",
                )}
              >
                你的选择
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
