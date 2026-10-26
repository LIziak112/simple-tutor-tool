import { useQueryClient } from "@tanstack/react-query";
import type {
  AttemptDraftData,
  AttemptSummary,
  PracticeQuestionFeedback,
  PracticeQuestionProgress,
  PracticeWorkflow,
} from "@tutor/contract";
import { attemptAnswerConflictCurrentSchema } from "@tutor/contract";
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InkUploadController } from "@/features/attempt/use-ink-upload";
import {
  prepareSubmitEvidence,
  type SubmitEvidenceProblem,
} from "@/features/notes/submit-evidence";
import {
  ApiError,
  fetchPracticeQuestionFeedbackApi,
  submitPracticeQuestionApi,
} from "@/lib/api";
import { randomUuid } from "@/lib/uuid";
import {
  pauseAttemptDetailPolling,
  resumeAttemptDetailPolling,
  studentAttemptKey,
} from "./attempt-queries";
import { draftStore } from "./draft-store";
import { firstUnsubmittedQuestionId } from "./practice-protocol";

/**
 * 新协议逐题提交编排（M3-D2，计划 §10.2/§10.3，lesson useLessonAttempt.submit
 * 为蓝本）：收笔确认 → 该题笔迹 flush → 该题答案按题追平（M3-D3 §11-4，
 * 不等其他题在途）→ 单题证据组装 → 五字段
 * POST → 回执 overlay（反馈按题 + 全卷进度 + attempt 摘要 + 工作流 revision
 * 基线）。与 lesson 的差异：
 * - 请求带新协议五字段；submissionMutationId 结果未知重试且请求内容未变时
 *   固定复用（{id, payloadKey} 判定），内容变化（如证据重传后版本变化）换新；
 * - 最后一题提交触发服务端自动收尾（回执 attempt 离开 draft）时**不主动
 *   refetch**——保持反馈视图，暂停详情轮询，学生点「查看本次结果」才收敛；
 * - 已提交题的题级反馈按需 GET：单题模式当前题、列表模式卡进入视口
 *   （IntersectionObserver）才取，按题内存缓存一次、失败可重试；不为
 *   未提交/不可读题发请求；
 * - overlay 与 GET 缓存在草稿视图数据刷新（refetch 收敛）时整体重置——
 *   服务端值为权威（lesson 同口径）。
 * 状态纪律：已提交只以 questionProgress/回执为准（§9.1），不用输入框有值
 * 判定；一题同时最多一个在途提交（全卷串行）。
 */

/** 单题提交流程结果（footer 据此呈现；与 LessonSubmitOutcome 同族） */
export type PracticeSubmitOutcome =
  /** 已提交（含 ALREADY_SUBMITTED 家族的静默收敛：不弹错，refetch 收敛） */
  | { kind: "submitted" }
  /** 服务端拒绝逐题提交（教师收紧，§5.4）：refetch 草稿视图按受限呈现，不弹错 */
  | { kind: "restricted" }
  /** 用户取消（收笔确认选择继续书写）；不落地任何提示 */
  | { kind: "aborted" }
  /** 存在未追平草稿：需用户明确选择「草稿未保存完整」后带 allowMissing 重交 */
  | { kind: "problems"; problems: SubmitEvidenceProblem[] }
  /** 页面内容过期（题目/工作流/协议版本不一致）：提示刷新 */
  | { kind: "stale"; message: string }
  /** 阻止性失败（保存/网络/服务端）：就地提示，可重试 */
  | { kind: "error"; message: string };

/** 回执 overlay（草稿视图数据为基线，提交响应覆盖） */
interface PracticeOverlay {
  questionProgress: readonly PracticeQuestionProgress[];
  attempt: AttemptSummary;
  workflow: PracticeWorkflow;
}

/** 通用错误 → 中文文案 */
function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** 页面内容过期（题目/工作流/协议版本不一致）的统一提示 */
const STALE_MESSAGE = "页面内容已过期，请刷新后重试";

/** 幂等收敛错误码（已提交过：不弹错，refetch 收敛到最新状态） */
function isAlreadySubmittedError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.code === "QUESTION_ALREADY_SUBMITTED" ||
      err.code === "ALREADY_SUBMITTED")
  );
}

/** stale 口径（页面内容过期，提示刷新；含旧协议/陈旧工作流/陈旧题目版本） */
function isStaleError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.code === "QUESTION_REVISION_STALE" ||
      err.code === "WORKFLOW_REVISION_STALE" ||
      err.code === "WORKFLOW_PROTOCOL_MISMATCH" ||
      err.code === "WORKFLOW_LEGACY")
  );
}

export function usePracticeQuestionSubmit(input: {
  data: AttemptDraftData;
  attemptId: string;
  questionIds: readonly string[];
  /** 题卡元素注册表（列表模式视口观察用） */
  cardElements: RefObject<Map<string, HTMLLIElement>>;
  /** 单题模式当前题（列表模式传 null：只用视口观察取反馈） */
  singleQuestionId: string | null;
  singleMode: boolean;
  syncNow: () => Promise<unknown>;
  /**
   * 该题答案服务端同步确认（M3-D3 §11-4 按题 flush）：只等本题在途与重试，
   * 不等其他题；false=本题未追平（就地提示，不发提交请求）。
   */
  flushQuestion: (questionId: string) => Promise<boolean>;
  inkControllers: RefObject<Map<string, InkUploadController>>;
  /** 提交前收笔（编辑器让位）；返回 false = 用户选择继续书写，中止提交 */
  beforeSubmit: () => Promise<boolean>;
}) {
  const { attemptId, questionIds, singleMode } = input;
  const queryClient = useQueryClient();
  const isV1 = input.data.practiceWorkflow !== undefined;
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      resumeAttemptDetailPolling(attemptId);
    };
  }, [attemptId]);

  // ---- 回执 overlay 与题级反馈缓存（data 刷新整体重置：服务端值为权威） ----
  const [overlay, setOverlay] = useState<PracticeOverlay | null>(null);
  const [feedbacks, setFeedbacks] = useState<
    Record<string, PracticeQuestionFeedback>
  >({});
  const [feedbackFailed, setFeedbackFailed] = useState<
    Record<string, true | undefined>
  >({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: data 是 overlay/缓存重置的变更键（effect 体不直接读取，草稿视图重取必须重置读侧状态）
  useEffect(() => {
    setOverlay(null);
    setFeedbacks({});
    setFeedbackFailed({});
  }, [input.data]);
  const progress =
    overlay?.questionProgress ?? input.data.questionProgress ?? [];
  const workflow = overlay?.workflow ?? input.data.practiceWorkflow;
  const attempt = overlay?.attempt ?? input.data.attempt;
  const finished = attempt.status !== "draft";

  // ---- 在途提交（全卷串行；一题同时最多一个在途） ----
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const submittingRef = useRef<string | null>(null);
  /** 幂等键复用对：请求内容未变的重试固定复用同一 mutationId（§10.3） */
  const mutationPairRef = useRef<{ id: string; key: string } | null>(null);
  /** WORKFLOW_MUTATION_CONFLICT 的自动换新重试只做一次 */
  const mutationRetriedRef = useRef(false);
  /** 就地错误提示（stale/网络/冲突；成功或新一轮提交清除） */
  const [lastError, setLastError] = useState<{
    questionId: string;
    message: string;
  } | null>(null);

  // 稳定引用桥（submit 的 useCallback 依赖保持收敛）
  const beforeSubmitRef = useRef(input.beforeSubmit);
  beforeSubmitRef.current = input.beforeSubmit;
  const syncNowRef = useRef(input.syncNow);
  syncNowRef.current = input.syncNow;
  const flushQuestionRef = useRef(input.flushQuestion);
  flushQuestionRef.current = input.flushQuestion;
  const dataRef = useRef(input.data);
  dataRef.current = input.data;

  /** 详情查询收敛（invalidate 即 refetch：staleTime 0） */
  const refetchDetail = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: studentAttemptKey(attemptId),
    });
  }, [attemptId, queryClient]);

  /** 查看本次结果：解除轮询暂停并走既有收敛路径（详情重取→切结果视图） */
  const viewResult = useCallback(() => {
    resumeAttemptDetailPolling(attemptId);
    refetchDetail();
  }, [attemptId, refetchDetail]);

  const submit = useCallback(
    async (
      questionId: string,
      opts?: { allowMissing?: boolean },
    ): Promise<PracticeSubmitOutcome> => {
      if (submittingRef.current !== null) {
        return { kind: "error", message: "正在提交上一题，请稍候" };
      }
      // 每次提交重置换新重试预算：上一题的自动重试失败不得占用本题额度
      mutationRetriedRef.current = false;
      const currentData = dataRef.current;
      const currentWorkflow = currentData.practiceWorkflow;
      if (currentWorkflow === undefined) {
        return { kind: "stale", message: STALE_MESSAGE };
      }
      const question = currentData.units
        .flatMap((unit) => unit.questions)
        .find((item) => item.id === questionId);
      if (question === undefined) {
        return { kind: "error", message: "这道题不在本次练习中，请刷新页面" };
      }
      if (!(await beforeSubmitRef.current())) return { kind: "aborted" };
      submittingRef.current = questionId;
      setSubmittingId(questionId);
      setLastError(null);
      // 错误路径收敛：就地提示与 outcome 同 message（§10.3），单一出处
      const failWith = (message: string): PracticeSubmitOutcome => {
        setLastError({ questionId, message });
        return { kind: "error", message };
      };
      let pausedForSubmission = false;
      let keepPaused = false;
      try {
        // 手写题笔迹先行（同整卷/lesson「提交前该题笔迹已上传」口径）
        const controller = input.inkControllers.current.get(questionId);
        if (controller !== undefined && !(await controller.flush())) {
          return {
            kind: "error",
            message: "手写内容还没有上传完成，请稍后重试",
          };
        }
        await syncNowRef.current();
        // 按题 flush（M3-D3 §11-4）：只确认本题答案同步，不等其他题在途重试；
        // 未追平不发提交请求，就地提示可重试（与其他错误路径同走 lastError）
        if (!(await flushQuestionRef.current(questionId))) {
          return failWith("本题答案尚未保存完成，请检查网络后重试");
        }
        const prep = await prepareSubmitEvidence({
          attemptId,
          questionIds: [questionId],
          ...(opts?.allowMissing === true
            ? { allowMissing: new Set([questionId]) }
            : {}),
        });
        if (prep.declarations === null) {
          return { kind: "problems", problems: prep.problems };
        }
        const evidence = prep.declarations[0];
        if (evidence === undefined) {
          return {
            kind: "error",
            message: "草稿状态获取失败，请检查网络后重试",
          };
        }
        // 答案版本基线：追平后的本机记录（服务端 CAS 比对，§10.2）
        const record = await draftStore.loadDraft(attemptId);
        const expectedAnswerRevision =
          record?.answerRevisions?.[questionId] ?? 0;
        const workflowRevision = currentWorkflow.revision;
        const payloadKey = JSON.stringify([
          questionId,
          workflowRevision,
          question.questionRevisionId,
          expectedAnswerRevision,
          evidence,
        ]);

        const postOnce = (mutationId: string) =>
          submitPracticeQuestionApi(attemptId, questionId, {
            workflowVersion: 1,
            workflowRevision,
            questionRevisionId: question.questionRevisionId,
            expectedAnswerRevision,
            submissionMutationId: mutationId,
            evidence,
          });

        const pair = mutationPairRef.current;
        const mutationId =
          pair !== null && pair.key === payloadKey ? pair.id : randomUuid();
        mutationPairRef.current = { id: mutationId, key: payloadKey };
        if (!activeRef.current) return { kind: "aborted" };
        const remaining = progressRef.current.filter(
          (row) => row.submittedAt === null,
        );
        if (remaining.length === 1 && remaining[0]?.questionId === questionId) {
          // 在末题请求出站前保护阅读现场，避免服务端已收尾、回执仍在途时被详情抢先覆盖。
          pauseAttemptDetailPolling(attemptId);
          pausedForSubmission = true;
          await queryClient.cancelQueries({
            queryKey: studentAttemptKey(attemptId),
            exact: true,
          });
        }
        let result: Awaited<ReturnType<typeof postOnce>>;
        try {
          result = await postOnce(mutationId);
        } catch (err) {
          // 同 mutationId 异摘要（§10.3）：换新 id 自动重试一次，仍失败就地提示
          if (
            err instanceof ApiError &&
            err.code === "WORKFLOW_MUTATION_CONFLICT" &&
            !mutationRetriedRef.current
          ) {
            mutationRetriedRef.current = true;
            const retryId = randomUuid();
            mutationPairRef.current = { id: retryId, key: payloadKey };
            result = await postOnce(retryId);
          } else {
            throw err;
          }
        }
        mutationPairRef.current = null;
        mutationRetriedRef.current = false;
        setFeedbacks((prev) => ({
          ...prev,
          [questionId]: result.feedback,
        }));
        setOverlay({
          questionProgress: result.questionProgress,
          attempt: result.attempt,
          workflow: result.practiceWorkflow,
        });
        if (result.attempt.status !== "draft" && activeRef.current) {
          // 最后一题已收尾：停轮询、保持反馈视图——学生显式查看才收敛（§10.3）
          pauseAttemptDetailPolling(attemptId);
          keepPaused = true;
        }
        return { kind: "submitted" };
      } catch (err) {
        if (isAlreadySubmittedError(err)) {
          // 已提交过（迟到回执/他端已交）：静默收敛，不弹错误
          refetchDetail();
          return { kind: "submitted" };
        }
        if (isStaleError(err)) {
          setLastError({ questionId, message: STALE_MESSAGE });
          return { kind: "stale", message: STALE_MESSAGE };
        }
        if (
          err instanceof ApiError &&
          err.code === "ANSWER_REVISION_CONFLICT"
        ) {
          // 复用既有答案冲突裁决 UI（AttemptSyncConflicts 读同一记录）
          const current = attemptAnswerConflictCurrentSchema.safeParse(
            err.extra?._current,
          );
          if (current.success) {
            draftStore.setAnswerConflict(attemptId, questionId, current.data);
          }
          return failWith(
            "本题答案在其他设备有修改，请先选择保留哪一份，再重新提交",
          );
        }
        if (err instanceof ApiError && err.code === "WORKFLOW_RESTRICTED") {
          // 教师收紧（§5.4 当前 gate 口径）：refetch 草稿视图按受限呈现，不弹错误
          refetchDetail();
          return { kind: "restricted" };
        }
        return failWith(messageOf(err, "提交失败，请稍后重试"));
      } finally {
        if (pausedForSubmission && !keepPaused) {
          resumeAttemptDetailPolling(attemptId);
        }
        submittingRef.current = null;
        setSubmittingId(null);
      }
    },
    [attemptId, input.inkControllers, queryClient, refetchDetail],
  );

  // ---- 已提交可读题的题级反馈按需 GET（缓存一次，失败可重试） ----
  const feedbackFetchingRef = useRef(new Set<string>());
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const feedbacksRef = useRef(feedbacks);
  feedbacksRef.current = feedbacks;
  const ensureFeedback = useCallback(
    async (questionId: string) => {
      if (feedbackFetchingRef.current.has(questionId)) return;
      if (feedbacksRef.current[questionId] !== undefined) return;
      const row = progressRef.current.find(
        (item) => item.questionId === questionId,
      );
      if (
        row === undefined ||
        row.submittedAt === null ||
        !row.feedbackReadable
      )
        return;
      feedbackFetchingRef.current.add(questionId);
      try {
        const data = await fetchPracticeQuestionFeedbackApi(
          attemptId,
          questionId,
        );
        setFeedbacks((prev) => ({ ...prev, [questionId]: data.feedback }));
        setFeedbackFailed((prev) => {
          if (prev[questionId] === undefined) return prev;
          const next = { ...prev };
          delete next[questionId];
          return next;
        });
      } catch {
        // 失败可重试：footer 呈现重试入口；不缓存失败结果
        setFeedbackFailed((prev) => ({ ...prev, [questionId]: true }));
      } finally {
        feedbackFetchingRef.current.delete(questionId);
      }
    },
    [attemptId],
  );

  // 单题模式：当前题为已提交可读时读取（切题即取，§10.1 no-store 每次权威；
  // 依赖 progress 与 feedbacks——后台轮询重取会整体清空反馈缓存（reset effect
  // 的 setState 在本 effect 跑时尚未反映到 refs），当前题须在此自动补取，
  // 否则已提交反馈卡悬在「正在读取」且无重试入口）
  useEffect(() => {
    if (!isV1 || !singleMode || input.singleQuestionId === null) return;
    if (feedbacks[input.singleQuestionId] !== undefined) return;
    const row = progress.find(
      (item) => item.questionId === input.singleQuestionId,
    );
    if (row === undefined || row.submittedAt === null || !row.feedbackReadable)
      return;
    void ensureFeedback(input.singleQuestionId);
  }, [
    ensureFeedback,
    feedbacks,
    input.singleQuestionId,
    isV1,
    progress,
    singleMode,
  ]);

  // 列表模式：已提交可读卡的反馈按视口惰性获取（不预取全部）
  useEffect(() => {
    if (!isV1 || singleMode) return;
    if (typeof IntersectionObserver === "undefined") return;
    const targets = questionIds.filter((id) => {
      if (feedbacks[id] !== undefined) return false;
      const row = progress.find((item) => item.questionId === id);
      return (
        row !== undefined && row.submittedAt !== null && row.feedbackReadable
      );
    });
    if (targets.length === 0) return;
    const byElement = new Map<Element, string>();
    for (const id of targets) {
      const element = input.cardElements.current.get(id);
      if (element !== undefined) byElement.set(element, id);
    }
    if (byElement.size === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = byElement.get(entry.target);
          if (id !== undefined) void ensureFeedback(id);
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px 160px 0px" },
    );
    for (const element of byElement.keys()) observer.observe(element);
    return () => observer.disconnect();
  }, [
    ensureFeedback,
    feedbacks,
    input.cardElements,
    isV1,
    progress,
    questionIds,
    singleMode,
  ]);

  const feedbackOf = useCallback(
    (questionId: string): PracticeQuestionFeedback | null =>
      feedbacks[questionId] ?? null,
    [feedbacks],
  );

  /** 第一道未提交题（「继续未提交题目」定位；全部已提交为 null） */
  const firstUnsubmittedId = useMemo(
    () => firstUnsubmittedQuestionId(questionIds, progress),
    [progress, questionIds],
  );

  return {
    submit,
    submittingId,
    finished,
    progress,
    workflow,
    feedbackOf,
    feedbackFailedOf: (questionId: string) =>
      feedbackFailed[questionId] === true,
    retryFeedback: (questionId: string) => void ensureFeedback(questionId),
    lastError,
    viewResult,
    firstUnsubmittedId,
  };
}
