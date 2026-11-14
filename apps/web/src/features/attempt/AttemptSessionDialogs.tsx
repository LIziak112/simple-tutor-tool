import type { AttemptDraftData } from "@tutor/contract";
import { LiveAttemptAnswerCard } from "./AttemptAnswerCard";
import { AttemptNavigationDialog } from "./AttemptNavigationDialog";
import { PracticeSubmitProblemDialog } from "./PracticeQuestionSubmit";
import type { QuestionNavigationItem } from "./QuestionNavigator";
import { completionLabel } from "./question-completion";
import { SubmitConfirmDialog } from "./SubmitConfirmDialog";
import type { useAttemptPracticeSubmission } from "./use-attempt-practice-submission";
import type { useAttemptQuestionLocation } from "./use-attempt-question-location";
import type { useAttemptQuestionNavigation } from "./use-attempt-question-navigation";
import type { useAttemptSubmitConfirmation } from "./use-attempt-submit-confirmation";
import type { usePracticeQuestionSubmit } from "./use-practice-question-submit";
import { evidenceProblemViewsOf } from "./use-submit-evidence-confirm";

/** 答题卡保持独立弹层与关闭落焦，不接管题卡挂载。 */
export function AttemptSessionNavigator({
  attemptId,
  questionIds,
  location,
  navigation,
  practiceSubmit,
  currentQuestionId,
  navigationItems,
  navigatorMaterialsReady,
  answered,
  total,
  submittedPracticeCount,
}: {
  attemptId: string;
  questionIds: string[];
  location: ReturnType<typeof useAttemptQuestionLocation>;
  navigation: ReturnType<typeof useAttemptQuestionNavigation>;
  practiceSubmit: ReturnType<typeof usePracticeQuestionSubmit>;
  currentQuestionId: string | null;
  navigationItems: QuestionNavigationItem[];
  navigatorMaterialsReady: boolean;
  answered: number;
  total: number;
  submittedPracticeCount: number;
}) {
  const { practiceProtocol, singleMode, resolvedSingleQuestionId } = location;
  const {
    navigatorOpen,
    setNavigatorOpen,
    navigatorFilter,
    setNavigatorFilter,
    jumpForMode,
  } = navigation;
  return (
    <AttemptNavigationDialog
      open={navigatorOpen}
      onOpenChange={setNavigatorOpen}
      onCloseFocus={navigation.closeNavigatorFocus}
      description={
        <>
          已填写 {answered}/{total} 题
          {practiceProtocol === "v1" && (
            <>
              {" "}
              · 已提交 {submittedPracticeCount}/{total} 题
            </>
          )}
        </>
      }
    >
      <LiveAttemptAnswerCard
        attemptId={attemptId}
        questionIds={questionIds}
        materialsReady={navigatorOpen && navigatorMaterialsReady}
        items={navigationItems}
        currentId={singleMode ? resolvedSingleQuestionId : currentQuestionId}
        filter={navigatorFilter}
        onFilterChange={setNavigatorFilter}
        onJump={jumpForMode}
        locked={singleMode && practiceSubmit.submittingId !== null}
        showNextUnanswered={singleMode}
      />
    </AttemptNavigationDialog>
  );
}

/** 两种提交确认弹层沿用页面既有状态机与缺稿裁决。 */
export function AttemptSessionSubmitDialogs({
  data,
  questionIndexById,
  navigationItems,
  confirmation,
  practiceSubmission,
  navigation,
  timeUp,
  savedOnly,
  unanswered,
}: {
  data: AttemptDraftData;
  questionIndexById: ReadonlyMap<string, number>;
  navigationItems: QuestionNavigationItem[];
  confirmation: ReturnType<typeof useAttemptSubmitConfirmation>;
  practiceSubmission: ReturnType<typeof useAttemptPracticeSubmission>;
  navigation: ReturnType<typeof useAttemptQuestionNavigation>;
  timeUp: boolean;
  savedOnly: boolean;
  unanswered: number;
}) {
  const { practiceProblem, setPracticeProblem, runPracticeSubmit } =
    practiceSubmission;
  const {
    confirmOpen,
    submit,
    notePrep,
    noteSummary,
    confirmSubmit,
    confirmMissingSubmit,
    closeSubmitDialog,
  } = confirmation;
  const { jumpForMode } = navigation;
  return (
    <>
      {/* 逐题提交缺稿明确选择弹层：choice→busy→error 相在 runPracticeSubmit 内迁移 */}
      <PracticeSubmitProblemDialog
        open={!timeUp && practiceProblem !== null}
        phase={practiceProblem?.phase ?? { kind: "choice", reason: "" }}
        onCancel={() => setPracticeProblem(null)}
        onConfirm={() => {
          const target = practiceProblem?.questionId;
          if (timeUp || target === undefined) return;
          setPracticeProblem((prev) =>
            prev !== null ? { ...prev, phase: { kind: "busy" } } : prev,
          );
          void runPracticeSubmit(target, { allowMissing: true });
        }}
      />

      <SubmitConfirmDialog
        open={confirmOpen}
        savedOnly={savedOnly}
        unansweredCount={unanswered}
        submitting={submit.isPending}
        verificationRequired={submit.verificationRequired}
        preparing={notePrep.kind === "preparing"}
        noteSummary={noteSummary}
        noteProblems={evidenceProblemViewsOf(notePrep, questionIndexById)}
        choiceMode={notePrep.kind === "choice"}
        notePrepError={notePrep.kind === "error" ? notePrep.message : null}
        dueAt={data.dueAt}
        answerRelease={data.answerRelease}
        onConfirm={() => void confirmSubmit()}
        onConfirmMissing={confirmMissingSubmit}
        onCancel={closeSubmitDialog}
        incompleteQuestions={
          timeUp
            ? []
            : navigationItems
                .filter((item) => item.completion.state !== "filled")
                .map((item) => ({
                  id: item.id,
                  index: item.index,
                  label: completionLabel(item.completion),
                }))
        }
        onGoToQuestion={(id) => {
          closeSubmitDialog();
          void jumpForMode(id, true);
        }}
      />
    </>
  );
}
