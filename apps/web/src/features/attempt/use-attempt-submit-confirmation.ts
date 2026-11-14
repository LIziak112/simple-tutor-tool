import type {
  AttemptDraftData,
  PracticeQuestionProgress,
} from "@tutor/contract";
import { useCallback, useMemo } from "react";
import type { useAttemptEditor } from "@/features/answering/AttemptEditorContext";
import type { practiceProtocolOfDraft } from "./practice-protocol";
import { useAttemptSubmitFlow } from "./use-attempt-submit-flow";
import { useSubmitEvidenceConfirm } from "./use-submit-evidence-confirm";

type ConfirmationInput = Omit<
  Parameters<typeof useAttemptSubmitFlow>[0],
  "revisions" | "questionIds"
> & {
  data: AttemptDraftData;
  questions: AttemptDraftData["units"][number]["questions"];
  questionIds: string[];
  practiceProtocol: ReturnType<typeof practiceProtocolOfDraft>;
  progress: readonly PracticeQuestionProgress[];
  editor: ReturnType<typeof useAttemptEditor>;
};

/** 整卷确认拥有证据范围、版本基线与取消/重新打开状态。 */
export function useAttemptSubmitConfirmation({
  data,
  questions,
  questionIds,
  practiceProtocol,
  progress,
  editor,
  attemptId,
  savedOnly,
  recoveryReady,
  syncDraft,
  flushAnswers,
  inkControllers,
  events,
  onAnnotationSealFailed,
}: ConfirmationInput) {
  // 交卷结束整卷，但仅为尚未提交题固定本次证据；已提交题沿用单题封存。
  // 使用提交回执合并后的进度，避免本页刚提交的题仍进入整卷证据声明。
  const submitEvidenceQuestionIds = useMemo(() => {
    if (practiceProtocol !== "v1") return questionIds;
    const submitted = new Set(
      progress
        .filter((row) => row.submittedAt !== null)
        .map((row) => row.questionId),
    );
    return questionIds.filter((id) => !submitted.has(id));
  }, [practiceProtocol, progress, questionIds]);
  // 冻结题与当前草稿视图的版本基线，提交前叠加本机已收到的保存回执。
  const submitRevisions = useMemo(
    () =>
      questions.map((question) => ({
        questionId: question.id,
        questionRevisionId: question.questionRevisionId,
        expectedAnswerRevision: data.draftRevisions?.[question.id] ?? 0,
      })),
    [data.draftRevisions, questions],
  );

  const { inkFlushError, runSubmit, submit, submitAbortedRef, submitError } =
    useAttemptSubmitFlow({
      attemptId,
      savedOnly,
      recoveryReady,
      syncDraft,
      flushAnswers,
      inkControllers,
      questionIds: submitEvidenceQuestionIds,
      revisions: submitRevisions,
      events,
      onAnnotationSealFailed,
    });

  const {
    confirmOpen,
    phase: notePrep,
    noteSummary,
    open: openConfirmDialog,
    cancel: cancelConfirmDialog,
    confirm: confirmSubmit,
    confirmMissing: confirmMissingSubmit,
  } = useSubmitEvidenceConfirm({
    attemptId,
    questionIds: submitEvidenceQuestionIds,
    run: runSubmit,
  });

  /**
   * 打开交卷弹层：先收起题卡编辑器（未保存确认），再交给共享状态机重置
   * 并取草稿本地快览（无网络，纯内存态——确认时以 prepareSubmitEvidence
   * 的权威判定为准）。
   */
  const openSubmitDialog = useCallback(async () => {
    if (editor && !(await editor.request(null))) return;
    // 复位上一轮取消置位的中止标志（原实现同语义：新一轮确认链不被旧 abort 拦下）
    submitAbortedRef.current = false;
    openConfirmDialog();
  }, [editor, openConfirmDialog, submitAbortedRef]);

  /**
   * 关闭交卷弹层 = 取消 = 中止准备链：置 abort 标志（runSubmit 各
   * await 段后检查）并复位准备阶段。busy 期间 Radix 关闭路径已被弹层
   * 封堵（Esc/遮罩/×），此处是唯一的正常关闭入口（继续作答按钮）与
   * 防御纵深（未来新增的关闭路径同样被 abort 拦下）。
   */
  const closeSubmitDialog = useCallback(() => {
    submitAbortedRef.current = true;
    cancelConfirmDialog();
  }, [cancelConfirmDialog, submitAbortedRef]);

  return {
    inkFlushError,
    submit,
    submitError,
    confirmOpen,
    notePrep,
    noteSummary,
    confirmSubmit,
    confirmMissingSubmit,
    openSubmitDialog,
    closeSubmitDialog,
  };
}
