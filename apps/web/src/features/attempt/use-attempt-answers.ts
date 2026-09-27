import type { StudentAnswer } from "@tutor/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { isAnswered } from "./answer-format";
import { saveDraftAnswer } from "./attempt-queries";
import { draftStore } from "./draft-store";
import type { DraftSyncApi } from "./use-draft-sync";

/**
 * 答题页的答案状态与草稿保存（T2.6；T2.9 接入本地草稿仓）：
 * - 初始化：合并后的草稿（draftSync.recoveredDrafts，本地 ∪ 服务端）首次到位时
 *   播种本地状态（每个 attempt 一次）；
 * - 更新：离散控件（判断/单选/多选）立即保存；文本输入（填空/最终答案）按
 *   DEBOUNCE_MS 防抖保存，避免每个键击一个请求；
 * - 本地写（T2.9）：每次 setAnswer 同步写 IndexedDB（draftStore.saveAnswer，
 *   不受网络状态影响），随后才走服务端 PUT；
 * - 卸载：flush 未落防抖窗的最新答案（防跳页丢最后一次输入）；
 * - 失败：saveFailed 置位供底栏提示「保存失败，请检查网络」（不阻塞作答）；
 *   同时通知 draftSync 转离线态。
 */

/** 文本类输入的防抖窗（毫秒） */
const DEBOUNCE_MS = 600;

export interface AttemptAnswersState {
  /** 本地答案表（questionId → StudentAnswer）；null = 详情未到位、不可作答 */
  answers: Record<string, StudentAnswer> | null;
  /** 更新一题答案；defer=true 走防抖（文本输入），缺省立即保存（离散控件） */
  setAnswer: (
    questionId: string,
    answer: StudentAnswer,
    defer?: boolean,
  ) => void;
  /** 已作答题数（isAnswered 口径） */
  answeredCount: (questionIds: readonly string[]) => number;
  /** 最近一次保存是否失败（底栏提示用） */
  saveFailed: boolean;
}

/**
 * @param attemptId attempt id（变化时重置全部本地状态）
 * @param drafts 草稿（T2.9 起传 draftSync.recoveredDrafts：本地与服务端合并结果；
 *   undefined=合并未完成，到位后播种一次）
 * @param sync 草稿同步 API（T2.9：本地写/同步成功/失败通知；缺省不联动——
 *   兼容旧调用与单测）
 */
export function useAttemptAnswers(
  attemptId: string,
  drafts: Record<string, StudentAnswer> | undefined,
  sync?: DraftSyncApi | null,
): AttemptAnswersState {
  const [answers, setAnswers] = useState<Record<string, StudentAnswer> | null>(
    null,
  );
  const [saveFailed, setSaveFailed] = useState(false);
  /** 已播种的 attemptId（T2.9：恢复是异步的，播种只做一次；
   *  用函数式合并而非整体覆盖——播种与用户作答在同批更新竞争时，已答内容优先） */
  const seededForRef = useRef<string | null>(null);

  // 播种：drafts 首次到位（或 attemptId 切换后重置再播种）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: setAnswers/setSaveFailed 为 React 稳定引用
  useEffect(() => {
    setAnswers(null);
    setSaveFailed(false);
  }, [attemptId]);
  useEffect(() => {
    if (drafts === undefined || seededForRef.current === attemptId) return;
    seededForRef.current = attemptId;
    setAnswers((prev) => ({ ...drafts, ...(prev ?? {}) }));
  }, [attemptId, drafts]);

  // 防抖窗与最新待存值（questionId → { answer, timer }）
  const pendingRef = useRef(
    new Map<
      string,
      { answer: StudentAnswer; timer: ReturnType<typeof setTimeout> }
    >(),
  );
  // attemptId 可能变化：保存函数永远用最新值
  const attemptIdRef = useRef(attemptId);
  attemptIdRef.current = attemptId;
  // sync 存 ref：内联回调不重建保存链
  const syncRef = useRef(sync);
  syncRef.current = sync;

  const save = useCallback((questionId: string, answer: StudentAnswer) => {
    saveDraftAnswer(attemptIdRef.current, questionId, answer)
      .then(() => {
        setSaveFailed(false);
        // T2.9：答案已到服务端 → 草稿仓记指纹（增量同步去重）+ 顶栏回到已保存
        const api = syncRef.current;
        if (api !== null && api !== undefined) {
          void draftStore.markAnswerSynced(
            attemptIdRef.current,
            questionId,
            answer,
          );
          api.noteAnswerSynced(questionId, answer);
        }
      })
      .catch(() => {
        setSaveFailed(true);
        syncRef.current?.noteSyncFailed();
      });
  }, []);

  const setAnswer = useCallback(
    (questionId: string, answer: StudentAnswer, defer = false) => {
      setAnswers((prev) => {
        const base = prev ?? {};
        return { ...base, [questionId]: answer };
      });
      // T2.9：先写本地 IndexedDB（网络无关），顶栏转「保存中」
      draftStore.saveAnswer(attemptIdRef.current, questionId, answer);
      syncRef.current?.noteLocalWrite();
      const current = pendingRef.current.get(questionId);
      if (current !== undefined) clearTimeout(current.timer);
      if (!defer) {
        pendingRef.current.delete(questionId);
        save(questionId, answer);
        return;
      }
      const timer = setTimeout(() => {
        pendingRef.current.delete(questionId);
        save(questionId, answer);
      }, DEBOUNCE_MS);
      pendingRef.current.set(questionId, { answer, timer });
    },
    [save],
  );

  // 卸载 flush：把仍在防抖窗里的最新答案立即保存（attemptId 引用最新值）
  useEffect(() => {
    const pending = pendingRef;
    return () => {
      for (const [questionId, entry] of pending.current) {
        clearTimeout(entry.timer);
        save(questionId, entry.answer);
      }
      pending.current.clear();
    };
  }, [save]);

  const answeredCount = useCallback(
    (questionIds: readonly string[]) => {
      if (answers === null) return 0;
      return questionIds.filter((id) => isAnswered(answers[id])).length;
    },
    [answers],
  );

  return { answers, setAnswer, answeredCount, saveFailed };
}
