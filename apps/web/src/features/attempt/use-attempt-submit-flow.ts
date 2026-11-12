import type {
  AttemptSubmitRequest,
  AttemptSubmitRevision,
} from "@tutor/contract";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  prepareSubmitEvidence,
  type SubmitEvidencePrep,
} from "@/features/notes/submit-evidence";
import { sealAttemptAnnotationsApi } from "@/lib/api";
import { withRequestDeadline } from "@/lib/request-deadline";
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
  const flowGeneration = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 切换题卷时废止上一卷的异步流程。
  useEffect(
    () => () => {
      flowGeneration.current += 1;
    },
    [attemptId],
  );
  const lockedRef = useRef(savedOnly);
  lockedRef.current = savedOnly;
  const submit = useSubmitAttempt(attemptId);
  const send = useCallback(
    async (
      ctx: EvidenceConfirmContext,
      input: AttemptSubmitRequest,
      aborted: () => boolean,
    ): Promise<EvidenceConfirmOutcome> => {
      ctx.enterSubmitting();
      try {
        await submit.mutateAsync(input);
      } catch (error) {
        if (aborted()) return { kind: "aborted" };
        return {
          kind: "error",
          message: error instanceof Error ? error.message : "交卷失败，请重试",
        };
      }
      if (aborted()) return { kind: "aborted" };
      // 标注封存可在确认交卷之后补做，失败留给结果页显示。
      void sealAttemptAnnotationsApi(attemptId).catch(onAnnotationSealFailed);
      return { kind: "submitted" };
    },
    [attemptId, onAnnotationSealFailed, submit],
  );

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
      const generation = flowGeneration.current;
      const epoch = getDraftSessionEpoch();
      const aborted = () =>
        submitAbortedRef.current ||
        generation !== flowGeneration.current ||
        epoch !== getDraftSessionEpoch();
      if (aborted()) return { kind: "aborted" };
      if (submit.verificationRequired) return send(ctx, { revisions }, aborted);
      if (!recoveryReady)
        return { kind: "error", message: "请先完成作答材料恢复后再交卷" };
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
      let inkResults: boolean[];
      try {
        [prep, inkResults] = await withRequestDeadline((signal) => {
          const prepare = async () => {
            if (savedOnly) {
              await draftStore.loadDraft(attemptId, { strictRead: true });
              await draftStore.flush(attemptId);
              if (getDraftPersistenceState(attemptId) === "failed")
                throw new Error("本机作答保存失败，请重试后再交卷");
            } else {
              await syncDraft();
              signal.throwIfAborted();
              if (aborted()) throw new Error("作答已切换");
              await flushAnswers();
            }
            signal.throwIfAborted();
            if (aborted()) throw new Error("作答已切换");
            return prepareSubmitEvidence({
              attemptId,
              questionIds,
              signal,
              assertActive: () => {
                if (aborted()) throw new Error("作答已切换");
              },
              ...(ctx.missingConfirmed !== null
                ? { allowMissing: ctx.missingConfirmed }
                : {}),
            });
          };
          return Promise.all([prepare(), inkPromise]);
        }, "同步作答和草稿");
      } catch (err) {
        // 弹层已关（中止）：错误相也不落地（cancel 已复位 idle）
        if (aborted()) return { kind: "aborted" };
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
      if (aborted()) return { kind: "aborted" };
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
      if (!savedOnly && lockedRef.current)
        return {
          kind: "error",
          message: "宽限已过，请重新确认按已保存作答交卷",
        };
      // 学情队列自行落盘和补传，作答证据完成后直接提交。
      void finalizeEvents().catch(() => {});
      return send(
        ctx,
        {
          revisions,
          evidence: prep.declarations,
          ...(savedOnly ? { confirmedSavedAnswers: true } : {}),
        },
        aborted,
      );
    },
    [
      attemptId,
      finalizeEvents,
      flushAnswers,
      inkControllers,
      questionIds,
      recoveryReady,
      revisions,
      savedOnly,
      send,
      submit.verificationRequired,
      syncDraft,
      timed,
    ],
  );
  return { inkFlushError, runSubmit, submit, submitAbortedRef };
}
