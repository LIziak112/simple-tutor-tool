import type { AttemptResultQuestion, QuestionActivity } from "@tutor/contract";
import { displayStemMd } from "@tutor/md-dsl";
import { cn } from "cn";
import { CheckCircle2, Lightbulb, PenLine } from "lucide-react";
import { type ReactNode, useContext, useState } from "react";
import { AnnotationView } from "@/features/annotation/AnnotationView";
import { optionCorrectOf } from "@/features/answering/views/choice";
import { HintEntryList } from "@/features/attempt/HintPanel";
import { ReviewPackPanel } from "@/features/export/review-pack-panel";
import { LearningHostContext } from "@/features/learning-context/learning-context-store";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { CorrectionSection } from "@/features/notes/CorrectionSection";
import { DraftRecoverySection } from "@/features/notes/DraftRecoverySection";
import { NoteOriginalView } from "@/features/notes/NoteOriginalView";
import { QuestionHistoryLink } from "@/features/notes/QuestionHistoryLink";
import { studentInkPngUrl } from "@/lib/api";
import { ResultOptions, VerdictBadge } from "./AttemptResultParts";
import {
  HANDWRITTEN_TYPES,
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "./answer-format";
import { QuestionActivityBadge } from "./QuestionActivity";

// 轻量呈现件拆至 AttemptResultParts（草稿视图的逐题反馈静态引用它们，不得
// 把本重模块拖进作答页）；此处对外再导出，既有调用方不受影响。

import { QuestionMemoAction } from "@/features/memos/QuestionMemoCapture";
import { ResultAnswerComparison } from "./ResultAnswerComparison";
import { ResultQuestionTools } from "./ResultQuestionTools";
import { SolutionFold } from "./ResultSolutionFold";
import { RubricReviewSection } from "./RubricReviewSection";
import { reviewQuestionState } from "./result-review-model";
import { SelfReviewSection } from "./SelfReviewSection";
import { verdictBadgeDisplayOf } from "./self-review-display";
export function TeacherMarkBlock({
  teacherMark,
  teacherComment,
}: {
  teacherMark: "correct" | "wrong" | null;
  teacherComment: string | null;
}) {
  return (
    <div className="flex flex-col gap-1 border-l-2 border-sky-500 pl-3">
      <p className="flex items-center gap-1.5 text-sm font-medium text-sky-800 dark:text-sky-300">
        <PenLine aria-hidden className="size-4 shrink-0" />
        老师批改：
        {teacherMark === "correct"
          ? "判对"
          : teacherMark === "wrong"
            ? "判错"
            : "已评语"}
      </p>
      {teacherComment !== null && (
        <p className="break-words text-sm text-foreground [overflow-wrap:anywhere]">
          {teacherComment}
        </p>
      )}
    </div>
  );
}

function HandwrittenInkPanel({
  attemptId,
  questionId,
  ariaPrefix,
}: {
  attemptId: string;
  questionId: string;
  ariaPrefix: string;
}) {
  const [available, setAvailable] = useState(true);
  return (
    <div className="flex w-full min-w-0 flex-col gap-2 rounded-lg border border-border bg-card px-3 py-3">
      <p className="text-sm font-medium">手写原稿</p>
      {available ? (
        <img
          src={studentInkPngUrl(attemptId, questionId)}
          alt={`${ariaPrefix}的手写笔迹`}
          loading="lazy"
          className="w-full rounded-lg border border-border bg-white"
          onError={() => setAvailable(false)}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          本次作答没有可查看的手写原稿。
        </p>
      )}
    </div>
  );
}

export function ResultQuestionCard({
  aiTrigger,
  index,
  question,
  attemptId,
  released,
  roundLabel,
  activity,
  onSolutionToggle,
  completedTools = true,
}: {
  /** 订正与补充稿依赖整卷完成；批次结果只提供已公布题目的自评。 */
  completedTools?: boolean;
  aiTrigger?: ReactNode;
  index: number;
  question: AttemptResultQuestion;
  attemptId: string;
  released: boolean;
  /** 轮次标注（T6R.11 原稿查看面板显示所属轮次） */
  roundLabel: string;
  /** 题内活动用时（卷有事件时传 byQuestion 条目，可缺；卷无事件传 null 不渲染） */
  activity: QuestionActivity | undefined | null;
  /** 详解折叠开合回调（T4.0b host=result 复盘埋点；缺省不报）；open=收起→展开 */
  onSolutionToggle?:
    | ((questionId: string, index: number, action: "open" | "close") => void)
    | undefined;
}) {
  const learningLease = useContext(LearningHostContext);
  const isHandwritten = HANDWRITTEN_TYPES.has(question.snapshot.type);
  // verdict（公布后对错）与 unanswered（未公布态徽标/边框）同源复算一次
  const reviewState = reviewQuestionState(question, released);
  // D9 最终判定优先，null = 真待批；QM-11 reference_self 行按自评三态显示
  // （verdictBadgeDisplayOf 单一出处）；徽章与左边框共用其 verdict
  const badge = verdictBadgeDisplayOf(question);
  const verdict = released ? badge.verdict : reviewState.verdict;
  const renderTools = (
    explanationTrigger?: ReactNode,
    explanationContent?: ReactNode,
  ) => (
    <ResultQuestionTools
      questionNo={index + 1}
      explanationTrigger={explanationTrigger}
      explanationContent={explanationContent}
      history={
        <QuestionHistoryLink
          questionId={question.questionId}
          ariaPrefix={`第 ${index + 1} 题`}
        />
      }
      draft={
        <>
          {isHandwritten ? (
            <HandwrittenInkPanel
              attemptId={attemptId}
              questionId={question.questionId}
              ariaPrefix={`第 ${index + 1} 题`}
            />
          ) : (
            <NoteOriginalView
              compact
              defaultOpen
              viewer="student"
              attemptId={attemptId}
              questionId={question.questionId}
              ariaPrefix={`第 ${index + 1} 题`}
              roundLabel={roundLabel}
            />
          )}
          {/* 题干标注回看 + 合成图导出（底图＋圈）；入口随组按需挂载，compact 关闭态零请求 */}
          <AnnotationView
            compact
            question={question.publicQuestion}
            answer={question.answer ?? undefined}
            viewer="student"
            attemptId={attemptId}
            questionId={question.questionId}
            questionNo={index + 1}
            ariaPrefix={`第 ${index + 1} 题`}
          />
          {/* D8 找回草稿/补充稿同步状态：草稿材料语义，随草稿组挂载 */}
          {completedTools && (
            <DraftRecoverySection
              attemptId={attemptId}
              questionId={question.questionId}
            />
          )}
        </>
      }
      correction={
        completedTools ? (
          <CorrectionSection
            attemptId={attemptId}
            questionId={question.questionId}
            questionNo={index + 1}
            ariaPrefix={`第 ${index + 1} 题`}
            roundLabel={roundLabel}
            question={question}
          />
        ) : (
          <span className="text-xs text-muted-foreground">
            整卷完成后可订正、补充草稿
          </span>
        )
      }
      more={
        <>
          <QuestionMemoAction
            standalone
            attemptId={attemptId}
            questionId={question.questionId}
            surface="result"
            questionRevisionId={question.questionRevisionId}
          />
          <ReviewPackPanel
            compact
            viewer="student"
            attemptId={attemptId}
            questionId={question.questionId}
            questionNo={index + 1}
          />
        </>
      }
    />
  );
  return (
    <article
      data-question-id={question.questionId}
      data-learning-attempt={attemptId}
      data-learning-view={learningLease?.viewId}
      data-learning-surface="result"
      data-learning-revision={question.questionRevisionId}
      className={cn(
        "relative flex scroll-mt-[calc(var(--attempt-header-height,96px)+16px)] flex-col gap-4 overflow-hidden rounded-lg border border-border bg-card p-4 pl-5 text-card-foreground sm:p-5 sm:pl-6 isolate",
        "before:absolute before:inset-y-0 before:left-0 before:w-1.5",
        !released
          ? reviewState.unanswered
            ? "before:bg-muted"
            : "before:bg-sky-400"
          : verdict === true
            ? "before:bg-emerald-500"
            : verdict === false
              ? question.answered
                ? "before:bg-red-500"
                : "before:bg-muted" // #6980-3：未做灰，不套判错红
              : "before:bg-amber-400",
      )}
      aria-label={`第 ${index + 1} 题`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* T2A.8 未公布时不显示对错判定；「标过不会」是做题时的事实标注（#6980-4），
            不受公布 gate 与自评分支影响 */}
        {released ? (
          <VerdictBadge
            verdict={badge.verdict}
            notDone={badge.notDone ?? false}
            {...(badge.pendingLabel !== undefined && {
              pendingLabel: badge.pendingLabel,
            })}
            {...(badge.correctLabel !== undefined && {
              correctLabel: badge.correctLabel,
            })}
            {...(badge.wrongLabel !== undefined && {
              wrongLabel: badge.wrongLabel,
            })}
          />
        ) : reviewState.unanswered ? (
          <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            未作答
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-sm font-semibold text-sky-700 dark:text-sky-300">
            <CheckCircle2
              aria-hidden
              className="size-4 shrink-0 text-sky-500"
            />
            答案已保存 · 待公布
          </span>
        )}
        {question.studentFlag === "unsure" && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            标过不会
          </span>
        )}
        <h3
          data-review-heading
          tabIndex={-1}
          className="text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          第 {index + 1} 题
        </h3>
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
        {activity !== null && <QuestionActivityBadge activity={activity} />}
        <div className="ml-auto">{aiTrigger}</div>
      </div>

      {/* 题干快照（服务端已 studentStemMd 投影；displayStemMd 兜底剥内嵌选项列表） */}
      <AnnotationView
        question={question.publicQuestion}
        answer={question.answer ?? undefined}
        correctOptionIndexes={
          released ? optionCorrectOf(question.answers) : undefined
        }
        viewer="student"
        attemptId={attemptId}
        questionId={question.questionId}
        questionNo={index + 1}
        ariaPrefix={`第 ${index + 1} 题`}
      >
        <RichMarkdown
          source={displayStemMd(question.snapshot)}
          className="text-base"
        />
        <ResultOptions question={question} released={released} />
      </AnnotationView>

      <ResultAnswerComparison question={question} released={released} />

      {/* QM-11：对照后挂自评动作（reference_self 行；教师已判时整块不渲染，
          判定显示走下方批改块——教师优先） */}
      {released && (
        <SelfReviewSection attemptId={attemptId} question={question} />
      )}
      {/* 模块 3：量表评价（题有 :::rubric 且已公布；量表分不进总分） */}
      {released && (
        <RubricReviewSection attemptId={attemptId} question={question} />
      )}

      {released &&
        (question.teacherMark !== null || question.teacherComment !== null) && (
          <TeacherMarkBlock
            teacherMark={question.teacherMark}
            teacherComment={question.teacherComment}
          />
        )}

      {/* 只回看本人已解锁的提示，公布前不增加任何答案材料。 */}
      {question.hintsOpened.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Lightbulb aria-hidden className="size-4" />
            做题时看过的提示（{question.hintsOpened.length} 条）
          </p>
          <HintEntryList entries={question.hintsOpened} />
        </div>
      )}

      <SolutionFold
        enabled={released}
        solutionMd={question.solutionMd}
        onToggle={
          onSolutionToggle === undefined
            ? undefined
            : (action) => onSolutionToggle(question.questionId, index, action)
        }
        renderLayout={renderTools}
      />
    </article>
  );
}
