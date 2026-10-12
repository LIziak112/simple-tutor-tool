import type {
  AttemptResultQuestion,
  AttemptScoreSummary,
  AttemptSummary,
  HintOpenedEntry,
  LessonStartData,
  StudentAnswer,
} from "@tutor/contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { draftStore } from "@/features/attempt/draft-store";
import { useAttemptAnswers } from "@/features/attempt/use-attempt-answers";
import { useAttemptEvents } from "@/features/attempt/use-attempt-events";
import { useAttemptSaveStatus } from "@/features/attempt/use-attempt-save-status";
import { useDraftSync } from "@/features/attempt/use-draft-sync";
import type { InkUploadController } from "@/features/attempt/use-ink-upload";
import {
  prepareSubmitEvidence,
  type SubmitEvidencePrep,
  type SubmitEvidenceProblem,
} from "@/features/notes/submit-evidence";
import { ApiError, submitAttemptApi, submitLessonQuestionApi } from "@/lib/api";
import { useOnlineStatus } from "@/lib/use-online-status";

/**
 * 讲练页作答会话（2026-10 讲练一体）：把讲练开卷投影（LessonStartData）接上
 * 既有作答链路——草稿防丢（use-draft-sync + use-attempt-answers）、提示解锁、
 * 事件埋点（use-attempt-events：question_view / answer_change / 提示解锁）、
 * 笔迹上传 controller 注册表，全部复用答题页同一批 hook（参数化而非分叉）。
 *
 * 与整卷答题会话（AttemptSession/AnswerView）的差异：
 * - 逐题提交：submitQuestion 走单题接口（questionRevisionId CAS + 单题笔记
 *   证据声明——prepareSubmitEvidence 对单题复用同一实现），成功后把当题结果
 *   叠加进本地 released 覆盖层（页面不再等 start 重取）；
 * - 覆盖层：released / summary / attempt 三个读侧字段以 start 数据为基线、
 *   单题提交响应覆盖；start 数据刷新（refetch）时覆盖层重置（服务端值为
 *   权威——「刷新」拿教师批改结果的收敛路径）；
 * - 完成练习：复用整卷交卷语义（submitAttemptApi：revisions 回传全集、
 *   evidence 只按未提交题声明——服务端对已提交行不重判不重做证据）；
 * - 事件：单题提交的服务端直记 question_submit/attempt_start/hint_open 不经
 *   本队列（双份可容忍，见 06/07 审查报告）；整卷收尾前照常 finalizeSubmit。
 */

/** 单题提交 / 完成练习的流程结果（卡片与页面据此呈现） */
export type LessonSubmitOutcome =
  /** 已提交（含 QUESTION_ALREADY_SUBMITTED / ALREADY_SUBMITTED 的静默收敛：不弹错、refetch 收敛） */
  | { kind: "submitted" }
  /** 存在未追平草稿：需用户明确选择「草稿未保存完整」后带 allowMissing 重交 */
  | { kind: "problems"; problems: SubmitEvidenceProblem[] }
  /** 页面内容过期（题目版本 / 笔记证据与服务器不一致）：提示刷新 */
  | { kind: "stale"; message: string }
  /** 阻止性失败（保存/网络/服务端）：如实提示，可重试 */
  | { kind: "error"; message: string };

/** 题卡消费的作答回调集（稳定引用，供卡片 memo） */
export interface LessonQuestionHandlers {
  onAnswer: (
    questionId: string,
    answer: StudentAnswer,
    defer?: boolean,
  ) => void;
  onHintUnlocked: (questionId: string, entry: HintOpenedEntry) => void;
  registerInkController: (
    questionId: string,
    controller: InkUploadController | null,
  ) => void;
  /** 题卡 DOM 注册（question_view 埋点 + 视口观察） */
  registerCard: (questionId: string, el: HTMLElement | null) => void;
  /** 单题提交（确认后调用）；opts.allowMissing = 用户已确认缺稿提交 */
  submit: (
    questionId: string,
    opts?: { allowMissing?: boolean },
  ) => Promise<LessonSubmitOutcome>;
}

/** 覆盖层：单题提交响应的三个读侧字段（start 数据为基线） */
interface LessonOverlay {
  released: Record<string, AttemptResultQuestion>;
  summary: AttemptScoreSummary;
  attempt: AttemptSummary;
}

/** 通用错误 → 中文文案 */
function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** 覆盖错误码 → stale 口径（页面内容过期，提示刷新） */
function isStaleError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.code === "QUESTION_REVISION_STALE" ||
      err.code === "NOTE_EVIDENCE_MISMATCH")
  );
}

/** 幂等收敛错误码（已提交过：不弹错，refetch 收敛到最新状态） */
function isAlreadySubmittedError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.code === "QUESTION_ALREADY_SUBMITTED" ||
      err.code === "ALREADY_SUBMITTED")
  );
}

export function useLessonAttempt(
  data: LessonStartData,
  options: { refetch: () => Promise<unknown> },
): {
  attemptId: string;
  attempt: AttemptSummary;
  released: Readonly<Record<string, AttemptResultQuestion>>;
  summary: AttemptScoreSummary | null;
  answers: Record<string, StudentAnswer> | null;
  setAnswer: (
    questionId: string,
    answer: StudentAnswer,
    defer?: boolean,
  ) => void;
  hintsOpened: Record<string, HintOpenedEntry[]>;
  saveStatus: string;
  denied: boolean;
  handlers: LessonQuestionHandlers;
  draftSyncContext: ReturnType<typeof useDraftSync>;
  /** 完成练习（整卷收尾；页面确认弹层驱动） */
  finish: (opts?: {
    allowMissing?: ReadonlySet<string>;
  }) => Promise<LessonSubmitOutcome>;
} {
  const attemptId = data.attempt.id;
  // refetch 独立取值（useQuery 的 refetch 引用稳定）：submit/finish 的回调
  // 依赖不含 options 对象本身，题卡 handlers 引用随页面渲染保持稳定
  const { refetch } = options;
  const questionIds = useMemo(
    () => data.questions.map((question) => question.id),
    [data.questions],
  );

  // ---- 既有作答链路（与 AnswerView 同款接线） ----
  const inkControllers = useRef(new Map<string, InkUploadController>());
  const registerInkController = useCallback(
    (questionId: string, controller: InkUploadController | null) => {
      if (controller === null) inkControllers.current.delete(questionId);
      else inkControllers.current.set(questionId, controller);
    },
    [],
  );
  const draftSync = useDraftSync(attemptId, data.drafts, inkControllers);
  const attemptEvents = useAttemptEvents(attemptId);
  const {
    answers,
    setAnswer,
    flush: flushAnswers,
  } = useAttemptAnswers(attemptId, draftSync.recoveredDrafts, draftSync, {
    onAnswerCommitted: (questionId, answer) => {
      attemptEvents.noteInteraction(questionId);
      attemptEvents.trackAnswerChange(questionId, answer);
    },
  });
  const online = useOnlineStatus();
  const saveStatus = useAttemptSaveStatus(
    attemptId,
    questionIds,
    draftSync.status,
    online,
    inkControllers,
  );
  const denied = draftSync.status.state === "denied";

  // 已解锁提示：初值取开卷回显，解锁成功本地追加；start 数据刷新以服务端为准
  const [hintsOpened, setHintsOpened] = useState<
    Record<string, HintOpenedEntry[]>
  >(() => data.hintsOpened);
  useEffect(() => {
    setHintsOpened(data.hintsOpened);
  }, [data]);

  // 覆盖层：单题提交响应叠加；start 数据刷新重置（服务端值权威）
  const [overlay, setOverlay] = useState<LessonOverlay | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: data 是覆盖层与已解锁提示重置的变更键（effect 体不直接读取，start 数据身份变化必须重置）
  useEffect(() => {
    setOverlay(null);
  }, [data]);
  const released = useMemo(
    () =>
      overlay === null
        ? data.released
        : { ...data.released, ...overlay.released },
    [data.released, overlay],
  );
  const summary = overlay?.summary ?? data.summary;
  const attempt = overlay?.attempt ?? data.attempt;

  const unlockHint = useCallback(
    (questionId: string, entry: HintOpenedEntry) => {
      attemptEvents.trackHintUnlock(questionId, entry.index);
      attemptEvents.noteInteraction(questionId);
      setHintsOpened((prev) => ({
        ...prev,
        [questionId]: [...(prev[questionId] ?? []), entry].sort(
          (a, b) => a.index - b.index,
        ),
      }));
    },
    [attemptEvents],
  );

  const registerCard = attemptEvents.registerCard;

  /** 追平草稿与答案（单题提交/整卷收尾共用的前置步骤） */
  const settleDrafts =
    useCallback(async (): Promise<LessonSubmitOutcome | null> => {
      try {
        await draftSync.syncNow();
        await flushAnswers();
        return null;
      } catch (err) {
        return {
          kind: "error",
          message: messageOf(err, "答案尚未保存，请检查网络后重试"),
        };
      }
    }, [draftSync.syncNow, flushAnswers]);

  /** 单题证据组装（复用整卷 prepareSubmitEvidence 的单题化调用） */
  const prepEvidence = useCallback(
    async (
      ids: readonly string[],
      allowMissing?: ReadonlySet<string>,
    ): Promise<SubmitEvidencePrep | LessonSubmitOutcome> => {
      try {
        return await prepareSubmitEvidence({
          attemptId,
          questionIds: ids,
          ...(allowMissing !== undefined ? { allowMissing } : {}),
        });
      } catch (err) {
        return {
          kind: "error",
          message: messageOf(err, "草稿状态获取失败，请检查网络后重试"),
        };
      }
    },
    [attemptId],
  );

  const submit = useCallback(
    async (
      questionId: string,
      opts?: { allowMissing?: boolean },
    ): Promise<LessonSubmitOutcome> => {
      const question = data.questions.find((item) => item.id === questionId);
      if (question === undefined) {
        return { kind: "error", message: "这道题不在本次练习中，请刷新页面" };
      }
      // 手写题笔迹先行（同整卷「交卷前强制上传」口径的单题化）
      const controller = inkControllers.current.get(questionId);
      if (controller !== undefined && !(await controller.flush())) {
        return {
          kind: "error",
          message: "手写内容还没有上传完成，请稍后重试",
        };
      }
      const settled = await settleDrafts();
      if (settled !== null) return settled;
      const prep = await prepEvidence(
        [questionId],
        opts?.allowMissing ? new Set([questionId]) : undefined,
      );
      if ("kind" in prep) return prep;
      if (prep.declarations === null) {
        return { kind: "problems", problems: prep.problems };
      }
      try {
        const result = await submitLessonQuestionApi(attemptId, questionId, {
          questionRevisionId: question.questionRevisionId,
          evidence: prep.declarations[0],
        });
        setOverlay((prev) => ({
          released: {
            ...(prev?.released ?? {}),
            [questionId]: result.question,
          },
          summary: result.summary,
          attempt: result.attempt,
        }));
        // 最后一题单题提交在服务端事务内自动收尾（attempt 离开 draft）——
        // 重新拉 start 让页面收敛到权威完成态（覆盖层兜底渲染完成视图）
        if (result.attempt.status !== "draft") {
          void refetch();
        }
        return { kind: "submitted" };
      } catch (err) {
        if (isAlreadySubmittedError(err)) {
          // 已提交过（旧响应迟到/他端已交）：静默收敛——重新拉 start，
          // 题卡随 released 转结果态，不弹错误
          void refetch();
          return { kind: "submitted" };
        }
        if (isStaleError(err)) {
          return { kind: "stale", message: "页面内容已过期，请刷新后重试" };
        }
        return {
          kind: "error",
          message: messageOf(err, "提交失败，请稍后重试"),
        };
      }
    },
    [attemptId, data.questions, prepEvidence, refetch, settleDrafts],
  );

  /** 完成练习（整卷收尾）：revisions 回传全集（含已单题提交行），evidence 只按未提交题 */
  const finish = useCallback(
    async (opts?: {
      allowMissing?: ReadonlySet<string>;
    }): Promise<LessonSubmitOutcome> => {
      // 已提交题的 HandwrittenControls 已随题卡锁定卸载——注册表内只剩未提交题
      const inkResults = await Promise.all(
        [...inkControllers.current.values()].map((controller) =>
          controller.flush(),
        ),
      );
      if (!inkResults.every(Boolean)) {
        return {
          kind: "error",
          message: "手写内容还没有上传完成，请稍后重试",
        };
      }
      const settled = await settleDrafts();
      if (settled !== null) return settled;
      const unsubmitted = questionIds.filter(
        (questionId) => !(questionId in released),
      );
      const prep = await prepEvidence(unsubmitted, opts?.allowMissing);
      if ("kind" in prep) return prep;
      if (prep.declarations === null) {
        return { kind: "problems", problems: prep.problems };
      }
      // 交卷前收尾事件（尽力 flush；失败不阻塞，宽松口径兜底迟到事件）
      await attemptEvents.finalizeSubmit();
      try {
        await submitAttemptApi(
          attemptId,
          data.questions.map((question) => ({
            questionId: question.id,
            questionRevisionId: question.questionRevisionId,
          })),
          prep.declarations,
        );
        await draftStore.clearDraft(attemptId);
        // 收敛到完成态：start 幂等取回已完成卷（released 全量 + summary）
        await refetch().catch(() => undefined);
        return { kind: "submitted" };
      } catch (err) {
        if (isAlreadySubmittedError(err)) {
          await refetch().catch(() => undefined);
          return { kind: "submitted" };
        }
        if (isStaleError(err)) {
          return { kind: "stale", message: "页面内容已过期，请刷新后重试" };
        }
        return {
          kind: "error",
          message: messageOf(err, "交卷失败，请稍后重试"),
        };
      }
    },
    [
      attemptEvents,
      attemptId,
      data.questions,
      refetch,
      prepEvidence,
      questionIds,
      released,
      settleDrafts,
    ],
  );

  const handlers = useMemo<LessonQuestionHandlers>(
    () => ({
      onAnswer: (questionId, answer, defer) =>
        setAnswer(questionId, answer, defer ?? false),
      onHintUnlocked: unlockHint,
      registerInkController,
      registerCard,
      submit,
    }),
    [registerInkController, setAnswer, submit, unlockHint, registerCard],
  );

  return {
    attemptId,
    attempt,
    released,
    summary,
    answers,
    setAnswer,
    hintsOpened,
    saveStatus,
    denied,
    handlers,
    draftSyncContext: draftSync,
    finish,
  };
}

/** 供页面给题卡内 HandwrittenControls 提供 DraftSyncContext（状态联动同答题页） */
