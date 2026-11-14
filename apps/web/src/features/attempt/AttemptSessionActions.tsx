import type { PracticeQuestionProgress } from "@tutor/contract";
import { AttemptBottomBar, AttemptNavigatorButton } from "./AttemptBottomBar";
import { PracticeSingleActions } from "./PracticeQuestionSubmit";
import { SingleQuestionActionBar } from "./PracticeWorkspace";
import type { useAttemptPracticeSubmission } from "./use-attempt-practice-submission";
import type { useAttemptQuestionLocation } from "./use-attempt-question-location";
import type { useAttemptQuestionNavigation } from "./use-attempt-question-navigation";
import type { useAttemptSubmitConfirmation } from "./use-attempt-submit-confirmation";
import type { usePracticeQuestionSubmit } from "./use-practice-question-submit";

/** 列表与单题的提交/导航操作条，共用页面的状态与动作。 */
export function AttemptSessionActions({
  location,
  navigation,
  practiceSubmission,
  confirmation,
  practiceSubmit,
  timeUp,
  online,
  denied,
  total,
  answered,
  submittedPracticeCount,
  singleProgressRow,
  singleAutoSubmit,
  materialsReady,
  saveFailed,
  questionIds,
}: {
  location: ReturnType<typeof useAttemptQuestionLocation>;
  navigation: ReturnType<typeof useAttemptQuestionNavigation>;
  practiceSubmission: ReturnType<typeof useAttemptPracticeSubmission>;
  confirmation: ReturnType<typeof useAttemptSubmitConfirmation>;
  practiceSubmit: ReturnType<typeof usePracticeQuestionSubmit>;
  timeUp: boolean;
  online: boolean;
  denied: boolean;
  total: number;
  answered: number;
  submittedPracticeCount: number;
  singleProgressRow: PracticeQuestionProgress | undefined;
  singleAutoSubmit: boolean;
  materialsReady: boolean;
  saveFailed: boolean;
  questionIds: string[];
}) {
  const {
    practiceWorkflow,
    singleMode,
    resolvedSingleQuestionId,
    singleIndex,
    practiceProtocol,
  } = location;
  const { openNavigator, goSingleQuestion } = navigation;
  const { runPracticeSubmit } = practiceSubmission;
  const { openSubmitDialog, inkFlushError, submitError } = confirmation;
  // 单题吸底进度：题号 + 逐题提交进度（整卷反馈不可逐题提交时报已填写）；
  // canSubmitQuestion 只取工作流级开关——题目级参考答案门控已随 v2 自评实现移除
  const singleCanSubmit =
    !timeUp && practiceWorkflow?.canSubmitQuestion === true;
  const singleProgressCount = singleCanSubmit
    ? submittedPracticeCount
    : answered;

  const singleActions = singleMode && resolvedSingleQuestionId !== null && (
    <div inert={!materialsReady}>
      <SingleQuestionActionBar
        navigation={
          <AttemptNavigatorButton
            onOpen={openNavigator}
            disabled={practiceSubmit.submittingId !== null}
          >
            <span aria-hidden className="hidden sm:inline">
              答题卡
            </span>
            <span>
              {singleIndex + 1}/{total}
            </span>
          </AttemptNavigatorButton>
        }
        showNext={
          !singleProgressRow?.submittedAt &&
          !practiceSubmit.finished &&
          singleCanSubmit
        }
        hasPrev={singleIndex > 0}
        hasNext={singleIndex < total - 1}
        busy={practiceSubmit.submittingId !== null}
        middle={
          <PracticeSingleActions
            canSubmitQuestion={singleCanSubmit}
            finishDisabled={!online || denied || total === 0}
            onFinish={openSubmitDialog}
            submitted={(singleProgressRow?.submittedAt ?? null) !== null}
            autoSubmit={singleAutoSubmit}
            busy={practiceSubmit.submittingId !== null}
            finished={practiceSubmit.finished}
            hasNext={singleIndex < total - 1}
            continueUnsubmittedId={
              practiceSubmit.firstUnsubmittedId !== null &&
              practiceSubmit.firstUnsubmittedId !== resolvedSingleQuestionId &&
              practiceSubmit.firstUnsubmittedId !== questionIds[singleIndex + 1]
                ? practiceSubmit.firstUnsubmittedId
                : null
            }
            error={
              practiceSubmit.lastError?.questionId === resolvedSingleQuestionId
                ? practiceSubmit.lastError.message
                : null
            }
            onSubmit={() => {
              if (resolvedSingleQuestionId !== null)
                void runPracticeSubmit(resolvedSingleQuestionId);
            }}
            onNext={() => {
              const next = questionIds[singleIndex + 1];
              if (next !== undefined) void goSingleQuestion(next);
            }}
            onViewResult={() => practiceSubmit.viewResult()}
            onContinue={(id) => void goSingleQuestion(id)}
          />
        }
        onPrev={() => {
          const prev = questionIds[singleIndex - 1];
          if (prev !== undefined) void goSingleQuestion(prev);
        }}
        onNext={() => {
          const next = questionIds[singleIndex + 1];
          if (next !== undefined) void goSingleQuestion(next);
        }}
      />
    </div>
  );

  // 吸底操作条在逐题全部收尾后显示查看本次结果。
  return (
    <AttemptBottomBar
      primaryActions={singleActions}
      progressLabel={
        singleMode
          ? `第 ${singleIndex + 1} / ${total} 题 · 已${singleCanSubmit ? "提交" : "填写"} ${singleProgressCount} 题`
          : undefined
      }
      progressValue={
        singleMode ? (total === 0 ? 0 : singleProgressCount / total) : undefined
      }
      answered={answered}
      total={total}
      offline={!online}
      denied={denied}
      saveFailed={saveFailed}
      inkFlushError={inkFlushError}
      submitError={submitError}
      practiceSubmittedCount={
        practiceProtocol === "v1" ? submittedPracticeCount : undefined
      }
      viewResult={practiceProtocol === "v1" && practiceSubmit.finished}
      onViewResult={() => practiceSubmit.viewResult()}
      onOpenSubmit={openSubmitDialog}
      onOpenNavigator={openNavigator}
    />
  );
}
