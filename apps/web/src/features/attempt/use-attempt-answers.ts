import type { StudentAnswer } from "@tutor/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { isAnswered } from "./answer-format";
import { saveDraftAnswer } from "./attempt-queries";
import { unsyncedAnswerIds } from "./draft-merge";
import {
  draftStore,
  getDraftPersistenceState,
  getDraftSessionEpoch,
  subscribeDraftPersistence,
} from "./draft-store";
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
 *   同时通知 draftSync 转离线态；
 * - 403/404（T2A.6，D7）：访问权终态——通知 draftSync.noteDenied 停止重试，
 *   本地草稿保留但不再上传。
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
  /** 交卷前收尾防抖与在途请求，最新答案未到服务端时拒绝。 */
  flush(): Promise<void>;
  /**
   * 单题切题前收尾（M3-D3 §11-5）：取消该题防抖并立即发起保存，等待该题
   * **本机**（draftStore）写完成；true=本机落盘成功。服务器结果不阻塞——
   * 离线时已核对题面可正常切题继续作答。
   */
  flushQuestionLocal(questionId: string): Promise<boolean>;
  /**
   * 单题提交前收尾（M3-D3 §11-4）：取消该题防抖并立即保存，只等待**该题**
   * 的在途请求（不等其他题的网络重试）；该题在本机记录仍未同步时重试一次
   * 再判定。true=该题已确认同步到服务端（或有该题冲突/拒绝等不放行情形时
   * 返回 false，由调用方就地提示）。
   */
  flushQuestion(questionId: string): Promise<boolean>;
}

/** useAttemptAnswers 的可选回调集 */
export interface AttemptAnswersOptions {
  /**
   * 一次答案保存生效（立即或防抖到期，即 PUT 发起点）时回调。
   * T2.10：答题页用它上报 answer_change 事件——与保存同节奏，文本键击
   * 天然聚合，changeCount 不虚高（见 use-attempt-events.ts）。
   */
  onAnswerCommitted?: (questionId: string, answer: StudentAnswer) => void;
}

/**
 * @param attemptId attempt id（变化时重置全部本地状态）
 * @param drafts 草稿（T2.9 起传 draftSync.recoveredDrafts：本地与服务端合并结果；
 *   undefined=合并未完成，到位后播种一次）
 * @param sync 草稿同步 API（T2.9：本地写/同步成功/失败通知；缺省不联动——
 *   兼容旧调用与单测）
 * @param options 可选回调（T2.10 onAnswerCommitted）
 */
export function useAttemptAnswers(
  attemptId: string,
  drafts: Record<string, StudentAnswer> | undefined,
  sync?: DraftSyncApi | null,
  options?: AttemptAnswersOptions,
): AttemptAnswersState {
  const [answers, setAnswers] = useState<Record<string, StudentAnswer> | null>(
    null,
  );
  const [saveFailed, setSaveFailed] = useState(false);
  // 播种：drafts 首次到位（或 attemptId 切换后重置再播种）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: setAnswers/setSaveFailed 为 React 稳定引用
  useEffect(() => {
    setAnswers(null);
    setSaveFailed(false);
  }, [attemptId]);
  useEffect(() => {
    if (drafts === undefined) return;
    setAnswers(draftStore.peekAnswers(attemptId) ?? { ...drafts });
  }, [attemptId, drafts]);
  useEffect(
    () =>
      subscribeDraftPersistence(() => {
        const current = draftStore.peekAnswers(attemptId);
        if (current) setAnswers(current);
      }),
    [attemptId],
  );

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
  // T2.10：保存生效回调同样走 ref（事件上报不重建保存链）
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const inFlight = useRef(new Map<string, Set<Promise<boolean>>>());
  const deniedFor = useRef<string | null>(null);

  const save = useCallback((questionId: string, answer: StudentAnswer) => {
    const scope = attemptIdRef.current;
    const epoch = getDraftSessionEpoch();
    const api = syncRef.current;
    // T2.10：与保存同节奏上报 answer_change（防抖/立即提交点各一次）
    optionsRef.current?.onAnswerCommitted?.(questionId, answer);
    // 按题索引在途请求（M3-D3 §11-4）：单题 flush 只等本题，不等其他题重试
    let tasks = inFlight.current.get(questionId);
    if (tasks === undefined) {
      tasks = new Set();
      inFlight.current.set(questionId, tasks);
    }
    const task: Promise<boolean> = saveDraftAnswer(scope, questionId, answer)
      .then(async (receipt) => {
        if (epoch !== getDraftSessionEpoch()) return false;
        await draftStore.markAnswerSynced(
          scope,
          questionId,
          answer,
          receipt?.revision,
        );
        if (attemptIdRef.current !== scope) return true;
        setSaveFailed(false);
        // T2.9：答案已到服务端 → 草稿仓记指纹（增量同步去重）+ 顶栏回到已保存
        if (api !== null && api !== undefined) {
          api.noteAnswerSynced(questionId, answer);
        }
        return true;
      })
      .catch((err: unknown) => {
        if (attemptIdRef.current !== scope) return false;
        // 403/404 = 访问权终态（T2A.6，D7）：停止重试循环（区别于网络失败）
        if (
          err instanceof ApiError &&
          (err.status === 403 || err.status === 404)
        ) {
          deniedFor.current = scope;
          api?.noteDenied();
          setSaveFailed(true);
          return false;
        }
        setSaveFailed(true);
        api?.noteSyncFailed();
        return false;
      })
      .finally(() => {
        tasks.delete(task);
      });
    tasks.add(task);
    return task;
  }, []);

  const flush = useCallback(async () => {
    const scope = attemptIdRef.current;
    for (const entry of pendingRef.current.values()) clearTimeout(entry.timer);
    pendingRef.current.clear();
    await Promise.all(
      [...inFlight.current.values()].flatMap((tasks) => [...tasks]),
    );
    if (deniedFor.current === scope)
      throw new Error("已无权限保存答案，请返回首页");
    const record = await draftStore.loadDraft(scope);
    if (Object.keys(record?.answerConflicts ?? {}).length > 0)
      throw new Error("答案存在同步冲突，请先选择保留版本");
    if (attemptIdRef.current !== scope)
      throw new Error("练习已切换，请重新交卷");
    const results = await Promise.all(
      record === null
        ? []
        : unsyncedAnswerIds(record).flatMap((id) => {
            const answer = record.answers[id];
            return answer === undefined ? [] : [save(id, answer)];
          }),
    );
    if (!results.every(Boolean))
      throw new Error("答案尚未保存，请检查网络后重试交卷");
    await draftStore.flush(scope);
  }, [save]);

  /** 取消该题防抖并立即发起保存（按题收尾共用第一步；服务器结果不阻塞） */
  const flushPendingNow = useCallback(
    (questionId: string): void => {
      const entry = pendingRef.current.get(questionId);
      if (entry === undefined) return;
      clearTimeout(entry.timer);
      pendingRef.current.delete(questionId);
      save(questionId, entry.answer);
    },
    [save],
  );

  const flushQuestionLocal = useCallback(
    async (questionId: string): Promise<boolean> => {
      flushPendingNow(questionId);
      try {
        // 本机落盘立即写（清掉 draftStore 300ms 防抖）；服务器结果不等待
        await draftStore.flush(attemptIdRef.current);
      } catch {
        return false;
      }
      return getDraftPersistenceState(attemptIdRef.current) !== "failed";
    },
    [flushPendingNow],
  );

  const flushQuestion = useCallback(
    async (questionId: string): Promise<boolean> => {
      const scope = attemptIdRef.current;
      flushPendingNow(questionId);
      // 只等待该题的在途请求（新请求由本函数自己发起，循环追平）
      const waitOwnInflight = async (): Promise<void> => {
        for (;;) {
          const tasks = inFlight.current.get(questionId);
          if (tasks === undefined || tasks.size === 0) return;
          await Promise.all([...tasks]);
        }
      };
      await waitOwnInflight();
      if (attemptIdRef.current !== scope) return false;
      const record = await draftStore.loadDraft(scope);
      // 待裁决冲突不是「未同步」：需用户先选保留版本，不自动重传内容
      if (record?.answerConflicts?.[questionId] !== undefined) return false;
      const stillUnsynced =
        record !== null &&
        unsyncedAnswerIds(record).includes(questionId) &&
        record.answers[questionId] !== undefined;
      if (!stillUnsynced) return true;
      // 该题上次请求失败：补重试一次再判定（§11-4 不让单题卡死提交流）
      const answer = record.answers[questionId];
      if (answer !== undefined) save(questionId, answer);
      await waitOwnInflight();
      if (attemptIdRef.current !== scope) return false;
      const retried = await draftStore.loadDraft(scope);
      return !(
        retried !== null &&
        unsyncedAnswerIds(retried).includes(questionId) &&
        retried.answers[questionId] !== undefined
      );
    },
    [flushPendingNow, save],
  );

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

  return {
    answers,
    setAnswer,
    answeredCount,
    saveFailed,
    flush,
    flushQuestionLocal,
    flushQuestion,
  };
}
