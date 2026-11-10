import type { AttemptSubmitRevision } from "@tutor/contract";
import { type RefObject, useCallback, useRef, useState } from "react";
import {
  prepareSubmitEvidence,
  type SubmitEvidencePrep,
} from "@/features/notes/submit-evidence";
import { fetchAttemptApi, sealAttemptAnnotationsApi } from "@/lib/api";
import { useSubmitAttempt } from "./attempt-queries";
import { draftStore, getDraftPersistenceState } from "./draft-store";
import type { InkUploadController } from "./use-ink-upload";
import type {
  EvidenceConfirmContext,
  EvidenceConfirmOutcome,
} from "./use-submit-evidence-confirm";

export function useAttemptSubmitFlow({
  attemptId,
  savedOnly,
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
   * 1. 模态弹层已冻结编辑界面；2. 并行两链：每道手写题最新笔迹 flush（任一失败阻止
   * 交卷）+ prepareSubmitEvidence（落盘 → flushNoteSync → 拉 head → 组装 none/frozen/
   * missing 声明，PNG 后台补）；3. 有未决问题 → 弹层切明确选择分支；4. 请求携带
   * revisions + evidence，成功后由结果页按交卷时刻清理本机稿。失败可重试；
   * 响应丢失重试撞 409 ALREADY_SUBMITTED 由 useSubmitAttempt 切结果视图（不自动重交）。
   */
  const runSubmit = useCallback(
    async (ctx: EvidenceConfirmContext): Promise<EvidenceConfirmOutcome> => {
      setInkFlushError(false);
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
      try {
        if (savedOnly) {
          await draftStore.loadDraft(attemptId, { strictRead: true });
          await draftStore.flush(attemptId);
          if (getDraftPersistenceState(attemptId) === "failed")
            throw new Error("本机作答保存失败，请重试后再交卷");
          const current = await fetchAttemptApi(attemptId);
          if (!("timing" in current) || current.timing?.phase !== "locked")
            throw new Error("服务端限时状态已变化，请刷新作答页后重试");
        } else {
          await syncDraft();
          await flushAnswers();
        }
        if (submitAbortedRef.current) return { kind: "aborted" };
        prep = await prepareSubmitEvidence({
          attemptId,
          questionIds,
          ...(ctx.missingConfirmed !== null
            ? { allowMissing: ctx.missingConfirmed }
            : {}),
        });
      } catch (err) {
        // 弹层已关（中止）：错误相也不落地（cancel 已复位 idle）
        if (submitAbortedRef.current) return { kind: "aborted" };
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
      if (submitAbortedRef.current) return { kind: "aborted" }; // 弹层已关：状态已由 cancel 复位
      const inkResults = await inkPromise;
      if (submitAbortedRef.current) return { kind: "aborted" };
      // ink 失败早退阻止交卷（prep 结果弃用——副作用无害）：收起弹层
      // 走底栏提示（状态迁移与 submitted 同——关弹层回 idle）
      if (!inkResults.every(Boolean)) {
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
      if (submitAbortedRef.current) return { kind: "aborted" };
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
          { revisions, evidence: declarations },
          {
            onSuccess: () => {
              // T6R.20 审查修复 2：标注 seal 在**交卷不可逆点之后**补调——失败
              // 非阻断（交卷已成事实不回滚），警示置位由结果视图横幅呈现；
              // 服务端读路径懒补封兜底最终一致（getAnnotationView/
              // assembleAnnotationPairs 入口）。seal 幂等（409 重交安全）。
              void sealAttemptAnnotationsApi(attemptId).catch(() => {
                onAnnotationSealFailed();
              });
            },
            onSettled: () => settle(),
          },
        );
      });
      return { kind: "submitted" };
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
    ],
  );
  return { inkFlushError, runSubmit, submit, submitAbortedRef };
}
