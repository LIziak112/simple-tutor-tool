import type {
  AttemptDetailData,
  AttemptDraftData,
  AttemptResultData,
  HintOpenedEntry,
  PracticeLayout,
} from "@tutor/contract";
import { Grid2X2, PanelLeftClose, PanelLeftOpen, RotateCw } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { catchUpAnnotations } from "@/features/annotation/annotation-sync";
import { questionBindings } from "@/features/answering/question-binding";
import { AttemptBottomBar } from "@/features/attempt/AttemptBottomBar";
import { AttemptHeader } from "@/features/attempt/AttemptHeader";
import { AttemptQuestionRow } from "@/features/attempt/AttemptQuestionRow";
import { groupSegmentsOfUnit } from "@/features/attempt/attempt-context-view";
import {
  attemptMaterialsEditable,
  recoverAttemptMaterials,
  useAttemptMaterialRecovery,
} from "@/features/attempt/attempt-material-recovery";
import { draftStore } from "@/features/attempt/draft-store";
import { SubmitConfirmDialog } from "@/features/attempt/SubmitConfirmDialog";
import { useAttemptAnswers } from "@/features/attempt/use-attempt-answers";
import { useAttemptEvents } from "@/features/attempt/use-attempt-events";
import {
  DraftSyncProvider,
  useDraftSync,
} from "@/features/attempt/use-draft-sync";
import type { InkUploadController } from "@/features/attempt/use-ink-upload";
import {
  EnabledCapabilitiesProvider,
  toEnabledCapabilities,
} from "@/features/capability/enabled-capabilities";
import { catchUpNotes } from "@/features/notes/note-sync";
import {
  prepareSubmitEvidence,
  type SubmitEvidencePrep,
} from "@/features/notes/submit-evidence";
import { useAiCompanionDock } from "@/features/student-ai/AiCompanionDock";
import { AiQueueButton } from "@/features/student-ai/AiQueueButton";
import { useAiCompareActive } from "@/features/student-ai/ai-companion-layout";
import { sealAttemptAnnotationsApi } from "@/lib/api";
import { formatDueTime } from "@/lib/time";
import { useOnlineStatus } from "@/lib/use-online-status";
import {
  AttemptEditorProvider,
  useAttemptEditor,
} from "./AttemptEditorContext";
import { AttemptResultLoader } from "./AttemptResultLoader";
import { AttemptSaveDetails } from "./AttemptSaveDetails";
import { AttemptSyncConflicts } from "./AttemptSyncConflicts";
import { AttemptWorkspace } from "./AttemptWorkspace";
import { attemptSourceLabel } from "./answer-format";
import {
  useAttemptContext,
  useSubmitAttempt,
  useUpdateAttemptWorkflow,
} from "./attempt-queries";
import { consumeAttemptStartLayoutIntent } from "./attempt-start-intent";
import { focusWhenReachable } from "./focus-when-reachable";
import {
  type PracticeProblemPhase,
  PracticeQuestionFooter,
  PracticeSingleActions,
  PracticeSubmitProblemDialog,
} from "./PracticeQuestionSubmit";
import {
  PracticeKeyboardHelpDialog,
  PracticeKeyboardHelpMenuItem,
  PracticeModeDialog,
  PracticeModeSummary,
  SingleQuestionActionBar,
} from "./PracticeWorkspace";
import {
  isActivatingTarget,
  isOverlayOpen,
  isSuppressedKeyEvent,
  isTextEditingEvent,
} from "./practice-keyboard";
import {
  currentLayout,
  usePracticePreference,
} from "./practice-preference-store";
import {
  countSubmittedQuestions,
  firstUnsubmittedQuestionId,
  practiceProtocolOfDraft,
} from "./practice-protocol";
import { QuestionGroupAnchor } from "./QuestionGroupAnchor";
import { QuestionNavigator } from "./QuestionNavigator";
import { completionLabel, getQuestionCompletion } from "./question-completion";
import {
  retryAttemptLocalPersistence,
  useAttemptSaveStatus,
} from "./use-attempt-save-status";
import { usePracticeQuestionSubmit } from "./use-practice-question-submit";
import { useReadingPosition } from "./use-reading-position";
import {
  type EvidenceConfirmContext,
  type EvidenceConfirmOutcome,
  evidenceProblemViewsOf,
  useSubmitEvidenceConfirm,
} from "./use-submit-evidence-confirm";
import { useWorkspaceFlags } from "./use-workspace-flags";

/** 详情 data 的嵌套判别（Zod union 判别键在 attempt.status，TS 无法自动收窄） */
export function isDraftDetail(
  data: AttemptDetailData,
): data is AttemptDraftData {
  return data.attempt.status === "draft";
}

/** 详情 data 是否结果视图（submitted/graded） */
export function isResultDetail(
  data: AttemptDetailData,
): data is AttemptResultData {
  return data.attempt.status !== "draft";
}

/**
 * 答题会话（T2A.6 通用化，D9 两种来源共用）：
 * /s/assignments/:id（作业入口）与 /s/attempts/:attemptId（课程练习/历次回看）
 * 在创建/获取 attempt 后渲染同一组件。
 * - 顶部来源行：课程练习「课程：xx · 第 n 次」/ 作业「作业：xx」（含截止）；
 * - draft → 答题视图（题卡 + 草稿防丢 + 交卷确认）；已交 → 结果视图；
 * - 草稿同步终态（T2A.6，D7）：顶栏显示「已无权限访问该练习」时同时收起
 *   交卷入口（交卷必然同样被拒）。
 */

/**
 * 交卷准备阶段（T6R.10，验收修复 A-4）：单一判别联合替代原先三个独立
 * state（preparing/problems/error）——阶段迁移一次 set 完成，弹层各分支
 * （等待文案/明确选择/阻止性错误）据此渲染，不存在中间组合态。
 * 2026-10 讲练一体起与讲练页共用 use-submit-evidence-confirm 状态机单源，
 * 本页只注入整卷六步编排（runSubmit）。
 */

export function AttemptSession({
  data,
  onExit,
  exitLabel,
  onRefresh,
}: {
  data: AttemptDetailData;
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
  // T7.7：教师辅助能力启用集随卷下发（草稿/结果两视图同口径；详解内 steps
  // 的揭晓渲染同样遵循开关）。页面挂载期取值——教师改配置后学生刷新生效。
  const capabilities = toEnabledCapabilities(data.enabledCapabilities);
  return (
    <EnabledCapabilitiesProvider value={capabilities}>
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
          <AnswerView
            key={data.attempt.id}
            data={data}
            attemptId={data.attempt.id}
            onBackHome={onExit}
            onAnnotationSealFailed={() => setAnnotationSealWarning(true)}
          />
        </AttemptEditorProvider>
      )}
    </EnabledCapabilitiesProvider>
  );
}

/** 答题视图（draft）：题卡 + 吸底操作条 + 交卷确认（T2.9：本地草稿仓 + 增量同步） */
function AnswerView({
  data,
  attemptId,
  onBackHome,
  onAnnotationSealFailed,
}: {
  data: AttemptDraftData;
  attemptId: string;
  onBackHome: () => void;
  /** 交卷成功后的标注 seal 失败回调（非阻断警示——AttemptSession 顶态） */
  onAnnotationSealFailed: () => void;
}) {
  const editor = useAttemptEditor(null);
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
  );
  // 学习痕迹埋点（T2.10）：attempt_start/聚焦/answer_change/ink/page_*/submit
  const attemptEvents = useAttemptEvents(attemptId);
  const {
    answers,
    setAnswer,
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
  /** 笔迹上传失败提示（交卷 flush 失败时展示，重试交卷消除） */
  const [inkFlushError, setInkFlushError] = useState(false);
  /** 交卷准备中止标志：弹层关闭（=取消）置位，runSubmit 各 await 段后检查 */
  const submitAbortedRef = useRef(false);
  const submit = useSubmitAttempt(attemptId);
  // 反馈节奏切换（M5-D3）：PATCH CAS + 详情失效；禁用只按服务端投影
  const feedbackUpdate = useUpdateAttemptWorkflow(attemptId);

  // T2A.7：题目按单元分组下发；答题页平铺渲染、题号全卷连续（累计 index）。
  // 多单元时渲染节标题（单元标题），单单元不显示节头（避免与课程练习标题重复）。
  // 派生数组 useMemo（效率复审 #10）：confirmSubmit/openSubmitDialog 的
  // useCallback 依赖因此稳定（原先每渲染新数组零收益地失效缓存）
  const flatQuestions = useMemo(
    () => data.units.flatMap((unit) => unit.questions),
    [data],
  );
  const showUnitHeaders = data.units.length > 1;
  const questionIds = useMemo(
    () => flatQuestions.map((question) => question.id),
    [flatQuestions],
  );
  const total = flatQuestions.length;
  const materialRecovery = useAttemptMaterialRecovery(attemptId, questionIds);
  // QM-08：冻结上下文（材料/组快照）——共享材料渲染数据源；错误非阻断（题面
  // 不依赖本载荷），就地提示 + 重试
  const contextQuery = useAttemptContext(attemptId);
  /** AI 侧栏对照激活 → 组段呈现回退上下排布（与题卡草稿「自动」布局同款信号） */
  const compareActive = useAiCompareActive();
  /** 「查看材料」reveal 信号（组 id → 递增计数；QuestionGroupAnchor 滚入恢复） */
  const [materialReveal, setMaterialReveal] = useState<Record<string, number>>(
    {},
  );
  const openGroupMaterial = useCallback((groupId: string) => {
    setMaterialReveal((previous) => ({
      ...previous,
      [groupId]: (previous[groupId] ?? 0) + 1,
    }));
  }, []);
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const navigatorTrigger = useRef<HTMLElement | null>(null);
  const [modeSettingsOpen, setModeSettingsOpen] = useState(false);
  const openNavigator = () => {
    navigatorTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setNavigatorOpen(true);
  };
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
  const navigatorCollapsed = aiCompanion.controller.navigatorCollapsed;
  const navigationId = useId();
  const navigationAnchor = useRef<{ element: HTMLElement; top: number } | null>(
    null,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies(navigatorCollapsed): 折叠布局提交后恢复当前题卡位置。
  useLayoutEffect(() => {
    const saved = navigationAnchor.current;
    if (!saved) return;
    window.scrollBy({
      top: saved.element.getBoundingClientRect().top - saved.top,
      behavior: "instant",
    });
    navigationAnchor.current = null;
  }, [navigatorCollapsed]);
  const { flags: flaggedQuestions, toggle: toggleFlag } =
    useWorkspaceFlags(attemptId);
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
  useReadingPosition(attemptId, cardElements, setCurrentQuestionId);

  // ---------- 做题方式（M3-D1）：v1 新协议卷的列表/单题呈现 ----------
  // 协议形态只信服务端投影：legacy/lesson（无 practiceWorkflow）恒列表，
  // 现有行为零变化（计划 §6.1、§11 纪律 1 与退化边界）。
  const [searchParams, setSearchParams] = useSearchParams();
  const practiceProtocol = practiceProtocolOfDraft(data);
  const practiceWorkflow =
    practiceProtocol === "v1" ? data.practiceWorkflow : undefined;
  // data 基线进度：单题当前题解析锚定它（提交后不因 overlay 变化自动跳题，
  // 切题只随显式动作——§7.2）；回执 overlay 的进度（practiceProgress）用于
  // 导航四态、进度行与题卡只读的即时更新。
  const questionProgress =
    practiceProtocol === "v1" ? (data.questionProgress ?? []) : [];
  // 布局本次作答内自决：进入时按「开始页一次性 transient 预选 → 默认偏好」
  // 取一次（M5-D3 裁决⑨：预选不经服务端，消费即清除；legacy/lesson 也消费
  // 防同会话残留），之后只随显式切换变化，不被偏好变更或后台重取中途拉扯；
  // 不写回默认偏好（§7.1）
  const [practiceLayout, setPracticeLayout] = useState<PracticeLayout>(() => {
    const startIntent = consumeAttemptStartLayoutIntent();
    if (practiceProtocol !== "v1") return "list";
    return startIntent ?? currentLayout();
  });
  // M3-D1.5：硬刷新直达作答页时，布局层的账号绑定 effect 晚于本组件首渲染，
  // 已保存默认布局会在初值时被错过——store 从未绑定变已绑定的那一刻按已
  // 保存默认布局对齐一次；用户显式切换过布局之后，绑定变化与跨标签偏好
  // 变更都不得再拉扯当前选择（§7.1「进入时取一次」语义的补全）
  const explicitLayoutRef = useRef(false);
  const setPracticeLayoutExplicit = useCallback((layout: PracticeLayout) => {
    explicitLayoutRef.current = true;
    setPracticeLayout(layout);
  }, []);
  const { accountId: boundAccountId, keyboardShortcuts } =
    usePracticePreference();
  const prevBoundAccountRef = useRef(boundAccountId);
  useEffect(() => {
    const previous = prevBoundAccountRef.current;
    prevBoundAccountRef.current = boundAccountId;
    if (practiceProtocol !== "v1" || explicitLayoutRef.current) return;
    // 只在「未绑定 → 已绑定」迁移时对齐一次；换绑与解绑不拉扯
    if (previous !== null || boundAccountId === null) return;
    setPracticeLayout(currentLayout());
  }, [boundAccountId, practiceProtocol]);
  const singleMode = practiceProtocol === "v1" && practiceLayout === "single";
  // 单题当前题：显式跳转 > URL q（须属本卷）> 滚动当前题 > 首道未提交 > 第一题
  const [singleQuestionId, setSingleQuestionId] = useState<string | null>(null);
  const resolvedSingleQuestionId = useMemo(() => {
    if (!singleMode) return null;
    if (singleQuestionId !== null && questionIds.includes(singleQuestionId))
      return singleQuestionId;
    const urlQ = searchParams.get("q");
    if (urlQ !== null && questionIds.includes(urlQ)) return urlQ;
    if (currentQuestionId !== null && questionIds.includes(currentQuestionId))
      return currentQuestionId;
    return (
      firstUnsubmittedQuestionId(questionIds, questionProgress) ??
      questionIds[0] ??
      null
    );
  }, [
    singleMode,
    singleQuestionId,
    questionIds,
    searchParams,
    currentQuestionId,
    questionProgress,
  ]);
  const singleIndex =
    resolvedSingleQuestionId === null
      ? -1
      : questionIds.indexOf(resolvedSingleQuestionId);
  // 单题专注工作区容器（M3-D3 §9.2）：tabIndex=-1 可聚焦，←/→ 的判定域。
  const singleWorkspaceRef = useRef<HTMLDivElement | null>(null);
  // §11-5 焦点纪律：进入单题（含菜单切换）与每次切题后焦点落回容器——
  // 方向键域与连续键盘导航的锚点；focusWhenReachable 代数守卫下与
  // jumpToQuestion 落焦链后到者胜（goSingleQuestion 显式传容器，目标一致）。
  useEffect(() => {
    if (!singleMode || resolvedSingleQuestionId === null) return;
    focusWhenReachable(singleWorkspaceRef.current);
  }, [singleMode, resolvedSingleQuestionId]);

  // ---------- 逐题提交编排（M3-D2 §10.2/§10.3）：五字段 POST + 回执 overlay +
  // 题级反馈惰性 GET。收笔（编辑器让位确认）→ 该题笔迹 flush → 草稿追平 →
  // 单题证据 → 提交；错误分诊与最后一题不自动 refetch 都在 hook 内。
  const practiceSubmit = usePracticeQuestionSubmit({
    data,
    attemptId,
    questionIds,
    cardElements,
    singleQuestionId: singleMode ? resolvedSingleQuestionId : null,
    singleMode,
    syncNow: draftSync.syncNow,
    flushQuestion,
    inkControllers,
    beforeSubmit: async () => (editor === null ? true : editor.request(null)),
  });
  const practiceProgress =
    practiceProtocol === "v1" ? practiceSubmit.progress : [];
  // 交卷结束整卷，但仅为尚未提交题固定本次证据；已提交题沿用单题封存。
  // 使用提交回执合并后的进度，避免本页刚提交的题仍进入整卷证据声明。
  const submitEvidenceQuestionIds = useMemo(() => {
    if (practiceProtocol !== "v1") return questionIds;
    const submitted = new Set(
      practiceSubmit.progress
        .filter((row) => row.submittedAt !== null)
        .map((row) => row.questionId),
    );
    return questionIds.filter((id) => !submitted.has(id));
  }, [practiceProtocol, practiceSubmit.progress, questionIds]);
  // 按题查表：导航项/键盘裁决/题卡渲染多处取行，避免逐题线性 find
  const progressById = new Map(
    practiceProgress.map((row) => [row.questionId, row] as const),
  );
  const submittedPracticeCount = countSubmittedQuestions(practiceProgress);
  const singleProgressRow =
    resolvedSingleQuestionId === null
      ? undefined
      : progressById.get(resolvedSingleQuestionId);
  // 缺稿明确选择弹层（§10.3）：证据组装发现未追平草稿时不静默放行——
  // choice（用户裁决）→ busy（确认后带 allowMissing 重提）→ error（重提失败留弹层）；
  // 其余 outcome（提交成功/受限/stale/取消）一律收起弹层（就地提示由 hook 承担）
  const [practiceProblem, setPracticeProblem] = useState<{
    questionId: string;
    phase: PracticeProblemPhase;
  } | null>(null);
  // 单题切题保护（M3-D3 §11-5）：本机落盘失败时记下被拦下的目标题（仍停留
  // 本题），就地提示 + 重试；成功切题即清除
  const [singleSwitchBlocked, setSingleSwitchBlocked] = useState<string | null>(
    null,
  );
  const [localSaveRetrying, setLocalSaveRetrying] = useState(false);
  const runPracticeSubmit = useCallback(
    async (
      questionId: string,
      opts?: { allowMissing?: boolean },
    ): Promise<void> => {
      const outcome = await practiceSubmit.submit(questionId, opts);
      if (outcome.kind === "problems") {
        setPracticeProblem({
          questionId,
          phase: {
            kind: "choice",
            reason: outcome.problems[0]?.reason ?? "草稿尚未保存完整",
          },
        });
        return;
      }
      if (outcome.kind === "error") {
        // 弹层进行中（缺稿重提失败）→ 错误相留在弹层；否则 hook 已就地提示
        setPracticeProblem((prev) =>
          prev !== null
            ? {
                questionId,
                phase: { kind: "error", message: outcome.message },
              }
            : null,
        );
        return;
      }
      setPracticeProblem(null);
    },
    [practiceSubmit.submit],
  );
  // §11 纪律 7：单题切题 replace 更新 q、回列表清除 q——不加历史条目；
  // 其他查询参数（returnTo/aiFrom）原样保留
  useEffect(() => {
    if (practiceProtocol !== "v1") return;
    const q = searchParams.get("q");
    if (singleMode && resolvedSingleQuestionId !== null) {
      if (q !== resolvedSingleQuestionId) {
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.set("q", resolvedSingleQuestionId);
            return next;
          },
          { replace: true },
        );
      }
    } else if (!singleMode && q !== null) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("q");
          return next;
        },
        { replace: true },
      );
    }
  }, [
    practiceProtocol,
    singleMode,
    resolvedSingleQuestionId,
    searchParams,
    setSearchParams,
  ]);

  const navigationItems = flatQuestions.map((question, index) => ({
    id: question.id,
    index,
    completion: getQuestionCompletion(
      question,
      answers?.[question.id],
      formalInkPresence.get(question.id),
    ),
    flagged: flaggedQuestions.has(question.id),
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
  const answered = navigationItems.filter(
    (item) => item.completion.state === "filled",
  ).length;
  const unanswered = total - answered;
  const jumpToQuestion = async (
    id: string,
    focusAnswer = false,
    focusElement?: HTMLElement | null,
  ) => {
    if (editor && !(await editor.request(null))) return;
    setNavigatorOpen(false);
    setCurrentQuestionId(id);
    requestAnimationFrame(() => {
      const card = cardElements.current.get(id);
      const article = card?.querySelector<HTMLElement>("article");
      article?.scrollIntoView?.({ block: "start", behavior: "auto" });
      const fields = card?.querySelectorAll<HTMLInputElement>(
        'input:not([type="radio"]):not([type="checkbox"])',
      );
      const target = focusAnswer
        ? (Array.from(fields ?? []).find(
            (field) => field.value.trim() === "",
          ) ?? fields?.[0])
        : null;
      const answerControl = card?.querySelector<HTMLElement>(
        'math-field, [data-slot="question-surface"] input[type="radio"], [data-slot="question-surface"] input[type="checkbox"], [data-slot="question-surface"] button',
      );
      // 作答保护（inert——reload 后材料核对未完成）下 focus 静默失败，
      // focusWhenReachable 按帧重试，保护解除后落焦（webkit E2E 回归）。
      // focusElement：调用方指定的落焦点（单题模式=工作区容器），优先于题卡。
      focusWhenReachable(
        target ??
          (focusAnswer ? answerControl : null) ??
          focusElement ??
          article,
      );
    });
  };
  // 单题跳题（M3-D1）：与列表跳题同一收笔/滚动/聚焦链，另更新单题态与
  // 当前题标记（AI 伴学/导航跟随显式选择，§11 纪律 1 不重建题卡）。
  // M3-D3 切题纪律（§11-5）：切题前只要求当前题**本机**落盘成功（不要求
  // 服务器确认，离线可继续已核对题面）；失败不切题，就地提示与重试，不清
  // 空原稿、不跳页。列表模式自由浏览不设保护；上一题/下一题/导航跳题/键盘
  // 切题统一走本入口。
  // jumpToQuestion 本身非 memo（每渲染重建），此处同法不包 useCallback。
  // M4-D2 §12.1：返回是否切题成功，供 AI 旧任务定位判断是否保留现场。
  const goSingleQuestion = async (
    id: string,
    focusAnswer = false,
  ): Promise<boolean> => {
    // 提交在途禁切题（§7.2 busy）：上一题/下一题/导航均已禁用，此处兜底直调
    if (practiceSubmit.submittingId !== null) return false;
    // 先收笔再切题（闸门修复：原序先切态后收笔，收笔失败=用户选择继续书写
    // 时已切走，错误横幅与键盘守门会指向看不见的旧题——与列表模式同序）
    if (editor && !(await editor.request(null))) return false;
    const from = resolvedSingleQuestionId;
    if (from !== null && from !== id) {
      if (!(await flushQuestionLocal(from))) {
        setSingleSwitchBlocked(id);
        return false;
      }
      // 切题先收起 AI 阅读（M4-D2 §12.1）：在本机落盘保护之后、真正切换
      // 之前，复用 dock 既有收起链（落盘失败不切题）；收起失败时 dock 已
      // 就地提示重试，不再叠加切题保护横幅，保留现场不切换。
      if (!(await aiCompanion.collapseForNavigation())) return false;
    }
    setSingleSwitchBlocked(null);
    setSingleQuestionId(id);
    setCurrentQuestionId(id);
    // 单题切题落焦工作区容器（§9.2 ←/→ 判定域；不落题面避免软键盘）；
    // focusAnswer（交卷确认「去补全」）：显式补答意图优先落答案控件
    await jumpToQuestion(id, focusAnswer, singleWorkspaceRef.current);
    return true;
  };
  // AI 旧任务定位的统一切题入口（M4-D2 §12.1）：单题模式且目标非当前题才
  // 走切题链（列表模式与就地展开直接放行，不触发收笔/收起）。
  goToQuestionRef.current = async (questionId: string) => {
    if (!singleMode || questionId === resolvedSingleQuestionId) return true;
    return goSingleQuestion(questionId);
  };

  /** 切题保护的重试入口：本机落盘成功后继续被拦下的那次切题 */
  const retryBlockedSwitch = async (): Promise<void> => {
    const target = singleSwitchBlocked;
    if (target === null || localSaveRetrying) return;
    setLocalSaveRetrying(true);
    try {
      const from = resolvedSingleQuestionId;
      if (from === null || (await flushQuestionLocal(from)))
        await goSingleQuestion(target);
    } finally {
      setLocalSaveRetrying(false);
    }
  };
  const jumpForMode = singleMode ? goSingleQuestion : jumpToQuestion;

  // ---------- 单题专注键盘（M3-D3 §9.2）：Enter 主动作 / ←→ 切题 / 1-9 选项 ----------
  // 仅 v1 新协议 + 单题模式挂载（legacy/lesson 零变化）；偏好开关关闭全失效。
  // 守门链：默认抑制态（合成/repeat/修饰键/已被处理）→ 任一弹层打开 → busy →
  // 书写中/纸面展开 → 答案冲突 → 切题保护拦截。一次 keydown 至多一个动作；
  // 键盘发起的提交持同步锁（submit 串行守卫在收笔 await 之后才置位，微任务
  // 窗口内的第二次 Enter 靠此锁挡住）。文本编辑区判定走 composedPath（含
  // MathLive/AI 输入宿主），按钮/链接保留自身 Enter，查看结果永不入键。
  const practiceKeyActionRef = useRef(false);
  const onWorkspaceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!singleMode || !keyboardShortcuts) return;
    const native = event.nativeEvent;
    if (isSuppressedKeyEvent(native) || isOverlayOpen()) return;
    const currentId = resolvedSingleQuestionId;
    if (currentId === null) return;
    if (
      practiceSubmit.submittingId !== null ||
      singleSwitchBlocked !== null ||
      (editor !== null &&
        (editor.getActive() !== null || editor.getPaper() !== null)) ||
      draftStore.peekAnswerConflicts(attemptId)[currentId] !== undefined
    ) {
      return;
    }
    const currentIndex = questionIds.indexOf(currentId);
    const submitted =
      (progressById.get(currentId)?.submittedAt ?? null) !== null;
    if (event.key === "Enter") {
      if (isTextEditingEvent(native) || isActivatingTarget(native)) return;
      event.preventDefault();
      if (practiceKeyActionRef.current) return;
      practiceKeyActionRef.current = true;
      void (async () => {
        try {
          if (!submitted) {
            // 工作流收紧时 Enter 退为切题/交卷（与主操作位同链）；题目级
            // 参考答案门控已随 v2 自评实现移除（QM 判分框架下逐题提交恒可用）
            if (!practiceWorkflow?.canSubmitQuestion) {
              const next = questionIds[currentIndex + 1];
              if (next !== undefined) await goSingleQuestion(next);
              else if (online && !denied) await openSubmitDialog();
              return;
            }
            // 与主操作按钮同链：未提交（含空答「不会」）= 提交本题
            await runPracticeSubmit(currentId);
            return;
          }
          // 已提交只导航：查看本次结果永不入键（§9.2）
          if (practiceSubmit.finished) return;
          const next = questionIds[currentIndex + 1];
          if (next !== undefined) {
            await goSingleQuestion(next);
            return;
          }
          const resume = practiceSubmit.firstUnsubmittedId;
          if (resume !== null && resume !== currentId) {
            await goSingleQuestion(resume);
          }
        } finally {
          practiceKeyActionRef.current = false;
        }
      })();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      // 仅工作区容器自身持有焦点时切题；题面/输入/按钮内的方向键保持原生
      if (document.activeElement !== event.currentTarget) return;
      event.preventDefault();
      const next =
        event.key === "ArrowRight"
          ? questionIds[currentIndex + 1]
          : questionIds[currentIndex - 1];
      if (next !== undefined) void goSingleQuestion(next);
      return;
    }
    if (/^[1-9]$/.test(event.key)) {
      // 已提交只读题不响应；文本编辑区内数字保持输入语义
      if (submitted || isTextEditingEvent(native)) return;
      const card = cardElements.current.get(currentId);
      const options = card?.querySelectorAll<HTMLInputElement>(
        '[data-slot="question-surface"] input[type="radio"], [data-slot="question-surface"] input[type="checkbox"]',
      );
      const option = options?.[Number(event.key) - 1];
      if (option === undefined || option.disabled) return;
      event.preventDefault();
      // 复用既有选项控件链（React onChange → setAnswer → 草稿防丢），不另写
      // 一套答案拼装；原生 click 会把焦点移到选项上，连续键盘导航要求焦点
      // 留在工作区容器
      option.click();
      singleWorkspaceRef.current?.focus();
    }
  };
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

  /**
   * 交卷编排（注入共享确认状态机 use-submit-evidence-confirm；T2.8 口径 +
   * T6R.10 证据固定，方案 §6.4 六步）：
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
   */
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

  // 做题方式唯一编辑器的接线（列表模式行内摘要行 / 单题模式弹窗共用）
  const practiceModeEditor =
    practiceWorkflow === undefined
      ? null
      : {
          workflow: practiceWorkflow,
          layout: practiceLayout,
          onLayoutChange: setPracticeLayoutExplicit,
          onFeedbackModeChange: (mode: typeof practiceWorkflow.feedbackMode) =>
            feedbackUpdate.mutate({
              feedbackMode: mode,
              workflowRevision: practiceWorkflow.revision,
            }),
          feedbackBusy: feedbackUpdate.isPending,
          feedbackError: feedbackUpdate.notice,
        };
  // 单题吸底进度：题号 + 逐题提交进度（整卷反馈不可逐题提交时报已填写）；
  // canSubmitQuestion 只取工作流级开关——题目级参考答案门控已随 v2 自评实现移除
  const singleCanSubmit = practiceWorkflow?.canSubmitQuestion === true;
  const singleProgressCount = singleCanSubmit
    ? submittedPracticeCount
    : answered;

  const singleActions = singleMode && resolvedSingleQuestionId !== null && (
    <div
      inert={!attemptMaterialsEditable(materialRecovery) || answers === null}
    >
      <SingleQuestionActionBar
        showNext={
          !singleProgressRow?.submittedAt &&
          !practiceSubmit.finished &&
          singleCanSubmit
        }
        hasPrev={singleIndex > 0}
        hasNext={singleIndex < total - 1}
        busy={practiceSubmit.submittingId !== null}
        middle={
          <PracticeSingleActions
            canSubmitQuestion={singleCanSubmit}
            finishDisabled={!online || denied || total === 0}
            onFinish={openSubmitDialog}
            submitted={(singleProgressRow?.submittedAt ?? null) !== null}
            answered={
              navigationItems[singleIndex]?.completion.state === "filled"
            }
            busy={practiceSubmit.submittingId !== null}
            finished={practiceSubmit.finished}
            hasNext={singleIndex < total - 1}
            continueUnsubmittedId={
              practiceSubmit.firstUnsubmittedId !== null &&
              practiceSubmit.firstUnsubmittedId !== resolvedSingleQuestionId &&
              practiceSubmit.firstUnsubmittedId !== questionIds[singleIndex + 1]
                ? practiceSubmit.firstUnsubmittedId
                : null
            }
            error={
              practiceSubmit.lastError?.questionId === resolvedSingleQuestionId
                ? practiceSubmit.lastError.message
                : null
            }
            onSubmit={() => {
              if (resolvedSingleQuestionId !== null)
                void runPracticeSubmit(resolvedSingleQuestionId);
            }}
            onNext={() => {
              const next = questionIds[singleIndex + 1];
              if (next !== undefined) void goSingleQuestion(next);
            }}
            onViewResult={() => practiceSubmit.viewResult()}
            onContinue={(id) => void goSingleQuestion(id)}
          />
        }
        onPrev={() => {
          const prev = questionIds[singleIndex - 1];
          if (prev !== undefined) void goSingleQuestion(prev);
        }}
        onNext={() => {
          const next = questionIds[singleIndex + 1];
          if (next !== undefined) void goSingleQuestion(next);
        }}
      />
    </div>
  );

  return (
    <DraftSyncProvider value={{ ...draftSync, recovery: materialRecovery }}>
      <AttemptWorkspace>
        {/* 练习头：来源 + 标题 + 截止 + 草稿保存状态（T2.9 三态 + T2A.6 终态） */}
        <AttemptHeader
          title={data.title}
          menuItems={
            practiceWorkflow !== undefined ? (
              <>
                <DropdownMenuItem
                  onSelect={() => {
                    setModeSettingsOpen(true);
                    // 单题模式由弹窗承载同一编辑器；列表模式展开行内摘要行
                    if (singleMode) return;
                    requestAnimationFrame(() => {
                      const trigger =
                        singleWorkspaceRef.current?.querySelector<HTMLButtonElement>(
                          '[aria-label="调整做题方式"]',
                        );
                      trigger?.scrollIntoView?.({ block: "nearest" });
                      trigger?.focus();
                    });
                  }}
                >
                  做题方式
                </DropdownMenuItem>
                <PracticeKeyboardHelpMenuItem
                  onOpen={() => setKeyboardHelpOpen(true)}
                />
              </>
            ) : undefined
          }
          actions={
            <AiQueueButton
              currentAttemptId={aiCompanion.send.attemptId}
              onOpenTask={aiCompanion.openTask}
              onOpenQuestion={aiCompanion.openQuestion}
            />
          }
          status={(closeDetails) => (
            <div className="flex min-w-0 items-center gap-2">
              <p
                data-testid="draft-status"
                className="min-w-0 text-xs break-words text-muted-foreground"
                aria-live="polite"
              >
                {saveStatus}
              </p>
              <AttemptSaveDetails
                attemptId={attemptId}
                questionIds={questionIds}
                controllers={inkControllers}
                onJump={async (questionId) => {
                  closeDetails();
                  // 单题模式必须走 goSingleQuestion：直连 jumpToQuestion 不更新
                  // 单题态，跳转对隐藏卡无效（闸门修复）
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
                      await retryAttemptLocalPersistence(
                        attemptId,
                        questionIds,
                      );
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
                  <RotateCw />
                </Button>
              )}
              {retrySaveError && (
                <span role="alert" className="text-xs text-destructive">
                  {retrySaveError}
                </span>
              )}
            </div>
          )}
          onBack={async () => {
            if (!editor || (await editor.request(null))) onBackHome();
          }}
        >
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{attemptSourceLabel(data)}</span>
            {data.attempt.sourceType === "assignment" && (
              <span>
                {data.dueAt === null
                  ? "不限截止"
                  : `${formatDueTime(data.dueAt)} 截止`}
              </span>
            )}
            <span>共 {total} 题</span>
          </p>
          {/* T6R.3：升级遗留卷懒冻结标记——内容为恢复时刻的版本，不能宣称是
              学生更早看到的（方案 §5.1 legacy_unverified），如实告知 */}
          {data.legacyUnverified && (
            <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              这份练习的内容是系统升级后恢复的版本，可能与之前看到的不同；请按
              当前页面内容作答。
            </p>
          )}
        </AttemptHeader>

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
            （答题卡 + 题卡列表）作为 rail 子内容保持控制器身份稳定。
            SAI-20：题号与栏内会话都跟随绑定题（非滚动当前题）。
            SAI-22：装配在共享 useAiCompanionDock，本页只传身份与阶段。 */}
        {aiCompanion.rail(
          <div
            className={`grid min-w-0 grid-cols-1 gap-6 ${navigatorCollapsed ? "lg:grid-cols-[44px_minmax(0,1fr)]" : "lg:grid-cols-[176px_minmax(0,1fr)]"}`}
          >
            <aside
              aria-label="答题定位"
              className="sticky top-[calc(var(--attempt-header-height,64px)+16px)] hidden max-h-[calc(var(--attempt-viewport-height,100dvh)-var(--attempt-header-height,64px)-var(--attempt-footer-height,64px)-32px)] self-start overflow-y-auto overscroll-contain lg:block"
            >
              <h2 className="sticky top-0 z-10 mb-3">
                <Button
                  variant="outline"
                  className={`min-h-11 text-sm font-semibold ${navigatorCollapsed ? "size-11 p-0" : "w-full justify-between px-3"}`}
                  // 学生端全局焦点规则在工具类层之外；内收轮廓避免滚动栏裁切。
                  style={{ outlineOffset: -2 }}
                  aria-label={navigatorCollapsed ? "展开答题卡" : "收起答题卡"}
                  title={navigatorCollapsed ? "展开答题卡" : "收起答题卡"}
                  aria-expanded={!navigatorCollapsed}
                  aria-controls={navigationId}
                  onClick={() => {
                    const element = currentQuestionId
                      ? cardElements.current.get(currentQuestionId)
                      : undefined;
                    if (element)
                      navigationAnchor.current = {
                        element,
                        top: element.getBoundingClientRect().top,
                      };
                    aiCompanion.controller.toggleNavigator();
                  }}
                >
                  {!navigatorCollapsed && <span>答题卡</span>}
                  {navigatorCollapsed ? (
                    <PanelLeftOpen aria-hidden className="size-4" />
                  ) : (
                    <PanelLeftClose aria-hidden className="size-4" />
                  )}
                </Button>
              </h2>
              <div id={navigationId} hidden={navigatorCollapsed}>
                <QuestionNavigator
                  items={navigationItems}
                  currentId={currentQuestionId}
                  onJump={jumpForMode}
                  locked={singleMode && practiceSubmit.submittingId !== null}
                />
              </div>
            </aside>

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

              {/* 做题方式摘要行（§7.1）：v1 卷列表模式才常驻；单题模式经「更多」
                  在弹窗打开同一编辑器（见下 PracticeModeDialog）；legacy/lesson
                  不渲染。M5-D3：节奏切换 PATCH 以服务端投影 revision 为 CAS
                  基线；在途与就地提示（stale/服务端 message）透传 */}
              {practiceModeEditor !== null && total > 0 && !singleMode && (
                <PracticeModeSummary
                  open={modeSettingsOpen}
                  onOpenChange={setModeSettingsOpen}
                  {...practiceModeEditor}
                />
              )}

              {/* 题卡列表（ref 注册进视口观察：question_view + 聚焦兜底，T2.10）。
              T2A.7：多单元作业按单元分节（节标题 = 单元标题），题号全卷连续。
              M3-D1 单题专注：同一 keyed 序列仅隐藏非当前题（不卸载不搬卡），
              单元节头在单题态不显示（紧凑结构，§7.2）。
              QM-08：题目序经 groupSegmentsOfUnit 解释成独立题段/题组段——组段
              的共享材料按组渲染一份（数据解释单源）。审查 P1 修复：题组只是
              题行 ol 里的兄弟锚点（QuestionGroupAnchor），题行永不进组子树，
              context 后到/重试成功不重挂题卡（控制器随行存活）。 */}
              <ol className={total === 0 ? "hidden" : "flex flex-col gap-4"}>
                {data.units.map((unit) => {
                  const questionById = new Map(
                    unit.questions.map(
                      (question) => [question.id, question] as const,
                    ),
                  );
                  const segments = groupSegmentsOfUnit(
                    contextQuery.data,
                    unit.questions.map((question) => question.id),
                  );
                  // compare 网格仅对确有题组的单元开启（AI 对照激活/单题态
                  // 回退上下排布）；无组单元保持纯 flex 零变化
                  const unitHasGroups = segments.some(
                    (segment) => segment.kind === "group",
                  );
                  const groupGrid =
                    unitHasGroups && !singleMode && !compareActive;
                  /** 单题行渲染（组行/独立行共用；onOpenMaterial 仅组内带材料题挂） */
                  const renderRow = (
                    question: (typeof unit.questions)[number],
                    onOpenMaterial?: () => void,
                    grouped = false,
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
                    return (
                      <AttemptQuestionRow
                        key={question.id}
                        className={
                          groupGrid
                            ? grouped
                              ? "min-w-0 xl:col-start-2"
                              : "min-w-0 xl:col-span-2"
                            : undefined
                        }
                        cardElements={cardElements}
                        events={attemptEvents}
                        index={index}
                        question={question}
                        assignmentTitle={data.title}
                        answer={answers?.[question.id]}
                        onAnswer={setAnswer}
                        attemptId={attemptId}
                        flagged={flaggedQuestions.has(question.id)}
                        onToggleFlag={toggleFlag}
                        formalInkPresence={
                          formalInkPresence.get(question.id) ?? false
                        }
                        onInkPresenceChange={onInkPresenceChange}
                        registerInkController={registerInkController}
                        hints={hintsOpened[question.id]}
                        onHintUnlocked={unlockHint}
                        {...(onOpenMaterial !== undefined
                          ? { onOpenMaterial }
                          : {})}
                        aiTrigger={aiCompanion.triggerForQuestion(question.id)}
                        aiContent={aiCompanion.inlineForQuestion(question.id)}
                        hidden={
                          singleMode && question.id !== resolvedSingleQuestionId
                        }
                        readOnly={
                          practiceProtocol === "v1" && practiceSubmitted
                        }
                        footer={
                          practiceProtocol === "v1" ? (
                            <PracticeQuestionFooter
                              attemptId={attemptId}
                              mode={singleMode ? "single" : "list"}
                              submitted={practiceSubmitted}
                              readable={practiceRow?.feedbackReadable ?? false}
                              answered={
                                navigationItems[index]?.completion.state ===
                                "filled"
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
                          unitHasGroups
                            ? groupGrid
                              ? "compare"
                              : "stack"
                            : undefined
                        }
                        className={
                          groupGrid
                            ? "flex min-w-0 flex-col gap-4 xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
                            : "flex flex-col gap-4"
                        }
                      >
                        {segments.map((segment) =>
                          segment.kind === "solo"
                            ? segment.questionIds.map((questionId) => {
                                const question = questionById.get(questionId);
                                return question === undefined
                                  ? null
                                  : renderRow(question, undefined, false);
                              })
                            : [
                                <QuestionGroupAnchor
                                  key={`group:${segment.group.id}`}
                                  group={segment.group}
                                  materials={segment.materials}
                                  questionCount={segment.questionIds.length}
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

        <Dialog open={navigatorOpen} onOpenChange={setNavigatorOpen}>
          <DialogContent
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (singleWorkspaceRef.current?.contains(document.activeElement))
                return;
              navigatorTrigger.current?.focus();
            }}
            className="flex max-h-[70dvh] w-[calc(100%-24px)] flex-col rounded-lg"
          >
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Grid2X2 aria-hidden className="size-4" />
                答题卡
              </DialogTitle>
              <DialogDescription>
                已填写 {answered}/{total} 题
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-y-auto overscroll-contain p-1">
              <QuestionNavigator
                items={navigationItems}
                currentId={currentQuestionId}
                onJump={jumpForMode}
                locked={singleMode && practiceSubmit.submittingId !== null}
              />
            </div>
          </DialogContent>
        </Dialog>

        {/* 快捷键帮助（M3-D3 §9.2）：v1 卷菜单入口的落点；挂在菜单子树外 */}
        {practiceWorkflow !== undefined && (
          <PracticeKeyboardHelpDialog
            open={keyboardHelpOpen}
            onOpenChange={setKeyboardHelpOpen}
          />
        )}

        {/* 吸底操作条：已答进度 + 保存状态 + 离线/无权限/错误提示 + 交卷（禁用态见组件）。
            v1 卷追加已提交进度；全部收尾后主按钮换「查看本次结果」（列表模式入口，
            单题模式主动作位同款按钮已承担） */}
        <AttemptBottomBar
          primaryActions={singleActions}
          progressLabel={
            singleMode
              ? `第 ${singleIndex + 1} / ${total} 题 · 已${singleCanSubmit ? "提交" : "填写"} ${singleProgressCount} 题`
              : undefined
          }
          progressValue={
            singleMode
              ? total === 0
                ? 0
                : singleProgressCount / total
              : undefined
          }
          hideSubmit={
            singleMode &&
            !practiceWorkflow?.canSubmitQuestion &&
            singleIndex === total - 1
          }
          answered={answered}
          total={total}
          offline={!online}
          denied={denied}
          saveFailed={saveFailed}
          inkFlushError={inkFlushError}
          submitError={submitError}
          practiceSubmittedCount={
            practiceProtocol === "v1" ? submittedPracticeCount : undefined
          }
          viewResult={practiceProtocol === "v1" && practiceSubmit.finished}
          onViewResult={() => practiceSubmit.viewResult()}
          onOpenSubmit={openSubmitDialog}
          onOpenNavigator={openNavigator}
        />

        {singleMode && practiceModeEditor !== null && (
          <PracticeModeDialog
            open={modeSettingsOpen}
            onOpenChange={setModeSettingsOpen}
            onReturnFocus={() => {
              singleWorkspaceRef.current
                ?.closest('[data-slot="attempt-workspace"]')
                ?.querySelector<HTMLButtonElement>(
                  'button[aria-label="练习更多"]',
                )
                ?.focus();
            }}
            {...practiceModeEditor}
          />
        )}

        {/* 逐题提交缺稿明确选择弹层：choice→busy→error 相在 runPracticeSubmit 内迁移 */}
        <PracticeSubmitProblemDialog
          open={practiceProblem !== null}
          phase={practiceProblem?.phase ?? { kind: "choice", reason: "" }}
          onCancel={() => setPracticeProblem(null)}
          onConfirm={() => {
            const target = practiceProblem?.questionId;
            if (target === undefined) return;
            setPracticeProblem((prev) =>
              prev !== null ? { ...prev, phase: { kind: "busy" } } : prev,
            );
            void runPracticeSubmit(target, { allowMissing: true });
          }}
        />

        <SubmitConfirmDialog
          open={confirmOpen}
          unansweredCount={unanswered}
          submitting={submit.isPending}
          preparing={notePrep.kind === "preparing"}
          noteSummary={noteSummary}
          noteProblems={evidenceProblemViewsOf(notePrep, questionIndexById)}
          choiceMode={notePrep.kind === "choice"}
          notePrepError={notePrep.kind === "error" ? notePrep.message : null}
          dueAt={data.dueAt}
          answerRelease={data.answerRelease}
          onConfirm={() => void confirmSubmit()}
          onConfirmMissing={confirmMissingSubmit}
          onCancel={closeSubmitDialog}
          incompleteQuestions={navigationItems
            .filter((item) => item.completion.state !== "filled")
            .map((item) => ({
              id: item.id,
              index: item.index,
              label: completionLabel(item.completion),
            }))}
          onGoToQuestion={(id) => {
            closeSubmitDialog();
            void jumpForMode(id, true);
          }}
        />
      </AttemptWorkspace>
    </DraftSyncProvider>
  );
}
