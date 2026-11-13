import type { AttemptResultQuestion } from "@tutor/contract";
import { AiBatchReviewEntry } from "@/features/student-ai/AiBatchReviewPanel";
import { useAiCompanionDock } from "@/features/student-ai/AiCompanionDock";
import { AiQueueButton } from "@/features/student-ai/AiQueueButton";
import { HANDWRITTEN_TYPES } from "./answer-format";
import { verdictBadgeDisplayOf } from "./self-review-display";

/**
 * 结果页的逐题 AI 接线：伴学栏（「AI 复盘」绑定回看当前题）与顶栏的逐题
 * 入口组（「批量复盘」「求助记录」）。题号口径只此一处：题号 = 全卷展示序
 * 下标 + 1（与答题卡一致）。
 *
 * 整卷复盘不在这里——它是顶栏主按钮（AttemptReviewTopBarEntry），两类入口
 * 分开摆放，避免把「按整卷出一份报告」和「按题逐条求助」混成一件事。
 */

/**
 * SAI-22 结果页 AI 复盘：完成后按 §7.5 入口变「AI 复盘」，绑定回看当前题；
 * 复盘态不采集材料（结果页无作答会话——纯文字求助，题面与答案解析由服务端
 * 快照携带）。
 */
export function useResultAiCompanion({
  attemptId,
  title,
  questions,
  currentQuestionId,
}: {
  attemptId: string;
  title: string;
  questions: readonly AttemptResultQuestion[];
  currentQuestionId: string | null;
}) {
  const numberOf = (questionId: string): number | null => {
    const index = questions.findIndex(
      (question) => question.questionId === questionId,
    );
    return index < 0 ? null : index + 1;
  };
  return useAiCompanionDock({
    attemptId,
    questions: questions.map((question) => ({ id: question.questionId })),
    isHandwritten: (questionId) => {
      const question = questions.find((item) => item.questionId === questionId);
      return question !== undefined
        ? HANDWRITTEN_TYPES.has(question.snapshot.type)
        : false;
    },
    surfaceOf: () => null,
    flush: () => Promise.resolve(),
    titleOf: (questionId) => `第 ${numberOf(questionId) ?? "？"} 题 · ${title}`,
    labelOf: (questionId) => {
      const number = numberOf(questionId);
      return number === null ? null : `第 ${number} 题`;
    },
    currentQuestionId,
    editor: null,
    materials: { annotation: false, paper: false },
    triggerLabel: "AI 复盘",
  });
}

export function ResultAiActions({
  attemptId,
  questions,
  released,
  companion,
  onOpenAttemptReview,
}: {
  attemptId: string;
  questions: readonly AttemptResultQuestion[];
  released: boolean;
  companion: ReturnType<typeof useResultAiCompanion>;
  onOpenAttemptReview: (target: string) => void;
}) {
  return (
    <>
      {/* SAI-31 批量复盘入口：勾选只进面板，创建走一次确认（B16） */}
      <AiBatchReviewEntry
        attemptId={attemptId}
        questions={questions.map((question, index) => ({
          questionId: question.questionId,
          label: `第 ${index + 1} 题`,
          // QM-12：喂有效判定（教师判 > 自评 > 自动，verdictBadgeDisplayOf
          // 同口径）——自评「错」进错题组（与服务端批量过滤同口径）；
          // 未公布时服务端已置 null，这里再按 released 收口（双保险）
          finalCorrect: released
            ? verdictBadgeDisplayOf(question).verdict
            : null,
        }))}
        released={released}
      />
      <AiQueueButton
        currentAttemptId={companion.send.attemptId}
        onOpenTask={companion.openTask}
        onOpenQuestion={companion.openQuestion}
        onOpenAttemptReview={onOpenAttemptReview}
      />
    </>
  );
}
