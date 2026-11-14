import type {
  PracticeQuestionProgress,
  PracticeWorkflow,
  StudentAnswer,
} from "@tutor/contract";
import { type RefObject, useCallback, useEffect, useState } from "react";
import type { QuestionProcessRecorder } from "@/features/question-process/recorder";
import {
  readAutoSubmitChoice,
  saveAutoSubmitChoice,
} from "./choice-submit-mode";
import type { PracticeProblemPhase } from "./PracticeQuestionSubmit";
import type { usePracticeQuestionSubmit } from "./use-practice-question-submit";

/** 页面逐题提交协调：缺稿裁决与点选串行队列，不重写底层提交协议。 */
export function useAttemptPracticeSubmission({
  attemptId,
  practiceSubmit,
  timeUp,
  processRecorderRef,
  setAnswer,
  practiceWorkflow,
  online,
  denied,
  confirmOpen,
  feedbackBusy,
  progressById,
}: {
  attemptId: string;
  practiceSubmit: ReturnType<typeof usePracticeQuestionSubmit>;
  timeUp: boolean;
  processRecorderRef: RefObject<QuestionProcessRecorder | null>;
  setAnswer: (id: string, answer: StudentAnswer, defer?: boolean) => void;
  practiceWorkflow: PracticeWorkflow | undefined;
  online: boolean;
  denied: boolean;
  confirmOpen: boolean;
  feedbackBusy: boolean;
  progressById: ReadonlyMap<string, PracticeQuestionProgress>;
}) {
  const [autoSubmitChoice, setAutoSubmitChoice] = useState(() =>
    readAutoSubmitChoice(attemptId),
  );
  const canAutoSubmitChoice =
    autoSubmitChoice && practiceWorkflow?.canSubmitQuestion === true;
  // 缺稿明确选择弹层（§10.3）：证据组装发现未追平草稿时不静默放行——
  // choice（用户裁决）→ busy（确认后带 allowMissing 重提）→ error（重提失败留弹层）；
  // 其余 outcome（提交成功/受限/stale/取消）一律收起弹层（就地提示由 hook 承担）
  const [practiceProblem, setPracticeProblem] = useState<{
    questionId: string;
    phase: PracticeProblemPhase;
  } | null>(null);
  const runPracticeSubmit = useCallback(
    async (
      questionId: string,
      opts?: { allowMissing?: boolean },
    ): Promise<void> => {
      if (timeUp) return;
      const outcome = await practiceSubmit.submit(questionId, opts);
      if (
        outcome.kind === "submitted" &&
        processRecorderRef.current?.options.attemptId === attemptId
      )
        processRecorderRef.current.event(questionId, {
          kind: "activity",
          action: "submit",
          scope: "question",
        });
      if (outcome.kind === "problems") {
        setPracticeProblem({
          questionId,
          phase: {
            kind: "choice",
            reason: outcome.problems[0]?.reason ?? "草稿尚未保存完整",
          },
        });
        return;
      }
      if (outcome.kind === "error") {
        // 弹层进行中（缺稿重提失败）→ 错误相留在弹层；否则 hook 已就地提示
        setPracticeProblem((prev) =>
          prev !== null
            ? {
                questionId,
                phase: { kind: "error", message: outcome.message },
              }
            : null,
        );
        return;
      }
      setPracticeProblem(null);
    },
    [practiceSubmit.submit, attemptId, timeUp, processRecorderRef],
  );
  const { getSubmittingId } = practiceSubmit;
  const [queuedChoices, setQueuedChoices] = useState<string[]>([]);
  const onAutoChoiceAnswer = useCallback(
    (questionId: string, answer: StudentAnswer, defer?: boolean) => {
      const submittingId = getSubmittingId();
      // 已出站的本题答案不再修改。其他题的点选照常保存，并等待提交。
      if (submittingId === questionId) return;
      setAnswer(questionId, answer, defer);
      if (submittingId === null && queuedChoices.length === 0) {
        void runPracticeSubmit(questionId);
      } else {
        setQueuedChoices((queued) =>
          queued.includes(questionId) ? queued : [...queued, questionId],
        );
      }
    },
    [getSubmittingId, queuedChoices.length, runPracticeSubmit, setAnswer],
  );
  const nextQueuedChoice = queuedChoices[0];
  const queuedChoiceSubmitted =
    nextQueuedChoice !== undefined &&
    (progressById.get(nextQueuedChoice)?.submittedAt ?? null) !== null;
  const canDrainChoices =
    canAutoSubmitChoice && !denied && !practiceSubmit.finished && !timeUp;
  const choiceQueuePaused =
    !online ||
    confirmOpen ||
    practiceProblem !== null ||
    practiceSubmit.lastError !== null ||
    practiceSubmit.submittingId !== null ||
    feedbackBusy;

  useEffect(() => {
    if (nextQueuedChoice === undefined) return;
    if (!canDrainChoices) {
      setQueuedChoices([]);
      return;
    }
    if (choiceQueuePaused || getSubmittingId() !== null) return;
    setQueuedChoices((queued) => queued.slice(1));
    if (!queuedChoiceSubmitted) void runPracticeSubmit(nextQueuedChoice);
  }, [
    canDrainChoices,
    choiceQueuePaused,
    getSubmittingId,
    nextQueuedChoice,
    queuedChoiceSubmitted,
    runPracticeSubmit,
  ]);

  const updateAutoSubmitChoice = useCallback(
    (auto: boolean) => {
      setAutoSubmitChoice(auto);
      saveAutoSubmitChoice(attemptId, auto);
    },
    [attemptId],
  );

  return {
    autoSubmitChoice,
    setAutoSubmitChoice: updateAutoSubmitChoice,
    canAutoSubmitChoice,
    practiceProblem,
    setPracticeProblem,
    runPracticeSubmit,
    onAutoChoiceAnswer,
    queuedChoices,
  };
}
