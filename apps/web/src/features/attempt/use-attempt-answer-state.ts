import type {
  AttemptDraftData,
  AttemptQuestionPublic,
  HintOpenedEntry,
  PracticeQuestionProgress,
  StudentAnswer,
} from "@tutor/contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QuestionProcessRecorder } from "@/features/question-process/recorder";
import { setStudentFlagApi } from "@/lib/api";
import type { QuestionNavigationItem } from "./QuestionNavigator";
import { getQuestionCompletion } from "./question-completion";
import type { AttemptAnswersState } from "./use-attempt-answers";
import { useAttemptAnswers } from "./use-attempt-answers";
import type { AttemptEventsApi } from "./use-attempt-events";
import type { DraftSyncApi } from "./use-draft-sync";
import { useWorkspaceFlags } from "./use-workspace-flags";

/**
 * 作答状态 hook（阶段 B 做题工作区改版，2026-11，从 AttemptSession.AnswerView
 * 抽出）：把「学生在这张卷上写了什么、标了什么」收成一处——
 * - 答案（useAttemptAnswers：本地草稿仓 + 增量同步，保存生效点报埋点）；
 * - 已解锁提示（随 data 刷新回填；解锁成功回调报 directive_interact 与聚焦）；
 * - 本机「待检查」标记（useWorkspaceFlags，localStorage）；
 * - 服务端「不会」标记（#6980-4：乐观更新、失败回滚，不阻塞作答与提交）；
 * - 正式手写笔迹是否存在（题卡回报；影响完成度判定与导航点阵）。
 * 行为与抽出前逐字一致：只搬运，不改语义；提交编排见 use-attempt-submit，
 * 计时见 use-attempt-timer。
 */
export interface AttemptAnswerState {
  answers: AttemptAnswersState["answers"];
  /** 原始草稿写入（不经做题过程录制；录制版见 useRecordedAnswerSetter） */
  setDraftAnswer: AttemptAnswersState["setAnswer"];
  saveFailed: boolean;
  flushAnswers: AttemptAnswersState["flush"];
  flushQuestion: AttemptAnswersState["flushQuestion"];
  flushQuestionLocal: AttemptAnswersState["flushQuestionLocal"];
  hintsOpened: Record<string, HintOpenedEntry[]>;
  unlockHint: (questionId: string, entry: HintOpenedEntry) => void;
  /** 本机「待检查」标记 */
  flaggedQuestions: ReadonlySet<string>;
  toggleFlag: (questionId: string) => void;
  /** 服务端「不会」标记 */
  studentFlags: ReadonlySet<string>;
  toggleUnsure: (questionId: string) => void;
  formalInkPresence: ReadonlyMap<string, boolean>;
  onInkPresenceChange: (questionId: string, present: boolean) => void;
}

export function useAttemptAnswerState({
  attemptId,
  data,
  draftSync,
  attemptEvents,
}: {
  attemptId: string;
  data: AttemptDraftData;
  draftSync: DraftSyncApi;
  attemptEvents: AttemptEventsApi;
}): AttemptAnswerState {
  const {
    answers,
    setAnswer: setDraftAnswer,
    saveFailed,
    flush: flushAnswers,
    flushQuestion,
    flushQuestionLocal,
  } = useAttemptAnswers(attemptId, draftSync.recoveredDrafts, draftSync, {
    // 保存生效点：聚焦切到该题 + answer_change 事件（from=上次上报值）
    onAnswerCommitted: (questionId, answer) => {
      attemptEvents.noteInteraction(questionId);
      attemptEvents.trackAnswerChange(questionId, answer);
    },
  });

  const [hintsOpened, setHintsOpened] = useState<
    Record<string, HintOpenedEntry[]>
  >(() => data.hintsOpened);
  useEffect(() => {
    setHintsOpened(data.hintsOpened);
  }, [data]);
  const unlockHint = useCallback(
    (questionId: string, entry: HintOpenedEntry) => {
      // T4.0b：解锁成功回调报 directive_interact{host:question, hint, open}——
      // index 与 hint_open 服务端直记同口径（entry.index 为解锁接口返回值），
      // 失败重试不触发本回调（HintPanel 只在成功后 onUnlocked），无双报
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

  const { flags: flaggedQuestions, toggle: toggleFlag } =
    useWorkspaceFlags(attemptId);

  // #6980-4：服务端「不会」标记（draft 限定，交卷后只读）。乐观更新、失败
  // 回滚——标记只影响错题本归档口径，不阻塞作答与提交
  const [studentFlags, setStudentFlags] = useState<ReadonlySet<string>>(
    () => new Set(Object.keys(data.studentFlags ?? {})),
  );
  const toggleUnsure = useCallback(
    (questionId: string) => {
      const next = new Set(studentFlags);
      const flag: "unsure" | null = next.has(questionId) ? null : "unsure";
      if (flag === null) next.delete(questionId);
      else next.add(questionId);
      setStudentFlags(next);
      setStudentFlagApi(attemptId, questionId, flag).catch(() => {
        setStudentFlags((previous) => {
          const rollback = new Set(previous);
          if (flag === null) rollback.add(questionId);
          else rollback.delete(questionId);
          return rollback;
        });
      });
    },
    [attemptId, studentFlags],
  );

  const [formalInkPresence, setFormalInkPresence] = useState<
    ReadonlyMap<string, boolean>
  >(new Map());
  const onInkPresenceChange = useCallback(
    (questionId: string, present: boolean) => {
      setFormalInkPresence((previous) => {
        if (previous.get(questionId) === present) return previous;
        const next = new Map(previous);
        next.set(questionId, present);
        return next;
      });
    },
    [],
  );

  return {
    answers,
    setDraftAnswer,
    saveFailed,
    flushAnswers,
    flushQuestion,
    flushQuestionLocal,
    hintsOpened,
    unlockHint,
    flaggedQuestions,
    toggleFlag,
    studentFlags,
    toggleUnsure,
    formalInkPresence,
    onInkPresenceChange,
  };
}

/**
 * 带做题过程录制的答案写入（T2.10 / 过程回放）：输入法合成期间的文本答案
 * 先登记到 composition 暂存，compositionend/focusout 后再作为一次事件落账；
 * 非合成态 defer 走 textAnswer（合并连续击键），即时提交走 event。
 * 录制器由 useQuestionProcess 产出（依赖 answers/hintsOpened），因此本 hook
 * 与 useAttemptAnswerState 分离：先有答案状态，再有录制器，最后得到录制版 setAnswer。
 */
export function useRecordedAnswerSetter(
  recorder: QuestionProcessRecorder | null,
  setDraftAnswer: AttemptAnswersState["setAnswer"],
): (id: string, answer: StudentAnswer, defer?: boolean) => void {
  const composition = useRef<{
    answer?: { id: string; value: StudentAnswer };
  } | null>(null);
  useEffect(() => {
    if (!recorder) return;
    const start = () => {
      composition.current = {};
    };
    const end = () => {
      const pending = composition.current;
      if (!pending) {
        recorder.commitText();
        return;
      }
      queueMicrotask(() => {
        if (composition.current !== pending) return;
        composition.current = null;
        if (pending.answer)
          recorder.event(pending.answer.id, {
            kind: "answer",
            answer: pending.answer.value,
          });
      });
    };
    document.addEventListener("compositionstart", start, true);
    document.addEventListener("compositionend", end, true);
    document.addEventListener("focusout", end, true);
    return () => {
      composition.current = null;
      document.removeEventListener("compositionstart", start, true);
      document.removeEventListener("compositionend", end, true);
      document.removeEventListener("focusout", end, true);
    };
  }, [recorder]);
  return useCallback(
    (id: string, answer: StudentAnswer, defer?: boolean) => {
      if (defer && composition.current) {
        recorder?.begin(id);
        composition.current.answer = { id, value: answer };
      } else if (defer) {
        recorder?.textAnswer(id, answer);
      } else {
        recorder?.event(id, { kind: "answer", answer });
      }
      setDraftAnswer(id, answer, defer);
    },
    [recorder, setDraftAnswer],
  );
}

/** 题号导航项 + 已答/未答计数（题号导航左栏、底部上滑面板、底栏、交卷弹层共用单源） */
export interface AttemptNavigationSummary {
  items: QuestionNavigationItem[];
  answered: number;
  unanswered: number;
  /** 首道未填写完整的题（交卷前「一键去补答」目标；全部已填为 null） */
  firstIncompleteId: string | null;
}

export function useAttemptNavigationItems({
  flatQuestions,
  answers,
  formalInkPresence,
  flaggedQuestions,
  studentFlags,
  practiceProtocol,
  progressById,
}: {
  flatQuestions: readonly AttemptQuestionPublic[];
  answers: Record<string, StudentAnswer> | null;
  formalInkPresence: ReadonlyMap<string, boolean>;
  flaggedQuestions: ReadonlySet<string>;
  studentFlags: ReadonlySet<string>;
  practiceProtocol: "v1" | "legacy";
  progressById: ReadonlyMap<string, PracticeQuestionProgress>;
}): AttemptNavigationSummary {
  return useMemo(() => {
    const items = flatQuestions.map((question, index) => ({
      id: question.id,
      index,
      completion: getQuestionCompletion(
        question,
        answers?.[question.id],
        formalInkPresence.get(question.id),
      ),
      flagged: flaggedQuestions.has(question.id),
      unsure: studentFlags.has(question.id),
      // v1 卷四态口径（§9.1）：progress 缺行按未提交处理；统一公布模式下
      // feedbackReadable=false 的已提交行在导航里只报提交事实，不显示对错。
      // 用回执 overlay 后的进度（practiceProgress）——提交即时反映，不等服务端重取
      ...(practiceProtocol === "v1"
        ? {
            practice: {
              submitted:
                (progressById.get(question.id)?.submittedAt ?? null) !== null,
              feedbackReadable:
                progressById.get(question.id)?.feedbackReadable ?? false,
            },
          }
        : {}),
    }));
    const answered = items.filter(
      (item) => item.completion.state === "filled",
    ).length;
    const firstIncomplete = items.find(
      (item) => item.completion.state !== "filled",
    );
    return {
      items,
      answered,
      unanswered: items.length - answered,
      firstIncompleteId: firstIncomplete?.id ?? null,
    };
  }, [
    flatQuestions,
    answers,
    formalInkPresence,
    flaggedQuestions,
    studentFlags,
    practiceProtocol,
    progressById,
  ]);
}
