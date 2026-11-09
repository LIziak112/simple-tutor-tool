import type {
  AttemptQuestionPublic,
  PracticeQuestionProgress,
} from "@tutor/contract";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  prepareSubmitEvidence,
  type SubmitEvidencePrep,
} from "@/features/notes/submit-evidence";
import { sealAttemptAnnotationsApi } from "@/lib/api";
import type { useAttemptEditor } from "./AttemptEditorContext";
import type { AttemptRecoveryState } from "./attempt-material-recovery";
import { useSubmitAttempt } from "./attempt-queries";
import { draftStore } from "./draft-store";
import type { AttemptEventsApi } from "./use-attempt-events";
import type { DraftSyncApi } from "./use-draft-sync";
import type { InkUploadController } from "./use-ink-upload";
import {
  type EvidenceConfirmContext,
  type EvidenceConfirmOutcome,
  useSubmitEvidenceConfirm,
} from "./use-submit-evidence-confirm";

/**
 * 整卷交卷编排 hook（阶段 B 做题工作区改版，2026-11，从 AttemptSession.AnswerView
 * 抽出；注入共享确认状态机 use-submit-evidence-confirm；T2.8 口径 + T6R.10
 * 证据固定，方案 §6.4 六步）：
 * 1. 模态弹层已冻结编辑界面（当前真实笔段随指针抬起自然结束，链路无
 *    用户输入竞态）；
 * 2. 两条独立网络链**并行**：每道手写题的最新笔迹 flush（Promise.all，
 *    任一失败 → 阻止交卷并提示重试——「交卷时确保每道手写题最新笔迹已
 *    上传」的既有强制上传约束不因草稿链路放宽）+ prepareSubmitEvidence
 *    （等本地落盘事务 → flushNoteSync 追平矢量 → 逐题拉服务端 head →
 *    组装 none/frozen/missing 声明；PNG 不阻塞，后台补图）；
 * 3. 有未决问题 → 弹层切「草稿未保存完整」明确选择分支，交卷被阻止；
 * 4. 交卷请求携带 revisions + evidence（服务端同一事务固定原稿）；
 *    成功后清本地草稿（T2.9；交卷 clearDraft 不删 notes）。
 * 失败时错误相留在弹层内提示（点「确认交卷」即可重试整条链）；
 * 响应丢失重试撞 409 ALREADY_SUBMITTED 由 useSubmitAttempt 失效详情
 * 切结果视图（不自动重交）。
 * 行为与抽出前逐字一致：只搬运，不改语义。
 */

/** 题卡编辑器上下文（useAttemptEditor 返回值；本 hook 只用 request 收笔） */
export type AttemptEditorApi = NonNullable<ReturnType<typeof useAttemptEditor>>;

export interface AttemptSubmitController {
  /** 交卷确认弹层是否打开 */
  confirmOpen: boolean;
  /** 草稿证据准备阶段（弹层各分支据此渲染） */
  notePrep: ReturnType<typeof useSubmitEvidenceConfirm>["phase"];
  noteSummary: ReturnType<typeof useSubmitEvidenceConfirm>["noteSummary"];
  /** 打开交卷弹层：先收起题卡编辑器（未保存确认），再交给共享状态机 */
  openSubmitDialog: () => Promise<void>;
  /** 关闭弹层 = 取消 = 中止准备链 */
  closeSubmitDialog: () => void;
  confirmSubmit: () => Promise<void>;
  confirmMissingSubmit: () => void;
  /** 交卷请求在途（按钮禁用） */
  submitting: boolean;
  /** 交卷请求失败文案（null=无错误） */
  submitError: string | null;
  /** 交卷 flush 笔迹失败（底栏提示，重试交卷消除） */
  inkFlushError: boolean;
  /** 交卷证据声明覆盖的题（v1 卷排除已逐题提交的题） */
  submitEvidenceQuestionIds: readonly string[];
}

export function useAttemptSubmit({
  attemptId,
  flatQuestions,
  questionIds,
  practiceProtocol,
  practiceProgress,
  inkControllers,
  draftSync,
  flushAnswers,
  materialRecovery,
  attemptEvents,
  editor,
  onAnnotationSealFailed,
}: {
  attemptId: string;
  flatQuestions: readonly AttemptQuestionPublic[];
  questionIds: readonly string[];
  practiceProtocol: "v1" | "legacy";
  /** 逐题提交进度（回执 overlay 后；legacy 卷传空数组） */
  practiceProgress: readonly PracticeQuestionProgress[];
  inkControllers: { current: Map<string, InkUploadController> };
  draftSync: Pick<DraftSyncApi, "syncNow" | "recoveryError">;
  flushAnswers: () => Promise<void>;
  materialRecovery: AttemptRecoveryState;
  attemptEvents: Pick<AttemptEventsApi, "finalizeSubmit">;
  editor: Pick<AttemptEditorApi, "request"> | null;
  /** 交卷成功后的标注 seal 失败回调（非阻断警示——AttemptSession 顶态） */
  onAnnotationSealFailed: () => void;
}): AttemptSubmitController {
  /** 笔迹上传失败提示（交卷 flush 失败时展示，重试交卷消除） */
  const [inkFlushError, setInkFlushError] = useState(false);
  /** 交卷准备中止标志：弹层关闭（=取消）置位，runSubmit 各 await 段后检查 */
  const submitAbortedRef = useRef(false);
  const submit = useSubmitAttempt(attemptId);

  // 交卷结束整卷，但仅为尚未提交题固定本次证据；已提交题沿用单题封存。
  // 使用提交回执合并后的进度，避免本页刚提交的题仍进入整卷证据声明。
  const submitEvidenceQuestionIds = useMemo(() => {
    if (practiceProtocol !== "v1") return questionIds;
    const submitted = new Set(
      practiceProgress
        .filter((row) => row.submittedAt !== null)
        .map((row) => row.questionId),
    );
    return questionIds.filter((id) => !submitted.has(id));
  }, [practiceProtocol, practiceProgress, questionIds]);

  // T6R.3：交卷回传的题目版本集合（建卷冻结时下发的 questionRevisionId 原样
  // 回传，服务端与冻结集合比对——本页数据即学生看到的卷，天然一致）
  const submitRevisions = useMemo(
    () =>
      flatQuestions.map((question) => ({
        questionId: question.id,
        questionRevisionId: question.questionRevisionId,
      })),
    [flatQuestions],
  );

  const runSubmit = useCallback(
    async (ctx: EvidenceConfirmContext): Promise<EvidenceConfirmOutcome> => {
      setInkFlushError(false);
      if (materialRecovery.state !== "ready" || draftSync.recoveryError)
        return { kind: "error", message: "请先完成作答材料恢复后再交卷" };
      // 两条独立网络链并行（模态弹层已冻结编辑，无用户输入竞态）：
      // 手写题笔迹 flush（既有硬约束，失败阻止交卷）+ 草稿追平与证据组装。
      // ink flush 契约永不 reject（失败以 false 返回）——单一 rejection 源
      // 是 prep；prep 失败时丢弃 ink 结果无害（对称于 ink 失败弃 prep：
      // 两者的副作用都只是把数据追平上传，本来就要做）
      const inkPromise = Promise.all(
        [...inkControllers.current.values()].map((controller) =>
          controller.flush(),
        ),
      );
      let prep: SubmitEvidencePrep;
      try {
        await draftSync.syncNow();
        await flushAnswers();
        if (submitAbortedRef.current) return { kind: "aborted" };
        prep = await prepareSubmitEvidence({
          attemptId,
          questionIds: submitEvidenceQuestionIds,
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
      await attemptEvents.finalizeSubmit();
      if (submitAbortedRef.current) return { kind: "aborted" };
      // 两阶段 busy 分离：准备完毕、进入提交——不再显示「正在同步草稿」
      ctx.enterSubmitting();
      const declarations = prep.declarations;
      await new Promise<void>((settle) => {
        submit.mutate(
          { revisions: submitRevisions, evidence: declarations },
          {
            onSuccess: () => {
              void draftStore.clearDraft(attemptId);
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
      attemptEvents,
      attemptId,
      draftSync.syncNow,
      draftSync.recoveryError,
      materialRecovery.state,
      flushAnswers,
      inkControllers,
      onAnnotationSealFailed,
      submit,
      submitEvidenceQuestionIds,
      submitRevisions,
    ],
  );

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
  }, [editor, openConfirmDialog]);

  /**
   * 关闭交卷弹层 = 取消 = 中止准备链：置 abort 标志（runSubmit 各
   * await 段后检查）并复位准备阶段。busy 期间 Radix 关闭路径已被弹层
   * 封堵（Esc/遮罩/×），此处是唯一的正常关闭入口（继续作答按钮）与
   * 防御纵深（未来新增的关闭路径同样被 abort 拦下）。
   */
  const closeSubmitDialog = useCallback(() => {
    submitAbortedRef.current = true;
    cancelConfirmDialog();
  }, [cancelConfirmDialog]);

  // 交卷失败：网络等错误留中文提示；QUESTION_REVISION_STALE（旧标签页/陈旧
  // 页面）由服务端中文 message 直接提示刷新重交（T6R.3）
  const submitError = submit.isError
    ? submit.error instanceof Error
      ? submit.error.message
      : "交卷失败，请稍后重试"
    : null;

  return {
    confirmOpen,
    notePrep,
    noteSummary,
    openSubmitDialog,
    closeSubmitDialog,
    confirmSubmit,
    confirmMissingSubmit,
    submitting: submit.isPending,
    submitError,
    inkFlushError,
    submitEvidenceQuestionIds,
  };
}
