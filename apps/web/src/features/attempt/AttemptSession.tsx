import { useMutation } from "@tanstack/react-query";
import type {
  AttemptDetailData,
  AttemptDraftData,
  AttemptResultData,
  HintOpenedEntry,
} from "@tutor/contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { AttemptBottomBar } from "@/features/attempt/AttemptBottomBar";
import { AttemptQuestionCard } from "@/features/attempt/AttemptQuestionCard";
import { AttemptResultView } from "@/features/attempt/AttemptResultView";
import { DraftStatusBar } from "@/features/attempt/DraftStatusBar";
import { draftStore } from "@/features/attempt/draft-store";
import {
  SubmitConfirmDialog,
  type SubmitNoteSummary,
} from "@/features/attempt/SubmitConfirmDialog";
import { useAttemptAnswers } from "@/features/attempt/use-attempt-answers";
import { useAttemptEvents } from "@/features/attempt/use-attempt-events";
import {
  DraftSyncContext,
  useDraftSync,
} from "@/features/attempt/use-draft-sync";
import type { InkUploadController } from "@/features/attempt/use-ink-upload";
import {
  prepareSubmitEvidence,
  type SubmitEvidencePrep,
  type SubmitEvidenceProblem,
  snapshotNoteOverview,
} from "@/features/notes/submit-evidence";
import { startWrongPracticeApi, sealAttemptAnnotationsApi } from "@/lib/api";
import { createEventQueue } from "@/lib/event-queue";
import { formatDueTime } from "@/lib/time";
import { useOnlineStatus } from "@/lib/use-online-status";
import { useSubmitAttempt } from "./attempt-queries";

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

/** 来源行文案：课程练习带次数；作业显示「作业」（挂课程时「作业 · 课程名」，T2A.7）；
 * 错题重练显示「错题重练 · 第 n 次」（2026-10，与结果视图/记录卡同口径） */
function sourceLabel(data: AttemptDetailData): string {
  if (data.attempt.sourceType === "course") {
    return `课程：${data.courseName ?? ""} · 第 ${data.attempt.attemptNo} 次`;
  }
  if (data.attempt.sourceType === "wrong") {
    return `错题重练 · 第 ${data.attempt.attemptNo} 次`;
  }
  return data.courseName !== null ? `作业 · ${data.courseName}` : "作业";
}

/**
 * 交卷准备阶段（T6R.10，验收修复 A-4）：单一判别联合替代原先三个独立
 * state（preparing/problems/error）——阶段迁移一次 set 完成，弹层各分支
 * （等待文案/明确选择/阻止性错误）据此渲染，不存在中间组合态。
 */
type NotePrepPhase =
  | { kind: "idle" }
  | { kind: "preparing" }
  /** 阻止性错误（head 拉取失败等）；problems=进入 error 前的最近一次清单
   *  （choice 快照，可 null）——错误文案与问题列表都可见；进 error 时清空
   *  缺稿确认集（下轮普通确认重新权威判定，缺稿题重新显式确认） */
  | { kind: "error"; message: string; problems: SubmitEvidenceProblem[] | null }
  /** 明确选择分支（problems 必非空：由 declarations=null ⇔ problems.length>0 推导） */
  | { kind: "choice"; problems: SubmitEvidenceProblem[] };

export function AttemptSession({
  data,
  onExit,
}: {
  data: AttemptDetailData;
  /** 退出（返回首页/课程等；结果视图按钮与空试卷兜底用） */
  onExit: () => void;
}) {
  /**
   * T6R.20 审查修复 2：交卷后的标注封存警示（seal 挪到交卷成功回调内
   * 非阻断执行）。状态放在本组件（答题↔结果视图切换时实例稳定不丢），
   * 由 AnswerView 的交卷成功回调写入、结果视图顶部横幅呈现。
   */
  const [annotationSealWarning, setAnnotationSealWarning] = useState(false);
  if (isResultDetail(data)) {
    return (
      <AttemptResultWithDraftCleanup
        data={data}
        onBackHome={onExit}
        annotationSealWarning={annotationSealWarning}
      />
    );
  }
  return (
    <AnswerView
      data={data}
      attemptId={data.attempt.id}
      onBackHome={onExit}
      onAnnotationSealFailed={() => setAnnotationSealWarning(true)}
    />
  );
}

/**
 * 结果视图外壳（T2.9）：进入即清本地草稿——覆盖「在别的设备交卷后，本机残留
 * 旧草稿」的路径（正常交卷在 AnswerView 里清，这里是兜底，幂等）。
 * T4.0b（§5.0-C12）：自建 attempt scope 队列实例（同一 attemptId）收
 * directive_interact{host:result} 复盘事件——requireUsableAttempt 宽松口径
 * 已支持交卷后上报，无需改服务端；离开结果页 dispose（内部尽力 flush）。
 * 2026-10：「练习本卷错题」直达重练——POST /wrong-practice（questionIds 由
 * AttemptResultView 按本卷判错题回传）成功后跳新卷作答（与错题本「重练本组」
 * 同一动线）；失败把服务端中文信息回传结果视图告警展示。
 */
function AttemptResultWithDraftCleanup({
  data,
  onBackHome,
  annotationSealWarning = false,
}: {
  data: AttemptResultData;
  onBackHome: () => void;
  /** 交卷后标注 seal 失败的警示（AttemptSession 顶态；服务端懒补封兜底） */
  annotationSealWarning?: boolean;
}) {
  const attemptId = data.attempt.id;
  const navigate = useNavigate();
  useEffect(() => {
    void draftStore.clearDraft(attemptId);
  }, [attemptId]);
  const queueRef = useRef<ReturnType<typeof createEventQueue> | null>(null);
  useEffect(() => {
    const queue = createEventQueue({ scope: { kind: "attempt", attemptId } });
    queueRef.current = queue;
    return () => {
      queue.dispose();
      queueRef.current = null;
    };
  }, [attemptId]);
  /** 详解折叠开合 → directive_interact{host=result}；index=该题全卷 0 起序号 */
  const onSolutionToggle = useRef(
    (questionId: string, index: number, action: "open" | "close") => {
      queueRef.current?.track({
        type: "directive_interact",
        clientTs: Date.now(),
        host: "result",
        attemptId,
        questionId,
        name: "solution",
        index,
        action,
      });
    },
  ).current;
  // 练习本卷错题（2026-10）：组新重练卷 → 跳作答；失败留告警可重试
  const practice = useMutation({
    mutationFn: (questionIds: string[]) => startWrongPracticeApi(questionIds),
    onSuccess: (attempt) => {
      void navigate(`/s/attempts/${attempt.id}`);
    },
  });
  const practiceErrorText = practice.isError
    ? practice.error instanceof Error
      ? practice.error.message
      : "网络异常，请稍后重试"
    : null;
  return (
    <AttemptResultView
      data={data}
      onBackHome={onBackHome}
      onSolutionToggle={onSolutionToggle}
      annotationSealWarning={annotationSealWarning}
      wrongPractice={{
        loading: practice.isPending,
        error: practiceErrorText,
        onStart: (questionIds) => {
          if (questionIds.length === 0) return; // 判错 0 题按钮本就不渲染（防御）
          practice.mutate(questionIds);
        },
      }}
    />
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
  const draftSync = useDraftSync(attemptId, data.drafts, inkControllers);
  // 学习痕迹埋点（T2.10）：attempt_start/聚焦/answer_change/ink/page_*/submit
  const attemptEvents = useAttemptEvents(attemptId);
  const { answers, setAnswer, answeredCount, saveFailed } = useAttemptAnswers(
    attemptId,
    draftSync.recoveredDrafts,
    draftSync,
    {
      // 保存生效点：聚焦切到该题 + answer_change 事件（from=上次上报值）
      onAnswerCommitted: (questionId, answer) => {
        attemptEvents.noteInteraction(questionId);
        attemptEvents.trackAnswerChange(questionId, answer);
      },
    },
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  /**
   * 已解锁提示（T2.11）：初值取草稿视图回显（刷新不丢），解锁成功后本地追加；
   * 详情数据变化时以服务端值为准重置（服务端在解锁接口内已同步记录，
   * 正常流不含丢失窗口）。hint_open 事件服务端在接口内直记（不经前端队列）。
   */
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
  // T6R.10：草稿证据准备阶段——单一判别联合（preparing/error/choice 一次
  // set 完成迁移，弹层各分支据此渲染；ink flush 进行中并入 preparing）
  const [notePrep, setNotePrep] = useState<NotePrepPhase>({ kind: "idle" });
  /** 弹层打开时的草稿计数快览（本地态；详见 snapshotNoteOverview） */
  const [noteSummary, setNoteSummary] = useState<SubmitNoteSummary | null>(
    null,
  );
  /** 快览代际（防旧 open 的迟到 then 覆盖新一轮弹层数据） */
  const summarySeqRef = useRef(0);
  /** 交卷准备中止标志：弹层关闭（=取消）置位，confirmSubmit 各 await 段后检查 */
  const submitAbortedRef = useRef(false);
  /** 用户已确认缺稿交卷的题（「草稿未保存完整」明确选择后重跑组装传入） */
  const missingConfirmedRef = useRef<Set<string> | null>(null);
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
  const answered = answers === null ? 0 : answeredCount(questionIds);
  const unanswered = total - answered;

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
  /** 题号映射（1 起序号——明确选择分支按「第 n 题」呈现问题） */
  const questionIndexById = useMemo(
    () =>
      new Map(
        flatQuestions.map((question, i) => [question.id, i + 1] as const),
      ),
    [flatQuestions],
  );

  /**
   * 打开交卷弹层：重置明确选择分支并取草稿本地快览（无网络，纯内存态——
   * 确认时以 prepareSubmitEvidence 的权威判定为准）。
   */
  const openSubmitDialog = useCallback(() => {
    setNotePrep({ kind: "idle" });
    missingConfirmedRef.current = null;
    submitAbortedRef.current = false;
    setNoteSummary(null); // 上一轮的快览不带入新弹层
    setConfirmOpen(true);
    // 快照代际守卫：仅最新一次 open 的 then 可 set（旧 open 的迟到快照作废）
    const seq = ++summarySeqRef.current;
    void snapshotNoteOverview({ attemptId, questionIds }).then((statuses) => {
      if (seq !== summarySeqRef.current) return;
      const willFreeze = statuses.filter(
        (s) => s.kind === "will-freeze",
      ).length;
      const problem = statuses.filter((s) => s.kind === "problem").length;
      // 完全没动过草稿时不展示该区（避免无信息噪音）
      setNoteSummary(
        willFreeze + problem > 0
          ? {
              willFreeze,
              problem,
              unwritten: statuses.length - willFreeze - problem,
            }
          : null,
      );
    });
  }, [attemptId, questionIds]);

  /**
   * 关闭交卷弹层 = 取消 = 中止准备链：置 abort 标志（confirmSubmit 各
   * await 段后检查）并复位准备阶段。busy 期间 Radix 关闭路径已被弹层
   * 封堵（Esc/遮罩/×），此处是唯一的正常关闭入口（继续作答按钮）与
   * 防御纵深（未来新增的关闭路径同样被 abort 拦下）。
   */
  const closeSubmitDialog = useCallback(() => {
    submitAbortedRef.current = true;
    setNotePrep({ kind: "idle" });
    setConfirmOpen(false);
  }, []);

  /**
   * 交卷（T2.8 口径 + T6R.10 证据固定，方案 §6.4 六步）：
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
   * 失败时关闭确认弹层让底栏提示可见（重新点「交卷」即可重试整条链）；
   * 响应丢失重试撞 409 ALREADY_SUBMITTED 由 useSubmitAttempt 失效详情
   * 切结果视图（不自动重交）。
   */
  const confirmSubmit = useCallback(async () => {
    setInkFlushError(false);
    setNotePrep({ kind: "preparing" });
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
      prep = await prepareSubmitEvidence({
        attemptId,
        questionIds,
        ...(missingConfirmedRef.current !== null
          ? { allowMissing: missingConfirmedRef.current }
          : {}),
      });
    } catch (err) {
      // 弹层已关（中止）：错误相也不落地（onClose 已复位 idle）
      if (submitAbortedRef.current) return;
      // 阻止性失败（head 拉取失败等）：如实提示 + 保留最近一次 problems
      // 清单（进入 error 前的 choice 快照），并清空缺稿确认集——下轮普通
      // 确认重新权威判定，缺稿题重新显式确认
      missingConfirmedRef.current = null;
      setNotePrep((prev) => ({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "草稿状态获取失败，请检查网络后重试",
        problems: prev.kind === "choice" ? prev.problems : null,
      }));
      return;
    }
    if (submitAbortedRef.current) return; // 弹层已关：状态已由 close 复位
    const inkResults = await inkPromise;
    if (submitAbortedRef.current) return;
    // ink 失败早退阻止交卷（prep 结果弃用——副作用无害）
    if (!inkResults.every(Boolean)) {
      setInkFlushError(true);
      setConfirmOpen(false);
      setNotePrep({ kind: "idle" });
      return;
    }
    if (prep.declarations === null) {
      // 有未追平草稿：明确选择分支（不静默 missing，不提供普通确认）。
      // problems 必非空——declarations=null 由 problems.length>0 推导（不变量）
      setNotePrep({ kind: "choice", problems: prep.problems });
      return;
    }
    // T2.10：submit 前收尾事件（尽力 flush；失败不阻塞交卷，宽松口径兜底迟到事件）
    await attemptEvents.finalizeSubmit();
    if (submitAbortedRef.current) return;
    // 两阶段 busy 分离：准备完毕、进入提交——不再显示「正在同步草稿」
    setNotePrep({ kind: "idle" });
    submit.mutate(
      { revisions: submitRevisions, evidence: prep.declarations },
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
        onSettled: () => {
          setConfirmOpen(false);
          setNotePrep({ kind: "idle" });
        },
      },
    );
  }, [
    attemptEvents,
    attemptId,
    onAnnotationSealFailed,
    questionIds,
    submit,
    submitRevisions,
  ]);

  /**
   * 缺稿交卷的明确确认（T6R.10）：用户选择「提交答案，草稿未保存完整」后
   * 登记确认题集并重跑组装——期间自愈的题按事实 frozen，仍失败的题如实
   * 标 missing（本地稿保留，之后找回只能作为补充材料）。
   */
  const confirmMissingSubmit = useCallback(() => {
    if (notePrep.kind !== "choice") return;
    // 并集累积（P0-1）：两批 problem 先后出现（A 持续未愈 + B 新增冲突）
    // 各自确认一次后，两题都必须按用户明示的 missing 提交——覆盖式赋值
    // 会丢掉第一批确认
    const confirmed = new Set(missingConfirmedRef.current ?? []);
    for (const problem of notePrep.problems) confirmed.add(problem.questionId);
    missingConfirmedRef.current = confirmed;
    void confirmSubmit();
  }, [confirmSubmit, notePrep]);

  // 交卷失败：网络等错误留中文提示；QUESTION_REVISION_STALE（旧标签页/陈旧
  // 页面）由服务端中文 message 直接提示刷新重交（T6R.3）
  const submitError = submit.isError
    ? submit.error instanceof Error
      ? submit.error.message
      : "交卷失败，请稍后重试"
    : null;

  // 离线状态（T2.12）：离线时禁用交卷并提示（作答照常，草稿本地保存）
  const online = useOnlineStatus();

  // 访问权终态（T2A.6，D7）：已无权限时收起交卷入口（交卷必然同样被拒）
  const denied = draftSync.status.state === "denied";

  return (
    <DraftSyncContext.Provider value={draftSync}>
      <div className="flex flex-col gap-5 pb-24">
        {/* 练习头：来源 + 标题 + 截止 + 草稿保存状态（T2.9 三态 + T2A.6 终态） */}
        <header className="flex flex-col gap-1.5 rounded-2xl border border-border bg-card px-4 py-4 shadow-xs sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <h1 className="min-w-0 text-xl font-bold break-words">
              {data.title}
            </h1>
            <div className="shrink-0 pt-1">
              <DraftStatusBar status={draftSync.status} />
            </div>
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{sourceLabel(data)}</span>
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
        </header>

        {/* 空试卷：单元没有可作答的题目 */}
        {total === 0 && (
          <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-10 text-center">
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
            T2A.7：多单元作业按单元分节（节标题 = 单元标题），题号全卷连续 */}
        <ol className="flex flex-col gap-4">
          {data.units.map((unit) => (
            <li key={unit.id} className="flex flex-col gap-4">
              {showUnitHeaders && (
                <h2 className="flex items-center gap-2 pt-2 text-sm font-semibold text-foreground before:h-4 before:w-1 before:rounded-full before:bg-primary">
                  {unit.title}
                </h2>
              )}
              <ol className="flex flex-col gap-4">
                {unit.questions.map((question) => {
                  const index = flatQuestions.indexOf(question);
                  return (
                    <li
                      key={question.id}
                      ref={(el) => attemptEvents.registerCard(question.id, el)}
                    >
                      <AttemptQuestionCard
                        index={index}
                        question={question}
                        answer={answers?.[question.id]}
                        onAnswer={(answer, defer) =>
                          setAnswer(question.id, answer, defer ?? false)
                        }
                        attemptId={attemptId}
                        registerInkController={registerInkController}
                        onInkStroke={(strokes) => {
                          attemptEvents.noteInteraction(question.id);
                          attemptEvents.trackInkStrokes(question.id, strokes);
                        }}
                        onInkEdit={(reason) => {
                          attemptEvents.noteInteraction(question.id);
                          attemptEvents.trackInkEdit(question.id, reason);
                        }}
                        onInkFullscreen={(on) => {
                          attemptEvents.noteInteraction(question.id);
                          attemptEvents.trackInkFullscreen(question.id, on);
                        }}
                        hints={hintsOpened[question.id] ?? []}
                        onHintUnlocked={(entry) =>
                          unlockHint(question.id, entry)
                        }
                      />
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ol>

        {/* 吸底操作条：已答进度 + 保存状态 + 离线/无权限/错误提示 + 交卷（禁用态见组件） */}
        <AttemptBottomBar
          answered={answered}
          total={total}
          offline={!online}
          denied={denied}
          saveFailed={saveFailed}
          inkFlushError={inkFlushError}
          submitError={submitError}
          onOpenSubmit={openSubmitDialog}
        />

        <SubmitConfirmDialog
          open={confirmOpen}
          unansweredCount={unanswered}
          submitting={submit.isPending}
          preparing={notePrep.kind === "preparing"}
          noteSummary={noteSummary}
          noteProblems={
            notePrep.kind === "choice" || notePrep.kind === "error"
              ? (notePrep.problems
                  ?.map((problem) => {
                    const index = questionIndexById.get(problem.questionId);
                    // 题号必然在同卷集合内；防御 miss 过滤该条（不渲染「第 0 题」）
                    return index === undefined
                      ? null
                      : { index, reason: problem.reason };
                  })
                  .filter(
                    (view): view is { index: number; reason: string } =>
                      view !== null,
                  ) ?? null)
              : null
          }
          choiceMode={notePrep.kind === "choice"}
          notePrepError={notePrep.kind === "error" ? notePrep.message : null}
          onConfirm={() => void confirmSubmit()}
          onConfirmMissing={confirmMissingSubmit}
          onCancel={closeSubmitDialog}
        />
      </div>
    </DraftSyncContext.Provider>
  );
}
