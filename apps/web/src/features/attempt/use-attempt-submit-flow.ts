import {
  type AttemptSubmitRevision,
  attemptSubmissionConflictSchema,
} from "@tutor/contract";
import { type RefObject, useCallback, useRef, useState } from "react";
import {
  prepareSubmitEvidence,
  type SubmitEvidencePrep,
} from "@/features/notes/submit-evidence";
import { ApiError, sealAttemptAnnotationsApi } from "@/lib/api";
import { useSubmitAttempt } from "./attempt-queries";
import {
  draftStore,
  getDraftPersistenceState,
  getDraftSessionEpoch,
} from "./draft-store";
import type { InkUploadController } from "./use-ink-upload";
import type {
  EvidenceConfirmContext,
  EvidenceConfirmOutcome,
} from "./use-submit-evidence-confirm";

export function useAttemptSubmitFlow({
  attemptId,
  savedOnly,
  timed,
  recoveryReady,
  syncDraft,
  flushAnswers,
  inkControllers,
  questionIds,
  revisions,
  finalizeEvents,
  onAnnotationSealFailed,
}: {
  attemptId: string;
  savedOnly: boolean;
  timed: boolean;
  recoveryReady: boolean;
  syncDraft: () => Promise<void>;
  flushAnswers: () => Promise<void>;
  inkControllers: RefObject<Map<string, InkUploadController>>;
  questionIds: string[];
  revisions: AttemptSubmitRevision[];
  finalizeEvents: () => Promise<void>;
  onAnnotationSealFailed: () => void;
}) {
  const [inkFlushError, setInkFlushError] = useState(false);
  const submitAbortedRef = useRef(false);
  const lockedRef = useRef(savedOnly);
  lockedRef.current = savedOnly;
  const submit = useSubmitAttempt(attemptId);

  /**
   * 交卷编排（共享确认状态机 use-submit-evidence-confirm；T2.8 + T6R.10 证据固定 §6.4）：
   * - 弹层冻结编辑。普通交卷并行追平正式笔迹与答案、草稿证据；正式作答
   *   尚未追平时阻止交卷。宽限结束后改为核验本机落盘，发送明确确认字段。
   * - prepareSubmitEvidence 等待本机落盘和草稿矢量同步，再拉服务端 head，
   *   组装 none/frozen/missing 声明。PNG 在后台补传，有缺稿先请学生选择。
   * - 服务端用 revisions 与 evidence 验证并固定原稿。结果页按交卷时刻
   *   清理或保留本机稿。响应丢失时由 useSubmitAttempt 重取结果，避免重交。
   */
  const runSubmit = useCallback(
    async (ctx: EvidenceConfirmContext): Promise<EvidenceConfirmOutcome> => {
      setInkFlushError(false);
      if (!recoveryReady)
        return { kind: "error", message: "请先完成作答材料恢复后再交卷" };
      const sessionEpoch = getDraftSessionEpoch();
      const sameSession = () => sessionEpoch === getDraftSessionEpoch();
      const cancelled = () => submitAbortedRef.current || !sameSession();
      // 两条独立网络链并行（模态弹层已冻结编辑，无用户输入竞态）：
      // 手写题笔迹 flush（既有硬约束，失败阻止交卷）+ 草稿追平与证据组装。
      // ink flush 契约永不 reject（失败以 false 返回）——单一 rejection 源
      // 是 prep；prep 失败时丢弃 ink 结果无害（对称于 ink 失败弃 prep：
      // 两者的副作用都只是把数据追平上传，本来就要做）
      const inkPromise = savedOnly
        ? Promise.resolve([])
        : Promise.all(
            [...inkControllers.current.values()].map((controller) =>
              controller.flush(),
            ),
          );
      let prep: SubmitEvidencePrep;
      let submittedRevisions: AttemptSubmitRevision[];
      try {
        if (savedOnly) {
          await draftStore.loadDraft(attemptId, { strictRead: true });
          if (cancelled()) return { kind: "aborted" };
          await draftStore.flush(attemptId);
          if (getDraftPersistenceState(attemptId) === "failed")
            throw new Error("本机作答保存失败，请重试后再交卷");
        } else {
          await syncDraft();
          if (cancelled()) return { kind: "aborted" };
          await flushAnswers();
        }
        if (cancelled()) return { kind: "aborted" };
        const record = await draftStore.loadDraft(attemptId, {
          strictRead: true,
        });
        submittedRevisions = revisions.map((revision) => ({
          ...revision,
          expectedAnswerRevision:
            record?.answerRevisions?.[revision.questionId] ??
            revision.expectedAnswerRevision ??
            0,
        }));
        if (cancelled()) return { kind: "aborted" };
        prep = await prepareSubmitEvidence({
          attemptId,
          questionIds,
          ...(ctx.missingConfirmed !== null
            ? { allowMissing: ctx.missingConfirmed }
            : {}),
        });
      } catch (err) {
        // 弹层已关（中止）：错误相也不落地（cancel 已复位 idle）
        if (cancelled()) return { kind: "aborted" };
        // 阻止性失败（head 拉取失败等）：如实提示，并清空缺稿确认集——
        // 下轮普通确认重新权威判定，缺稿题重新显式确认
        ctx.clearMissingConfirmed();
        return {
          kind: "error",
          message:
            err instanceof Error
              ? err.message
              : "草稿状态获取失败，请检查网络后重试",
        };
      }
      if (cancelled()) return { kind: "aborted" };
      const inkResults = await inkPromise;
      if (cancelled()) return { kind: "aborted" };
      // ink 失败早退阻止交卷（prep 结果弃用——副作用无害）：收起弹层
      // 走底栏提示（状态迁移与 submitted 同——关弹层回 idle）
      const hasPendingInk =
        timed &&
        !savedOnly &&
        draftStore
          .peekUnsyncedInkIds(attemptId)
          .some((id) => questionIds.includes(id));
      if (!inkResults.every(Boolean) || hasPendingInk) {
        setInkFlushError(true);
        return { kind: "submitted" };
      }
      if (prep.declarations === null) {
        // 有未追平草稿：明确选择分支（不静默 missing，不提供普通确认）。
        // problems 必非空——declarations=null 由 problems.length>0 推导（不变量）
        return { kind: "problems", problems: prep.problems };
      }
      // T2.10：submit 前收尾事件（尽力 flush；失败不阻塞交卷，宽松口径兜底迟到事件）
      await finalizeEvents();
      if (cancelled()) return { kind: "aborted" };
      if (!savedOnly && lockedRef.current)
        return {
          kind: "error",
          message: "宽限已过，请重新确认按已保存作答交卷",
        };
      // 两阶段 busy 分离：准备完毕、进入提交——不再显示「正在同步草稿」
      ctx.enterSubmitting();
      const declarations = prep.declarations;
      await new Promise<void>((settle) => {
        submit.mutate(
          {
            revisions: submittedRevisions,
            evidence: declarations,
            ...(savedOnly ? { confirmedSavedAnswers: true } : {}),
          },
          {
            onSuccess: () => {
              if (!sameSession()) return;
              // T6R.20 审查修复 2：标注 seal 在**交卷不可逆点之后**补调——失败
              // 非阻断（交卷已成事实不回滚），警示置位由结果视图横幅呈现；
              // 服务端读路径懒补封兜底最终一致（getAnnotationView/
              // assembleAnnotationPairs 入口）。seal 幂等（409 重交安全）。
              void sealAttemptAnnotationsApi(attemptId).catch(() => {
                if (sameSession()) onAnnotationSealFailed();
              });
            },
            onError: (error) => {
              if (
                !(error instanceof ApiError) ||
                error.code !== "ANSWER_REVISION_CONFLICT" ||
                !sameSession()
              )
                return;
              const conflict = attemptSubmissionConflictSchema.safeParse(
                error.extra,
              );
              if (
                conflict.success &&
                questionIds.includes(conflict.data._questionId)
              ) {
                draftStore.setAnswerConflict(
                  attemptId,
                  conflict.data._questionId,
                  conflict.data._current,
                );
              }
            },
            onSettled: () => settle(),
          },
        );
      });
      return { kind: sameSession() ? "submitted" : "aborted" };
    },
    [
      attemptId,
      finalizeEvents,
      flushAnswers,
      inkControllers,
      onAnnotationSealFailed,
      questionIds,
      recoveryReady,
      revisions,
      savedOnly,
      submit,
      syncDraft,
      timed,
    ],
  );
  return { inkFlushError, runSubmit, submit, submitAbortedRef };
}
