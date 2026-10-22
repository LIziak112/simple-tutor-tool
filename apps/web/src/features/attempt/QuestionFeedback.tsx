import type { PracticeQuestionFeedback } from "@tutor/contract";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import {
  ResultOptions,
  VerdictBadge,
} from "@/features/attempt/AttemptResultView";
import { ResultAnswerComparison } from "./ResultAnswerComparison";
import {
  PENDING_ATTEMPT_FEEDBACK_COPY,
  practiceFeedbackRestrictedCopy,
} from "./practice-protocol";

/**
 * 题级反馈区（M3-D2，§10.4 授权投影四态呈现）：提交回执/题级反馈读取共用
 * 同一 schema（practiceQuestionFeedbackSchema），本组件是其唯一呈现出口：
 * - released：简短结论（VerdictBadge 复用，finalCorrect 优先）+ 本人答案与
 *   参考答案对照（ResultAnswerComparison / ResultOptions，与整卷结果视图
 *   同构同源）+ 解析默认展开（教师演示口径；null 明确「本题暂无解析」，
 *   不造空白折叠卡）；
 * - pending_attempt：已提交、交卷后统一公布（零题目内容）；
 * - restricted：按 restrictionReason 文案（practice-protocol 单源）；
 * - not_submitted：不渲染反馈区（调用方也不应在未提交行挂本组件）。
 * 服务端按读取时刻裁决状态；本组件只呈现投影，不本地推断授权。
 */
export function QuestionFeedback({
  feedback,
}: {
  feedback: PracticeQuestionFeedback;
}) {
  if (feedback.status === "not_submitted") return null;
  if (feedback.status === "pending_attempt" || feedback.status === "restricted") {
    const copy =
      feedback.status === "pending_attempt"
        ? PENDING_ATTEMPT_FEEDBACK_COPY
        : practiceFeedbackRestrictedCopy(feedback.restrictionReason);
    return (
      <section
        data-slot="practice-question-feedback"
        aria-label="本题反馈"
        className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
      >
        {copy}
      </section>
    );
  }
  const question = feedback.question;
  return (
    <section
      data-slot="practice-question-feedback"
      aria-label="本题反馈"
      className="flex flex-col gap-3 border-t border-border pt-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <VerdictBadge
          verdict={question.finalCorrect}
          pendingLabel="已提交，待老师批改"
          toned
          correctLabel="回答正确"
          wrongLabel="回答有误"
        />
        <span className="text-xs text-muted-foreground">
          反馈按老师当前设置公布，如与讲解不一致以老师为准。
        </span>
      </div>
      <ResultOptions question={question} released />
      <ResultAnswerComparison question={question} released />
      {question.solutionMd !== null ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">解析</p>
          <div className="border-s-2 border-border ps-3">
            <RichMarkdown source={question.solutionMd} className="text-sm leading-6" />
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">本题暂无解析</p>
      )}
    </section>
  );
}
