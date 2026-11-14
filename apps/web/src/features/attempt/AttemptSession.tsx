import { isResultDetail } from "@/features/attempt/attempt-result-detail";

export { isResultDetail } from "@/features/attempt/attempt-result-detail";

import type {
  AttemptDraftData,
  HintOpenedEntry,
  MaterialRef,
  StudentAnswer,
} from "@tutor/contract";
import {
  ClipboardCheck,
  ListChecks,
  RotateCw,
  SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { catchUpAnnotations } from "@/features/annotation/annotation-sync";
import { CoordinatedAnnotationProvider } from "@/features/annotation/coordinated-annotation-context";
import {
  AttemptEditorProvider,
  useAttemptEditor,
} from "@/features/answering/AttemptEditorContext";
import { questionBindings } from "@/features/answering/question-binding";
import { AttemptHeader } from "@/features/attempt/AttemptHeader";
import { AttemptQuestionRow } from "@/features/attempt/AttemptQuestionRow";
import { TimedAttemptControls } from "@/features/attempt/AttemptTimer";
import { useAttemptPhase } from "@/features/attempt/attempt-clock";
import {
  groupSegmentsOfUnit,
  questionMaterialsOf,
} from "@/features/attempt/attempt-context-view";
import { useAttemptAnswers } from "@/features/attempt/use-attempt-answers";
import { useAttemptEvents } from "@/features/attempt/use-attempt-events";
import { useAttemptForcedMounts } from "@/features/attempt/use-attempt-forced-mounts";
import { useKeyboardBindings } from "@/features/keyboard/keyboard-binding-store";
import { useKeyboardDevice } from "@/features/keyboard/keyboard-device";
import { useLearningContextPublisher } from "@/features/learning-context/use-learning-context-publisher";
import { catchUpNotes } from "@/features/notes/note-sync";
import { AttemptSessionScope } from "@/features/persistence/AttemptSnapshotScope";
import {
  attemptMaterialsEditable,
  recoverAttemptMaterials,
  useAttemptMaterialRecovery,
} from "@/features/persistence/attempt-material-recovery";
import { getDraftSessionEpoch } from "@/features/persistence/draft-store";
import { prepareDraftForPwaUpdate } from "@/features/persistence/pwa-draft-safety";
import {
  DraftSyncProvider,
  useDraftSync,
} from "@/features/persistence/use-draft-sync";
import type { InkUploadController } from "@/features/persistence/use-ink-upload";
import type { QuestionProcessRecorder } from "@/features/question-process/recorder";
import {
  QuestionProcessSyncNotice,
  useQuestionProcess,
} from "@/features/question-process/session";
import { usePortalClients } from "@/features/runtime/portal-runtime";
import { useAiCompanionDock } from "@/features/student-ai/AiCompanionDock";
import { AiQueueButton } from "@/features/student-ai/AiQueueButton";
import { useAiCompareActive } from "@/features/student-ai/ai-companion-layout";
import { usePwaUpdateGuard } from "@/lib/pwa-update-safety";
import { useOnlineStatus } from "@/lib/use-online-status";
import { AttemptPartialControls } from "./AttemptPartialControls";
import { AttemptProcessDialog } from "./AttemptProcessDialog";
import { AttemptResultLoader } from "./AttemptResultLoader";
import { AttemptSaveDetails } from "./AttemptSaveDetails";
import { AttemptSessionActions } from "./AttemptSessionActions";
import {
  AttemptSessionNavigator,
  AttemptSessionSubmitDialogs,
} from "./AttemptSessionDialogs";
import { AttemptSourceSummary } from "./AttemptSourceSummary";
import { AttemptSyncConflicts } from "./AttemptSyncConflicts";
import { AttemptWorkspace } from "./AttemptWorkspace";
import { attemptNavigationItemsOf } from "./attempt-navigation-items";
import {
  type TimedAttemptDetail,
  useAttemptContext,
  useUpdateAttemptWorkflow,
} from "./attempt-queries";
import { attemptQuestionViewOf } from "./attempt-question-view";
import { useGroupMaterialLayout } from "./group-material-layout-store";
import { LazyMountWindow } from "./lazy-mount-window";
import { PracticeQuestionFooter } from "./PracticeQuestionSubmit";
import {
  PracticeKeyboardHelpDialog,
  PracticeKeyboardHelpMenuItem,
  PracticeModeDialog,
} from "./PracticeWorkspace";
import { countSubmittedQuestions } from "./practice-protocol";
import { QuestionGroupAnchor } from "./QuestionGroupAnchor";
import { QuestionMaterialsAnchor } from "./QuestionMaterialsAnchor";
import { useAttemptPracticeSubmission } from "./use-attempt-practice-submission";
import { useAttemptQuestionLocation } from "./use-attempt-question-location";
import {
  useAttemptQuestionNavigation,
  useAttemptWorkspaceKeyboard,
} from "./use-attempt-question-navigation";
import {
  retryAttemptLocalPersistence,
  useAttemptSaveStatus,
} from "./use-attempt-save-status";
import { useAttemptSubmitConfirmation } from "./use-attempt-submit-confirmation";
import { usePracticeQuestionSubmit } from "./use-practice-question-submit";
import {
  attemptReadingResume,
  useReadingPosition,
} from "./use-reading-position";

/**
 * 题卡视口懒挂载的启用阈值（性能：大量习题加载卡顿，2026-10-28）。
 * 大卷（>20 题）才按视口懒挂载：小卷保持全量挂载语义——题卡 DOM 完整，
 * 页内查找、外部锚点滚动、既有全链 e2e 的「开卷全量可见」前提都不变；
 * 懒挂载的收益本来就集中在百题级长卷（首卡 7.0s→1.7s）。
 */
const ATTEMPT_LAZY_MOUNT_THRESHOLD = 20;

import { Button } from "@/components/ui/button";
import { useWorkspaceFlags } from "./use-workspace-flags";

/** 详情 data 是否结果视图（submitted/graded） */

/**
 * 答题会话（T2A.6 通用化，D9 两种来源共用）：
 * /s/assignments/:id（作业入口）与 /s/attempts/:attemptId（课程练习和历次回看）
 * 在创建或取回 attempt 后渲染同一组件。
 * - 顶部标注来源与作业截止时间，限时卷单独显示倒计时。
 * - 草稿进入答题视图，已交卷进入结果视图。
 * - 草稿同步失去访问权（D7）时收起交卷入口。
 *
 * 交卷准备阶段（T6R.10 A-4）使用判别联合，一次迁移到准备、缺稿确认或错误态。
 * 本页与讲练页共用 use-submit-evidence-confirm 状态机，整卷编排由
 * useAttemptSubmitFlow 注入。
 */

export function AttemptSession({
  data,
  onExit,
  exitLabel,
  onRefresh,
}: {
  data: TimedAttemptDetail;
  /** 退出（返回首页/课程等；结果视图按钮与空试卷兜底用） */
  onExit: () => void;
  exitLabel?: string | undefined;
  /** 刷新数据回调（截止倒计时到期时自动重查结果） */
  onRefresh?: (() => void) | undefined;
}) {
  /**
   * T6R.20 审查修复 2：交卷后的标注封存警示（seal 挪到交卷成功回调内
   * 非阻断执行）。状态放在本组件（答题↔结果视图切换时实例稳定不丢），
   * 由 AnswerView 的交卷成功回调写入、结果视图顶部横幅呈现。
   */
  const [annotationSealWarning, setAnnotationSealWarning] = useState(false);
  return (
    <AttemptSessionScope data={data}>
      {isResultDetail(data) ? (
        <AttemptResultLoader
          key={data.attempt.id}
          data={data}
          onBackHome={onExit}
          backLabel={exitLabel}
          annotationSealWarning={annotationSealWarning}
          onRefresh={onRefresh}
        />
      ) : (
        <AttemptEditorProvider key={data.attempt.id}>
          <CoordinatedAnnotationProvider>
            <AnswerView
              key={data.attempt.id}
              data={data}
              attemptId={data.attempt.id}
              onBackHome={onExit}
              onAnnotationSealFailed={() => setAnnotationSealWarning(true)}
            />
          </CoordinatedAnnotationProvider>
        </AttemptEditorProvider>
      )}
    </AttemptSessionScope>
  );
}

/** 答题视图（draft）：题卡 + 吸底操作条 + 交卷确认（T2.9：本地草稿仓 + 增量同步） */
function AnswerView({
  data,
  attemptId,
  onBackHome,
  onAnnotationSealFailed,
}: {
  data: AttemptDraftData & { clockAnchor?: number };
  attemptId: string;
  onBackHome: () => void;
  /** 交卷成功后的标注 seal 失败回调（非阻断警示——AttemptSession 顶态） */
  onAnnotationSealFailed: () => void;
}) {
  const { setStudentFlagApi } = usePortalClients();

  const editor = useAttemptEditor(null);
  // 模块 2 限时测试：服务端时钟；到时（grace/locked）锁编辑、停自动提交，只留交卷
  const phase = useAttemptPhase(data.timing, data.clockAnchor);
  const timeUp = phase !== null && phase !== "running";
  const savedOnly = phase === "locked";
  const { flatQuestions, questionIds, showUnitHeaders, questionRevisions } =
    useMemo(() => attemptQuestionViewOf(data.units), [data.units]);
  /** 手写题的笔迹上传 controller（mount 注册、unmount 注销；交卷前逐题 flush，
   *  草稿同步循环也会逐题 sync——先声明再传给 useDraftSync） */
  const inkControllers = useRef(new Map<string, InkUploadController>());
  // T6R.9 草稿会话绑定已上提 StudentLayout（T6R.11 复审）：离开答题页不
  // reset——收起题卡/路由切换后同步队列照常完成；登出在 student-auth 统一 reset
  const registerInkController = useCallback(
    (questionId: string, controller: InkUploadController | null) => {
      if (controller === null) inkControllers.current.delete(questionId);
      else inkControllers.current.set(questionId, controller);
    },
    [],
  );
  // 草稿防丢（T2.9）：合并本地与服务端草稿 + 10 秒/切后台/断网恢复增量同步
  const draftSync = useDraftSync(
    attemptId,
    data.drafts,
    inkControllers,
    data.draftRevisions,
    savedOnly,
  );
  // 学习痕迹埋点（T2.10）：attempt_start/聚焦/answer_change/ink/page_*/submit
  const processRecorderRef = useRef<QuestionProcessRecorder | null>(null);
  const attemptEvents = useAttemptEvents(attemptId, processRecorderRef);
  const {
    answers,
    setAnswer: setDraftAnswer,
    saveFailed,
    flush: flushAnswers,
    flushQuestion,
    flushQuestionLocal,
  } = useAttemptAnswers(attemptId, draftSync.recoveredDrafts, draftSync, {
    writesLocked: savedOnly,
    questionRevisions,
    // 保存生效点：聚焦切到该题 + answer_change 事件（from=上次上报值）
    onAnswerCommitted: (questionId, answer) => {
      attemptEvents.noteInteraction(questionId);
      attemptEvents.trackAnswerChange(questionId, answer);
    },
  });
  // 材料与题目分栏比例（35%~65%，默认 50%）
  const [splitRatio, setSplitRatio] = useState<number>(50);
  const [groupMaterialLayout, setGroupMaterialLayout] =
    useGroupMaterialLayout();
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
  // 反馈节奏切换（M5-D3）：PATCH CAS + 详情失效；禁用只按服务端投影
  const feedbackUpdate = useUpdateAttemptWorkflow(attemptId);

  const total = flatQuestions.length;
  const materialRecovery = useAttemptMaterialRecovery(attemptId, questionIds);
  const processReady =
    attemptMaterialsEditable(materialRecovery) && answers !== null;
  const questionProcess = useQuestionProcess({
    attemptId,
    enabled: data.attempt.sourceType === "course",
    ready: processReady,
    questions: flatQuestions,
    answers,
    hintsOpened,
  });
  const recorder = questionProcess.recorder;
  processRecorderRef.current = recorder;
  useEffect(() => {
    if (recorder && processReady) attemptEvents.syncProcessFocus();
  }, [attemptEvents, recorder, processReady]);
  const [processOpen, setProcessOpen] = useState(false);
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
  const setAnswer = useCallback(
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
  usePwaUpdateGuard(
    () =>
      prepareDraftForPwaUpdate(
        attemptId,
        async () => {
          if (
            answers === null ||
            draftSync.recoveryError ||
            materialRecovery.state !== "ready"
          )
            throw new Error("作答与材料恢复尚未完成，请先处理后更新");
          if (draftSync.status.state === "denied")
            throw new Error("作答保存权限已变化，请先处理后更新");
          await flushAnswers();
        },
        true,
      ),
    `${getDraftSessionEpoch()}:attempt:${attemptId}`,
  );
  // QM-08：冻结上下文（材料/组快照）——共享材料渲染数据源；错误非阻断（题面
  // 不依赖本载荷），就地提示 + 重试
  const contextQuery = useAttemptContext(attemptId);
  /** AI 侧栏对照激活 → 组段呈现回退上下排布（与题卡草稿「自动」布局同款信号） */
  const compareActive = useAiCompareActive();
  /** 「查看材料」reveal 信号（组 id / 题级材料的题 id → 递增计数；锚点滚入恢复） */
  const [materialReveal, setMaterialReveal] = useState<Record<string, number>>(
    {},
  );
  const openGroupMaterial = useCallback((groupId: string) => {
    setMaterialReveal((previous) => ({
      ...previous,
      [groupId]: (previous[groupId] ?? 0) + 1,
    }));
  }, []);
  const [modeSettingsOpen, setModeSettingsOpen] = useState(false);
  const [saveDetailsOpen, setSaveDetailsOpen] = useState(false);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  // 快捷键帮助弹层（M3-D3 §9.2）：状态在菜单子树外——菜单项选中后菜单
  // 内容整树卸载，弹层不能寄居其中
  const [keyboardHelpOpen, setKeyboardHelpOpen] = useState(false);
  const [currentQuestionId, setCurrentQuestionId] = useState<string | null>(
    null,
  );
  /** 题号映射（1 起序号——明确选择分支按「第 n 题」呈现问题）；dock 装配
   *  在渲染期即调用 labelOf（绑定后 boundLabel 派生），必须先于装配声明 */
  const questionIndexById = useMemo(
    () =>
      new Map(
        flatQuestions.map((question, i) => [question.id, i + 1] as const),
      ),
    [flatQuestions],
  );
  // SAI-22：AI 伴学装配收进共享 dock（布局 + 发送 + 面板 + 打开绑定），
  // 本页只传身份（attempt/题集）与阶段（当前题/编辑器/材料面）。
  // M4-D2 §12.1：dock 的旧任务定位经 goSingleQuestion 统一切题（装配在
  // goSingleQuestion 定义之前，用 ref 晚绑定打断互引）。
  const goToQuestionRef = useRef<(questionId: string) => Promise<boolean>>(
    async () => true,
  );
  const aiCompanion = useAiCompanionDock({
    attemptId,
    questions: flatQuestions,
    isHandwritten: (questionId) =>
      flatQuestions.some(
        // UA-03：纸面角色经题型绑定（paperRole=answerInk ≡ 旧七型手写资格，
        // question-binding.test 三方一致性锁死，I09 资格逐字不变）
        (question) =>
          question.id === questionId &&
          questionBindings[question.type].paperRole === "answerInk",
      ),
    surfaceOf: (questionId) =>
      cardElements.current
        .get(questionId)
        ?.querySelector<HTMLElement>('[data-slot="question-surface"]') ?? null,
    flush: (questionId) =>
      editor !== null ? editor.flush(questionId) : Promise.resolve(),
    titleOf: (questionId) =>
      `第 ${questionIndexById.get(questionId) ?? "？"} 题 · ${data.title}`,
    labelOf: (questionId) =>
      questionIndexById.has(questionId)
        ? `第 ${questionIndexById.get(questionId)} 题`
        : null,
    currentQuestionId,
    ready:
      materialRecovery.state === "ready" ||
      (materialRecovery.state === "failed" &&
        materialRecovery.verified === true),
    editor,
    goToQuestion: (questionId) => goToQuestionRef.current(questionId),
  });
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
    [attemptId, studentFlags, setStudentFlagApi],
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
  const cardElements = useRef(new Map<string, HTMLLIElement>());
  const mountWindowRef = useRef<LazyMountWindow | null>(null);
  const { forcedMountIds, forceMountQuestion } = useAttemptForcedMounts(
    attemptId,
    mountWindowRef,
    questionIds,
    phase !== null && !savedOnly && draftSync.recoveredDrafts !== undefined,
  );
  // 新挂载的题卡编号版本：判分反馈观察器按它重建观察列表（rAF 合帧——
  // 滚动时一批题同时挂载只触发一次重建）。
  const [cardMountVersion, setCardMountVersion] = useState(0);
  const cardMountFrame = useRef(0);
  const handleCardMounted = useCallback(() => {
    if (cardMountFrame.current !== 0) return;
    cardMountFrame.current = requestAnimationFrame(() => {
      cardMountFrame.current = 0;
      setCardMountVersion((version) => version + 1);
    });
  }, []);
  useEffect(
    () => () => {
      if (cardMountFrame.current !== 0)
        cancelAnimationFrame(cardMountFrame.current);
    },
    [],
  );
  // ---------- 窗口化虚拟列表（性能第三步，2026-10-28） ----------
  // 懒挂载第一版只挂不卸；窗口控制器补两件事：进视口挂载走调度（滚动静默
  // 后就近逐卡挂载、滚动一来让位——首卡关键路径只付一张卡的解析成本，滚动
  // 帧留给浏览器），整行完全离开视口 ±2.5 屏后卸回实测等高占位（Markdown
  // 渲染缓存让重挂免解析，实测高度回填让重挂零位移）。绘制中不卸载等守卫
  // 集中在 retainQuestion。单题模式行不启用懒挂载，控制器闲置无副作用。
  const editorRef = useRef(editor);
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);
  const forcedMountIdsRef = useRef(forcedMountIds);
  useEffect(() => {
    forcedMountIdsRef.current = forcedMountIds;
  }, [forcedMountIds]);
  const retainQuestion = useCallback((questionId: string): boolean => {
    if (forcedMountIdsRef.current.has(questionId)) return true;
    if (inkControllers.current.get(questionId)?.isDirty()) return true;
    const editorStore = editorRef.current;
    if (
      editorStore !== null &&
      (editorStore.getActive()?.questionId === questionId ||
        editorStore.getPaper()?.questionId === questionId)
    )
      return true;
    const element = cardElements.current.get(questionId);
    if (element !== undefined) {
      const active = document.activeElement;
      if (
        active !== null &&
        active !== document.body &&
        element.contains(active)
      )
        return true;
      // 卡内有展开的 UI（对话框/下拉/原生 details/AI 面板内容）不卸载，
      // 不收走用户正看着的面板。
      if (
        element.querySelector(
          '[data-state="open"],details[open],[role="dialog"],[data-ai-question]:not(:empty)',
        ) !== null
      )
        return true;
    }
    return false;
  }, []);
  if (
    mountWindowRef.current === null &&
    questionIds.length > ATTEMPT_LAZY_MOUNT_THRESHOLD
  ) {
    mountWindowRef.current = new LazyMountWindow({
      retain: retainQuestion,
      onSettle: handleCardMounted,
    });
  }
  useEffect(
    () => () => {
      mountWindowRef.current?.dispose();
      mountWindowRef.current = null;
    },
    [],
  );
  const preserveReadingPosition = useReadingPosition(
    attemptId,
    cardElements,
    setCurrentQuestionId,
    forceMountQuestion,
    cardMountVersion,
    attemptReadingResume(data),
  );

  const location = useAttemptQuestionLocation({
    data,
    questionIds,
    currentQuestionId,
  });
  const {
    practiceProtocol,
    practiceWorkflow,
    practiceLayout,
    setPracticeLayoutExplicit,
    keyboardShortcuts,
    singleMode,
    resolvedSingleQuestionId,
    singleIndex,
    singleWorkspaceRef,
  } = location;
  const publisher = useLearningContextPublisher({
    route: attemptId,
    isEditing: (id) =>
      editor?.getActive()?.questionId === id ||
      editor?.getPaper()?.questionId === id,
    surface: "attempt",
    questions: flatQuestions,
    title: data.title,
    attemptStatus: data.attempt.status,
    layout: singleMode ? "single" : "list",
    observedId: singleMode ? resolvedSingleQuestionId : currentQuestionId,
  });
  const keyBindings = useKeyboardBindings();
  const keyboardDevice = useKeyboardDevice();

  const navigatorMaterialsReady =
    answers !== null && attemptMaterialsEditable(materialRecovery);
  // ---------- 逐题提交编排（M3-D2 §10.2/§10.3）：五字段 POST + 回执 overlay +
  // 题级反馈惰性 GET。收笔（编辑器让位确认）→ 该题笔迹 flush → 草稿追平 →
  // 单题证据 → 提交；错误分诊与最后一题不自动 refetch 都在 hook 内。
  const practiceSubmit = usePracticeQuestionSubmit({
    data,
    attemptId,
    questionIds,
    cardElements,
    cardMountVersion,
    singleQuestionId: singleMode ? resolvedSingleQuestionId : null,
    singleMode,
    syncNow: draftSync.syncNow,
    flushQuestion,
    flushQuestionLocal,
    inkControllers,
    beforeSubmit: async () => (editor === null ? true : editor.request(null)),
  });
  const practiceProgress =
    practiceProtocol === "v1" ? practiceSubmit.progress : [];
  // 按题查表：导航项/键盘裁决/题卡渲染多处取行，避免逐题线性 find
  const progressById = new Map(
    practiceProgress.map((row) => [row.questionId, row] as const),
  );
  const submittedPracticeCount = countSubmittedQuestions(practiceProgress);
  const singleProgressRow =
    resolvedSingleQuestionId === null
      ? undefined
      : progressById.get(resolvedSingleQuestionId);
  const confirmation = useAttemptSubmitConfirmation({
    data,
    questions: flatQuestions,
    questionIds,
    practiceProtocol,
    progress: practiceSubmit.progress,
    editor,
    attemptId,
    savedOnly,
    recoveryReady:
      materialRecovery.state === "ready" && !draftSync.recoveryError,
    syncDraft: draftSync.syncNow,
    flushAnswers,
    inkControllers,
    events: attemptEvents,
    onAnnotationSealFailed,
  });
  const { submit, confirmOpen, openSubmitDialog } = confirmation;
  // 离线状态（T2.12）：离线时禁用交卷并提示（作答照常，草稿本地保存）
  const online = useOnlineStatus();
  const saveStatus = useAttemptSaveStatus(
    attemptId,
    questionIds,
    draftSync.status,
    online,
    inkControllers,
    draftSync.recoveryError
      ? { state: "failed", message: draftSync.recoveryError }
      : answers === null
        ? { state: "loading" }
        : materialRecovery,
  );
  const [retryingSave, setRetryingSave] = useState(false);
  const [retrySaveError, setRetrySaveError] = useState<string | null>(null);

  // 访问权终态（T2A.6，D7）：已无权限时收起交卷入口（交卷必然同样被拒）
  const denied = draftSync.status.state === "denied";
  const practiceSubmission = useAttemptPracticeSubmission({
    attemptId,
    practiceSubmit,
    timeUp,
    processRecorderRef,
    setAnswer,
    practiceWorkflow,
    online,
    denied,
    confirmOpen,
    feedbackBusy: feedbackUpdate.isPending,
    progressById,
  });
  const {
    autoSubmitChoice,
    setAutoSubmitChoice,
    canAutoSubmitChoice,
    runPracticeSubmit,
    onAutoChoiceAnswer,
    queuedChoices,
  } = practiceSubmission;
  const singleQuestion = flatQuestions[singleIndex];
  const singleAutoSubmit =
    canAutoSubmitChoice &&
    singleQuestion !== undefined &&
    questionBindings[singleQuestion.type].placement === "options-radio";
  const { navigationItems, answered, unanswered } = attemptNavigationItemsOf({
    flatQuestions,
    answers,
    formalInkPresence,
    flaggedQuestions,
    studentFlags,
    practiceProtocol,
    progressById,
  });
  const navigation = useAttemptQuestionNavigation({
    editor,
    cardElements,
    forceMountQuestion,
    preserveReadingPosition,
    resolvedSingleQuestionId,
    setSingleQuestionId: location.setSingleQuestionId,
    setCurrentQuestionId,
    singleWorkspaceRef,
    singleMode,
    practiceSubmit,
    flushQuestionLocal,
    collapseForNavigation: aiCompanion.collapseForNavigation,
    onNavigate: publisher.explicit,
  });
  const {
    jumpSignal,
    singleSwitchBlocked,
    localSaveRetrying,
    retryBlockedSwitch,
    goSingleQuestion,
    jumpForMode,
  } = navigation;
  // AI 旧任务定位的统一切题入口（M4-D2 §12.1）：单题模式且目标非当前题才
  // 走切题链（列表模式与就地展开直接放行，不触发收笔/收起）。
  goToQuestionRef.current = async (questionId: string) => {
    if (!singleMode || questionId === resolvedSingleQuestionId) return true;
    return goSingleQuestion(questionId);
  };

  const onWorkspaceKeyDown = useAttemptWorkspaceKeyboard({
    singleMode,
    keyboardShortcuts,
    resolvedSingleQuestionId,
    practiceSubmit,
    singleSwitchBlocked,
    editor,
    attemptId,
    questionIds,
    progressById,
    keyBindings,
    cardElements,
    singleWorkspaceRef,
    timeUp,
    practiceWorkflow,
    goSingleQuestion,
    online,
    denied,
    openSubmitDialog,
    singleAutoSubmit,
    runPracticeSubmit,
    setKeyboardHelpOpen,
  });

  // 两种布局共用更多菜单里的做题方式弹窗。
  const practiceModeEditor =
    practiceWorkflow === undefined
      ? null
      : {
          workflow: practiceWorkflow,
          layout: practiceLayout,
          onLayoutChange: setPracticeLayoutExplicit,
          autoSubmitChoice,
          onAutoSubmitChoiceChange: setAutoSubmitChoice,
          onFeedbackModeChange: (mode: typeof practiceWorkflow.feedbackMode) =>
            feedbackUpdate.mutate({
              feedbackMode: mode,
              workflowRevision: practiceWorkflow.revision,
            }),
          feedbackBusy: feedbackUpdate.isPending,
          feedbackError: feedbackUpdate.notice,
        };
  return (
    <DraftSyncProvider value={{ ...draftSync, recovery: materialRecovery }}>
      <AttemptWorkspace process={recorder} learningLease={publisher.lease}>
        <QuestionProcessSyncNotice process={questionProcess} />
        <AttemptProcessDialog
          open={processOpen}
          onOpenChange={setProcessOpen}
          returnFocusRef={moreTriggerRef}
          process={questionProcess}
        />
        {/* 练习资料与保存详情分别从更多菜单打开。 */}
        <AttemptHeader
          title={data.title}
          moreTriggerRef={moreTriggerRef}
          menuItems={
            <>
              {questionProcess.status &&
                questionProcess.status.state !== "unavailable" && (
                  <DropdownMenuItem onSelect={() => setProcessOpen(true)}>
                    做题过程记录
                  </DropdownMenuItem>
                )}
              {singleMode && !practiceSubmit.finished && (
                <DropdownMenuItem
                  disabled={!online || denied || total === 0}
                  onSelect={openSubmitDialog}
                >
                  <ClipboardCheck aria-hidden className="size-4" />
                  提前交卷
                </DropdownMenuItem>
              )}
              {practiceWorkflow !== undefined && (
                <>
                  <DropdownMenuItem onSelect={() => setModeSettingsOpen(true)}>
                    <SlidersHorizontal aria-hidden className="size-4" />
                    做题方式
                  </DropdownMenuItem>
                  {keyboardDevice && (
                    <PracticeKeyboardHelpMenuItem
                      onOpen={() => setKeyboardHelpOpen(true)}
                    />
                  )}
                </>
              )}
              <DropdownMenuItem onSelect={() => setSaveDetailsOpen(true)}>
                <ListChecks aria-hidden className="size-4" />
                保存详情
              </DropdownMenuItem>
            </>
          }
          actions={
            <AiQueueButton
              currentAttemptId={aiCompanion.send.attemptId}
              onOpenTask={aiCompanion.openTask}
              onOpenQuestion={aiCompanion.openQuestion}
            />
          }
          onBack={async () => {
            if (!editor || (await editor.request(null))) onBackHome();
          }}
        >
          <AttemptSourceSummary data={data} total={total} />
        </AttemptHeader>
        {data.practiceWorkflow && (
          <AttemptPartialControls
            data={data}
            groups={contextQuery.data?.groups ?? []}
            answers={answers}
            progress={practiceSubmit.progress}
            disabled={
              !online ||
              denied ||
              submit.isPending ||
              practiceSubmit.submittingId !== null
            }
            beforeSubmit={async () => !editor || (await editor.request(null))}
            syncNow={draftSync.syncNow}
            flushQuestionLocal={flushQuestionLocal}
            flushQuestion={flushQuestion}
            inkControllers={inkControllers}
          />
        )}
        <TimedAttemptControls
          timing={data.timing}
          clockAnchor={data.clockAnchor}
          syncing={draftSync.status.state !== "saved"}
          offline={!online}
          onConfirmSubmit={openSubmitDialog}
          submitDisabled={!online || denied || submit.isPending}
        />

        <p data-testid="draft-status" className="sr-only" aria-live="polite">
          {saveStatus}
        </p>
        {(saveStatus.startsWith("本机保存失败") || retrySaveError !== null) && (
          <div
            className="flex items-center gap-2 text-sm text-destructive"
            role="alert"
          >
            <span>{saveStatus}</span>
            {saveStatus.startsWith("本机保存失败") && (
              <Button
                variant="ghost"
                className="size-11 shrink-0 p-0"
                title="重试本机保存"
                aria-label="重试本机保存"
                disabled={retryingSave}
                onClick={async () => {
                  setRetryingSave(true);
                  setRetrySaveError(null);
                  try {
                    await retryAttemptLocalPersistence(attemptId, questionIds);
                  } catch (cause) {
                    setRetrySaveError(
                      cause instanceof Error
                        ? cause.message
                        : "本机保存仍失败，请保持页面打开",
                    );
                  } finally {
                    setRetryingSave(false);
                  }
                }}
              >
                <RotateCw aria-hidden className="size-4" />
              </Button>
            )}
            {retrySaveError && (
              <span className="text-xs text-destructive">{retrySaveError}</span>
            )}
          </div>
        )}
        <AttemptSaveDetails
          open={saveDetailsOpen}
          onOpenChange={setSaveDetailsOpen}
          onReturnFocus={() => moreTriggerRef.current?.focus()}
          attemptId={attemptId}
          questionIds={questionIds}
          controllers={inkControllers}
          onJump={async (questionId) => {
            await jumpForMode(questionId);
          }}
          onRetry={async () => {
            await recoverAttemptMaterials(attemptId, questionIds);
            await retryAttemptLocalPersistence(attemptId, questionIds);
            await Promise.all([
              draftSync.syncNow(),
              catchUpNotes(attemptId),
              catchUpAnnotations(attemptId),
            ]);
          }}
        />

        {/* 升级遗留卷按恢复版本作答的提醒随正文滚动，不占吸顶导航。 */}
        {data.legacyUnverified && (
          <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            这份练习的内容是系统升级后恢复的版本，可能与之前看到的不同；请按当前页面内容作答。
          </p>
        )}

        <AttemptSyncConflicts
          attemptId={attemptId}
          questionIds={questionIds}
          sync={draftSync}
          beforeResolve={async () => !editor || (await editor.request(null))}
        />
        {materialRecovery.state === "failed" && (
          <div role="alert" className="rounded-lg border p-4">
            <p>{materialRecovery.message}</p>
            <Button
              onClick={() =>
                void recoverAttemptMaterials(attemptId, questionIds).catch(
                  () => {},
                )
              }
            >
              重试恢复作答材料
            </Button>
          </div>
        )}
        {/* QM-08：共享材料上下文读取失败——题面照常可答，材料恢复独立重试 */}
        {contextQuery.isError && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-4"
          >
            <p className="min-w-0 text-sm">
              {contextQuery.error instanceof Error
                ? contextQuery.error.message
                : "共享材料加载失败，不影响作答题目。"}
            </p>
            <Button
              variant="outline"
              disabled={contextQuery.isFetching}
              onClick={() => void contextQuery.refetch()}
            >
              重试加载共享材料
            </Button>
          </div>
        )}

        {/* SAI-19：AI 伴学栏与主区共栖（dock 右栏/窄屏独立面板），主区
            作为 rail 子内容保持控制器身份稳定。
            SAI-20：题号与栏内会话都跟随绑定题（非滚动当前题）。
            SAI-22：装配在共享 useAiCompanionDock，本页只传身份与阶段。 */}
        {aiCompanion.rail(
          <div className="grid min-w-0 grid-cols-1">
            {/* 主内容列（M3-D1）：做题方式摘要 + 单题紧凑行 + 题卡列表 +
                单题占位操作条。作答保护（材料核对）沿用原 ol 的 inert 语义，
                现上移到本列容器——保护期间新增的呈现件同样不可交互。
                M3-D3：单题模式下为键盘工作区（tabIndex=-1 可聚焦，§9.2
                ←/→ 判定域；列表模式不挂 tabIndex 与键盘监听，零变化） */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: 布局容器兼单题键盘域（tabIndex=-1），非控件不引入 role 污染无障碍树 */}
            <div
              ref={singleWorkspaceRef}
              data-slot="practice-single-workspace"
              tabIndex={singleMode ? -1 : undefined}
              onKeyDown={singleMode ? onWorkspaceKeyDown : undefined}
              className="flex min-w-0 flex-col gap-4"
              inert={
                !attemptMaterialsEditable(materialRecovery) || answers === null
              }
            >
              {/* 空试卷：单元没有可作答的题目 */}
              {total === 0 && (
                <div className="rounded-lg border border-dashed border-border bg-card px-6 py-10 text-center">
                  <p className="text-sm font-medium">这份练习还没有题目</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    可能老师正在整理内容，请联系老师确认后再来。
                  </p>
                  <Button
                    variant="outline"
                    className="mt-4 min-h-11"
                    onClick={onBackHome}
                  >
                    返回
                  </Button>
                </div>
              )}

              {/* 题卡列表（ref 注册进视口观察：question_view + 聚焦兜底，T2.10）。
              T2A.7：多单元作业按单元分节（节标题 = 单元标题），题号全卷连续。
              M3-D1 单题专注：同一 keyed 序列仅隐藏非当前题（不卸载不搬卡），
              单元节头在单题态不显示（紧凑结构，§7.2）。
              QM-08：题目序经 groupSegmentsOfUnit 解释成独立题段/题组段——组段
              的共享材料按组渲染一份（数据解释单源）。审查 P1 修复：题组只是
              题行 ol 里的兄弟锚点（QuestionGroupAnchor），题行永不进组子树，
              context 后到/重试成功不重挂题卡（控制器随行存活）。
              P1-2：solo 题的题级 ::ref 材料挂题级锚（QuestionMaterialsAnchor，
              同为兄弟项不包裹题行）；组段材料并入成员题级引用（组∪题级单源）。 */}
              <ol className={total === 0 ? "hidden" : "flex flex-col gap-4"}>
                {data.units.map((unit) => {
                  const questionById = new Map(
                    unit.questions.map(
                      (question) => [question.id, question] as const,
                    ),
                  );
                  // P1-2：题级引用映射（学生题目投影携带）——组段并集 + solo 锚共用
                  const questionRefs = new Map<string, readonly MaterialRef[]>(
                    [],
                  );
                  for (const question of unit.questions) {
                    const refs = question.materialRefs;
                    if (refs !== undefined && refs.length > 0)
                      questionRefs.set(question.id, refs);
                  }
                  const segments = groupSegmentsOfUnit(
                    contextQuery.data,
                    unit.questions.map((question) => question.id),
                    questionRefs,
                  );
                  // compare 网格：对确有材料的题组/独立材料开启，或单题模式下当前题有材料（组材料/题级材料）时开启分栏
                  const unitHasMaterials = segments.some(
                    (segment) =>
                      (segment.kind === "group" &&
                        segment.materials.length > 0) ||
                      (segment.kind === "solo" &&
                        segment.questionIds.some((qid) => {
                          const q = questionById.get(qid);
                          return (
                            q !== undefined &&
                            questionMaterialsOf(contextQuery.data, q).length > 0
                          );
                        })),
                  );
                  const singleHasMaterials =
                    singleMode &&
                    resolvedSingleQuestionId !== null &&
                    (() => {
                      const q = questionById.get(resolvedSingleQuestionId);
                      if (!q) return false;
                      for (const segment of segments) {
                        if (
                          segment.kind === "group" &&
                          segment.questionIds.includes(
                            resolvedSingleQuestionId,
                          ) &&
                          segment.materials.length > 0
                        ) {
                          return true;
                        }
                      }
                      const solo = questionMaterialsOf(contextQuery.data, q);
                      return solo.length > 0;
                    })();
                  const isSplit = groupMaterialLayout === "split";
                  const groupGrid =
                    !compareActive &&
                    isSplit &&
                    (singleMode ? singleHasMaterials : unitHasMaterials);
                  /** 单题行渲染（组行/独立行共用；onOpenMaterial 组内挂共享
                      材料、solo 题挂题级材料，openMaterialLabel 区分语义） */
                  const renderRow = (
                    question: (typeof unit.questions)[number],
                    onOpenMaterial?: () => void,
                    grouped = false,
                    openMaterialLabel?: string,
                  ) => {
                    const index = flatQuestions.indexOf(question);
                    // v1 卷本题提交态（overlay 即时口径）：已提交行原位只读
                    // 并在 footer 槽追加反馈区；legacy/lesson 完全不挂
                    const practiceRow =
                      practiceProtocol === "v1"
                        ? progressById.get(question.id)
                        : undefined;
                    const practiceSubmitted =
                      (practiceRow?.submittedAt ?? null) !== null;
                    const autoSubmit =
                      canAutoSubmitChoice &&
                      questionBindings[question.type].placement ===
                        "options-radio";
                    return (
                      <AttemptQuestionRow
                        key={question.id}
                        settlementSeq={
                          data.settlementProgress?.membership[question.id]
                        }
                        className={
                          groupGrid
                            ? grouped
                              ? singleMode
                                ? "min-w-0 lg:col-start-3 xl:col-start-3 lg:max-h-[calc(var(--attempt-viewport-height,100dvh)-var(--attempt-header-height,64px)-var(--attempt-footer-height,64px)-32px)] xl:max-h-[calc(var(--attempt-viewport-height,100dvh)-var(--attempt-header-height,64px)-var(--attempt-footer-height,64px)-32px)] lg:overflow-y-auto xl:overflow-y-auto lg:overscroll-contain xl:overscroll-contain lg:pr-1 xl:pr-1"
                                : "min-w-0 lg:col-start-3 xl:col-start-3"
                              : "min-w-0 lg:col-span-full xl:col-span-full"
                            : undefined
                        }
                        cardElements={cardElements}
                        events={attemptEvents}
                        index={index}
                        lazyMount={
                          !singleMode &&
                          questionIds.length > ATTEMPT_LAZY_MOUNT_THRESHOLD
                        }
                        mountWindow={mountWindowRef.current ?? undefined}
                        forceMount={forcedMountIds.has(question.id)}
                        onCardMounted={handleCardMounted}
                        question={question}
                        assignmentTitle={data.title}
                        answer={answers?.[question.id]}
                        onAnswer={autoSubmit ? onAutoChoiceAnswer : setAnswer}
                        repeatChoiceSelection={autoSubmit}
                        attemptId={attemptId}
                        flagged={flaggedQuestions.has(question.id)}
                        onToggleFlag={toggleFlag}
                        unsure={studentFlags.has(question.id)}
                        onToggleUnsure={toggleUnsure}
                        formalInkPresence={
                          formalInkPresence.get(question.id) ?? false
                        }
                        onInkPresenceChange={onInkPresenceChange}
                        registerInkController={registerInkController}
                        hints={hintsOpened[question.id]}
                        onHintUnlocked={unlockHint}
                        {...(onOpenMaterial !== undefined
                          ? {
                              onOpenMaterial,
                              ...(openMaterialLabel !== undefined
                                ? { openMaterialLabel }
                                : {}),
                            }
                          : {})}
                        aiTrigger={aiCompanion.triggerForQuestion(question.id)}
                        aiContent={aiCompanion.inlineForQuestion(question.id)}
                        hidden={
                          singleMode && question.id !== resolvedSingleQuestionId
                        }
                        readOnly={
                          (practiceProtocol === "v1" && practiceSubmitted) ||
                          timeUp
                        }
                        inkSyncWhileReadOnly={timeUp && !practiceSubmitted}
                        suspendInkUpload={savedOnly}
                        footer={
                          practiceProtocol === "v1" &&
                          (!timeUp || practiceSubmitted) ? (
                            <PracticeQuestionFooter
                              attemptId={attemptId}
                              mode={singleMode ? "single" : "list"}
                              submitted={practiceSubmitted}
                              readable={practiceRow?.feedbackReadable ?? false}
                              autoSubmit={autoSubmit}
                              queued={
                                autoSubmit &&
                                queuedChoices.includes(question.id)
                              }
                              busy={practiceSubmit.submittingId === question.id}
                              anyBusy={practiceSubmit.submittingId !== null}
                              feedback={practiceSubmit.feedbackOf(question.id)}
                              feedbackFailed={practiceSubmit.feedbackFailedOf(
                                question.id,
                              )}
                              workflow={practiceSubmit.workflow}
                              error={
                                practiceSubmit.lastError?.questionId ===
                                question.id
                                  ? practiceSubmit.lastError.message
                                  : null
                              }
                              onSubmit={(opts) =>
                                void runPracticeSubmit(question.id, opts)
                              }
                              onRetryFeedback={() =>
                                practiceSubmit.retryFeedback(question.id)
                              }
                            />
                          ) : undefined
                        }
                      />
                    );
                  };
                  return (
                    <li
                      key={unit.id}
                      hidden={
                        singleMode &&
                        !unit.questions.some(
                          (question) =>
                            question.id === resolvedSingleQuestionId,
                        )
                      }
                      className="flex flex-col gap-4"
                    >
                      {showUnitHeaders && !singleMode && (
                        <h2
                          data-slot="attempt-unit-heading"
                          className="flex items-center gap-2 pt-2 text-sm font-semibold text-foreground before:h-4 before:w-1 before:rounded-full before:bg-primary"
                        >
                          {unit.title}
                        </h2>
                      )}
                      <ol
                        data-layout={
                          unitHasMaterials || singleHasMaterials
                            ? groupGrid
                              ? "compare"
                              : "stack"
                            : undefined
                        }
                        style={
                          groupGrid
                            ? ({
                                "--split-mat-cols": `${splitRatio}% 12px calc(${100 - splitRatio}% - 12px)`,
                              } as React.CSSProperties)
                            : undefined
                        }
                        className={
                          groupGrid
                            ? // 分栏网格列隙归零：列间距全部由中缝轨道（12px）承担——
                              // gap-4 的两个 16px 列隙叠在百分比轨道上会使网格
                              // 总宽超出容器 32px（行距仍由 gap-4 提供）
                              "flex min-w-0 flex-col gap-4 lg:grid xl:grid lg:gap-x-0 xl:gap-x-0 lg:grid-cols-[var(--split-mat-cols,minmax(0,1fr)_12px_minmax(0,1fr))] xl:grid-cols-[var(--split-mat-cols,minmax(0,1fr)_12px_minmax(0,1fr))]"
                            : "flex flex-col gap-3"
                        }
                      >
                        {/* flatMap 展平成单层题行数组：嵌套数组里元素的 key 会
                            带外层段位前缀（.0/q3 → .1/q3），context 后到段位
                            变化会重挂后续 solo 题卡（审查 P1 树位不变量的漏网
                            形态——控制器随段位漂移销毁）；展平后 key 与段位无关 */}
                        {segments.flatMap((segment) =>
                          segment.kind === "solo"
                            ? segment.questionIds.flatMap((questionId) => {
                                const question = questionById.get(questionId);
                                if (question === undefined) return [];
                                // P1-2：solo 题的题级 ::ref 材料——兄弟锚点
                                // 常驻渲染 + 题卡「查看本题材料」入口
                                const soloMaterials = questionMaterialsOf(
                                  contextQuery.data,
                                  question,
                                );
                                return soloMaterials.length === 0
                                  ? [renderRow(question, undefined, false)]
                                  : [
                                      <QuestionMaterialsAnchor
                                        key={`qmat:${question.id}`}
                                        questionId={question.id}
                                        materials={soloMaterials}
                                        readingKey={`${attemptId}|q:${question.id}`}
                                        revealSignal={
                                          materialReveal[question.id] ?? 0
                                        }
                                        hidden={
                                          singleMode &&
                                          question.id !==
                                            resolvedSingleQuestionId
                                        }
                                        className={
                                          groupGrid ? "min-w-0" : undefined
                                        }
                                        attemptId={attemptId}
                                        splitRatio={splitRatio}
                                        onSplitRatioChange={
                                          groupGrid ? setSplitRatio : undefined
                                        }
                                        containerRef={singleWorkspaceRef}
                                        layoutMode={groupMaterialLayout}
                                        onLayoutModeChange={
                                          // AI 对照激活时布局强制上下排布，
                                          // 不提供切换（控件状态恒与真实布局一致）
                                          compareActive
                                            ? undefined
                                            : setGroupMaterialLayout
                                        }
                                        jumpSignal={jumpSignal}
                                      />,
                                      renderRow(
                                        question,
                                        () => openGroupMaterial(question.id),
                                        true,
                                        "查看本题材料",
                                      ),
                                    ];
                              })
                            : [
                                <QuestionGroupAnchor
                                  key={`group:${segment.group.id}`}
                                  group={segment.group}
                                  materials={segment.materials}
                                  questionCount={
                                    singleMode
                                      ? 1
                                      : segment.questionIds.filter((qid) =>
                                          questionById.has(qid),
                                        ).length
                                  }
                                  readingKey={`${attemptId}|${segment.group.id}`}
                                  revealSignal={
                                    materialReveal[segment.group.id] ?? 0
                                  }
                                  hidden={
                                    singleMode &&
                                    !segment.questionIds.includes(
                                      resolvedSingleQuestionId ?? "",
                                    )
                                  }
                                  attemptId={attemptId}
                                  splitRatio={splitRatio}
                                  onSplitRatioChange={
                                    groupGrid ? setSplitRatio : undefined
                                  }
                                  containerRef={singleWorkspaceRef}
                                  layoutMode={groupMaterialLayout}
                                  onLayoutModeChange={
                                    compareActive
                                      ? undefined
                                      : setGroupMaterialLayout
                                  }
                                  jumpSignal={jumpSignal}
                                />,
                                ...segment.questionIds.map((questionId) => {
                                  const question = questionById.get(questionId);
                                  if (question === undefined) return null;
                                  return renderRow(
                                    question,
                                    segment.materials.length > 0
                                      ? () =>
                                          openGroupMaterial(segment.group.id)
                                      : undefined,
                                    true,
                                  );
                                }),
                              ],
                        )}
                      </ol>
                    </li>
                  );
                })}
              </ol>

              {/* 切题保护提示（M3-D3 §11-5）：本机落盘失败停留本题，重试成功继续切题 */}
              {singleMode && singleSwitchBlocked !== null && (
                <div
                  role="alert"
                  data-slot="practice-local-save-alert"
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1 font-medium text-destructive">
                    本机稿未保存，仍停留本题
                  </span>
                  <Button
                    variant="outline"
                    className="min-h-11 shrink-0"
                    disabled={localSaveRetrying}
                    onClick={() => void retryBlockedSwitch()}
                  >
                    重试保存并切换
                  </Button>
                </div>
              )}
            </div>
          </div>,
        )}

        <AttemptSessionNavigator
          attemptId={attemptId}
          questionIds={questionIds}
          location={location}
          navigation={navigation}
          practiceSubmit={practiceSubmit}
          currentQuestionId={currentQuestionId}
          navigationItems={navigationItems}
          navigatorMaterialsReady={navigatorMaterialsReady}
          answered={answered}
          total={total}
          submittedPracticeCount={submittedPracticeCount}
        />

        {/* 快捷键帮助（M3-D3 §9.2）：v1 卷菜单入口的落点；挂在菜单子树外。
            仅键盘设备渲染（纯触屏不出现快捷键 UI，探测成功当次会话即出现） */}
        {practiceWorkflow !== undefined && keyboardDevice && (
          <PracticeKeyboardHelpDialog
            open={keyboardHelpOpen}
            onOpenChange={setKeyboardHelpOpen}
          />
        )}

        <AttemptSessionActions
          location={location}
          navigation={navigation}
          practiceSubmission={practiceSubmission}
          confirmation={confirmation}
          practiceSubmit={practiceSubmit}
          timeUp={timeUp}
          online={online}
          denied={denied}
          total={total}
          answered={answered}
          submittedPracticeCount={submittedPracticeCount}
          singleProgressRow={singleProgressRow}
          singleAutoSubmit={singleAutoSubmit}
          materialsReady={navigatorMaterialsReady}
          saveFailed={saveFailed}
          questionIds={questionIds}
        />

        {practiceModeEditor !== null && (
          <PracticeModeDialog
            open={modeSettingsOpen}
            onOpenChange={setModeSettingsOpen}
            onReturnFocus={() => moreTriggerRef.current?.focus()}
            {...practiceModeEditor}
          />
        )}

        <AttemptSessionSubmitDialogs
          data={data}
          questionIndexById={questionIndexById}
          navigationItems={navigationItems}
          confirmation={confirmation}
          practiceSubmission={practiceSubmission}
          navigation={navigation}
          timeUp={timeUp}
          savedOnly={savedOnly}
          unanswered={unanswered}
        />
      </AttemptWorkspace>
    </DraftSyncProvider>
  );
}
