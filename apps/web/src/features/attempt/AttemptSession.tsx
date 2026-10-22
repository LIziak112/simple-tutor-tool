import type {
  AttemptDetailData,
  AttemptDraftData,
  AttemptResultData,
  HintOpenedEntry,
  PracticeLayout,
} from "@tutor/contract";
import { HANDWRITTEN_QUESTION_TYPES } from "@tutor/contract";
import { Grid2X2, PanelLeftClose, PanelLeftOpen, RotateCw } from "lucide-react";
import {
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
import { catchUpAnnotations } from "@/features/annotation/annotation-sync";
import { AttemptBottomBar } from "@/features/attempt/AttemptBottomBar";
import { AttemptHeader } from "@/features/attempt/AttemptHeader";
import { AttemptQuestionRow } from "@/features/attempt/AttemptQuestionRow";
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
import { useSubmitAttempt } from "./attempt-queries";
import { focusWhenReachable } from "./focus-when-reachable";
import {
  type PracticeProblemPhase,
  PracticeQuestionFooter,
  PracticeSingleActions,
  PracticeSubmitProblemDialog,
} from "./PracticeQuestionSubmit";
import {
  PracticeLayoutMenuItems,
  PracticeModeSummary,
  SingleQuestionActionBar,
  SingleQuestionProgressRow,
} from "./PracticeWorkspace";
import {
  getPracticePreference,
  usePracticePreference,
} from "./practice-preference-store";
import {
  countSubmittedQuestions,
  firstUnsubmittedQuestionId,
  practiceProtocolOfDraft,
} from "./practice-protocol";
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
  const [navigatorOpen, setNavigatorOpen] = useState(false);
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
  const aiCompanion = useAiCompanionDock({
    attemptId,
    questions: flatQuestions,
    isHandwritten: (questionId) =>
      flatQuestions.some(
        (question) =>
          question.id === questionId &&
          HANDWRITTEN_QUESTION_TYPES.includes(question.type),
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
  // 布局本次作答内自决：进入时取默认偏好一次，之后只随显式切换变化，
  // 不被偏好变更或后台重取中途拉扯；不写回默认偏好（§7.1）
  const [practiceLayout, setPracticeLayout] = useState<PracticeLayout>(() =>
    practiceProtocol === "v1" ? getPracticePreference().layout : "list",
  );
  // M3-D1.5：硬刷新直达作答页时，布局层的账号绑定 effect 晚于本组件首渲染，
  // 已保存默认布局会在初值时被错过——store 从未绑定变已绑定的那一刻按已
  // 保存默认布局对齐一次；用户显式切换过布局之后，绑定变化与跨标签偏好
  // 变更都不得再拉扯当前选择（§7.1「进入时取一次」语义的补全）
  const explicitLayoutRef = useRef(false);
  const setPracticeLayoutExplicit = useCallback((layout: PracticeLayout) => {
    explicitLayoutRef.current = true;
    setPracticeLayout(layout);
  }, []);
  const { accountId: boundAccountId } = usePracticePreference();
  const prevBoundAccountRef = useRef(boundAccountId);
  useEffect(() => {
    const previous = prevBoundAccountRef.current;
    prevBoundAccountRef.current = boundAccountId;
    if (practiceProtocol !== "v1" || explicitLayoutRef.current) return;
    // 只在「未绑定 → 已绑定」迁移时对齐一次；换绑与解绑不拉扯
    if (previous !== null || boundAccountId === null) return;
    setPracticeLayout(getPracticePreference().layout);
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
    flushAnswers,
    inkControllers,
    beforeSubmit: async () => (editor === null ? true : editor.request(null)),
  });
  const practiceProgress =
    practiceProtocol === "v1" ? practiceSubmit.progress : [];
  const submittedPracticeCount = countSubmittedQuestions(practiceProgress);
  const singleProgressRow =
    resolvedSingleQuestionId === null
      ? undefined
      : practiceProgress.find(
          (row) => row.questionId === resolvedSingleQuestionId,
        );
  // 缺稿明确选择弹层（§10.3）：证据组装发现未追平草稿时不静默放行——
  // choice（用户裁决）→ busy（确认后带 allowMissing 重提）→ error（重提失败留弹层）；
  // 其余 outcome（提交成功/受限/stale/取消）一律收起弹层（就地提示由 hook 承担）
  const [practiceProblem, setPracticeProblem] = useState<{
    questionId: string;
    phase: PracticeProblemPhase;
  } | null>(null);
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
              (practiceProgress.find((row) => row.questionId === question.id)
                ?.submittedAt ?? null) !== null,
            feedbackReadable:
              practiceProgress.find((row) => row.questionId === question.id)
                ?.feedbackReadable ?? false,
          },
        }
      : {}),
  }));
  const answered = navigationItems.filter(
    (item) => item.completion.state === "filled",
  ).length;
  const unanswered = total - answered;
  const jumpToQuestion = async (id: string, focusAnswer = false) => {
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
      focusWhenReachable(
        target ?? (focusAnswer ? answerControl : null) ?? article,
      );
    });
  };
  // 单题跳题（M3-D1）：与列表跳题同一收笔/滚动/聚焦链，另更新单题态与
  // 当前题标记（AI 伴学/导航跟随显式选择，§11 纪律 1 不重建题卡）。
  // jumpToQuestion 本身非 memo（每渲染重建），此处同法不包 useCallback
  const goSingleQuestion = async (id: string) => {
    // 提交在途禁切题（§7.2 busy）：上一题/下一题/导航均已禁用，此处兜底直调
    if (practiceSubmit.submittingId !== null) return;
    setSingleQuestionId(id);
    setCurrentQuestionId(id);
    await jumpToQuestion(id);
  };
  const jumpForMode = singleMode ? goSingleQuestion : jumpToQuestion;
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
      questionIds,
      submit,
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
    questionIds,
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

  return (
    <DraftSyncProvider value={{ ...draftSync, recovery: materialRecovery }}>
      <AttemptWorkspace>
        {/* 练习头：来源 + 标题 + 截止 + 草稿保存状态（T2.9 三态 + T2A.6 终态） */}
        <AttemptHeader
          title={data.title}
          menuItems={
            practiceWorkflow !== undefined ? (
              <PracticeLayoutMenuItems
                layout={practiceLayout}
                onChange={setPracticeLayoutExplicit}
              />
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
                  await jumpToQuestion(questionId);
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
                现上移到本列容器——保护期间新增的呈现件同样不可交互 */}
            <div
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

              {/* 做题方式摘要行（§7.1）：v1 卷才有；legacy/lesson 不渲染 */}
              {practiceWorkflow !== undefined && total > 0 && (
                <PracticeModeSummary
                  workflow={practiceWorkflow}
                  layout={practiceLayout}
                  onLayoutChange={setPracticeLayoutExplicit}
                />
              )}
              {singleMode && resolvedSingleQuestionId !== null && (
                <SingleQuestionProgressRow
                  current={singleIndex + 1}
                  total={total}
                  submittedCount={submittedPracticeCount}
                  onOpenNavigator={() => setNavigatorOpen(true)}
                />
              )}

              {/* 题卡列表（ref 注册进视口观察：question_view + 聚焦兜底，T2.10）。
              T2A.7：多单元作业按单元分节（节标题 = 单元标题），题号全卷连续。
              M3-D1 单题专注：同一 keyed 序列仅隐藏非当前题（不卸载不搬卡），
              单元节头在单题态不显示（紧凑结构，§7.2） */}
              <ol className={total === 0 ? "hidden" : "flex flex-col gap-4"}>
                {data.units.map((unit) => (
                  <li
                    key={unit.id}
                    hidden={
                      singleMode &&
                      !unit.questions.some(
                        (question) => question.id === resolvedSingleQuestionId,
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
                    <ol className="flex flex-col gap-4">
                      {unit.questions.map((question) => {
                        const index = flatQuestions.indexOf(question);
                        // v1 卷本题提交态（overlay 即时口径）：已提交行原位只读
                        // 并在 footer 槽追加反馈区；legacy/lesson 完全不挂
                        const practiceRow =
                          practiceProtocol === "v1"
                            ? practiceProgress.find(
                                (row) => row.questionId === question.id,
                              )
                            : undefined;
                        const practiceSubmitted =
                          (practiceRow?.submittedAt ?? null) !== null;
                        return (
                          <AttemptQuestionRow
                            key={question.id}
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
                            aiTrigger={aiCompanion.triggerForQuestion(
                              question.id,
                            )}
                            aiContent={aiCompanion.inlineForQuestion(
                              question.id,
                            )}
                            hidden={
                              singleMode &&
                              question.id !== resolvedSingleQuestionId
                            }
                            readOnly={
                              practiceProtocol === "v1" && practiceSubmitted
                            }
                            footer={
                              practiceProtocol === "v1" ? (
                                <PracticeQuestionFooter
                                  mode={singleMode ? "single" : "list"}
                                  submitted={practiceSubmitted}
                                  readable={
                                    practiceRow?.feedbackReadable ?? false
                                  }
                                  answered={
                                    navigationItems[index]?.completion.state ===
                                    "filled"
                                  }
                                  busy={
                                    practiceSubmit.submittingId === question.id
                                  }
                                  anyBusy={practiceSubmit.submittingId !== null}
                                  feedback={practiceSubmit.feedbackOf(
                                    question.id,
                                  )}
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
                      })}
                    </ol>
                  </li>
                ))}
              </ol>

              {/* 单题主操作条（§7.2）：三态接线——提交本题（含「不会」空答
                  案提交）→ 正在提交…（busy 禁切题）→ 已提交行下一题/查看本次
                  结果/继续未提交题目 */}
              {singleMode && resolvedSingleQuestionId !== null && (
                <SingleQuestionActionBar
                  hasPrev={singleIndex > 0}
                  hasNext={singleIndex < total - 1}
                  busy={practiceSubmit.submittingId !== null}
                  middle={
                    <PracticeSingleActions
                      submitted={
                        (singleProgressRow?.submittedAt ?? null) !== null
                      }
                      answered={
                        navigationItems[singleIndex]?.completion.state ===
                        "filled"
                      }
                      busy={practiceSubmit.submittingId !== null}
                      finished={practiceSubmit.finished}
                      hasNext={singleIndex < total - 1}
                      continueUnsubmittedId={
                        practiceSubmit.firstUnsubmittedId !== null &&
                        practiceSubmit.firstUnsubmittedId !==
                          resolvedSingleQuestionId
                          ? practiceSubmit.firstUnsubmittedId
                          : null
                      }
                      error={
                        practiceSubmit.lastError?.questionId ===
                        resolvedSingleQuestionId
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
              )}
            </div>
          </div>,
        )}

        <Dialog open={navigatorOpen} onOpenChange={setNavigatorOpen}>
          <DialogContent className="flex max-h-[70dvh] w-[calc(100%-24px)] flex-col rounded-lg">
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

        {/* 吸底操作条：已答进度 + 保存状态 + 离线/无权限/错误提示 + 交卷（禁用态见组件）。
            v1 卷追加已提交进度；全部收尾后主按钮换「查看本次结果」（列表模式入口，
            单题模式主动作位同款按钮已承担） */}
        <AttemptBottomBar
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
          viewResult={
            practiceProtocol === "v1" && !singleMode && practiceSubmit.finished
          }
          onViewResult={() => practiceSubmit.viewResult()}
          onOpenSubmit={openSubmitDialog}
          onOpenNavigator={() => setNavigatorOpen(true)}
        />

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
            jumpToQuestion(id, true);
          }}
        />
      </AttemptWorkspace>
    </DraftSyncProvider>
  );
}
