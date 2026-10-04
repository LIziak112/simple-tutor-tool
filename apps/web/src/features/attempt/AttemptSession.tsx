import { useMutation } from "@tanstack/react-query";
import type {
  AttemptDetailData,
  AttemptDraftData,
  AttemptResultData,
  HintOpenedEntry,
} from "@tutor/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { AttemptBottomBar } from "@/features/attempt/AttemptBottomBar";
import { AttemptQuestionCard } from "@/features/attempt/AttemptQuestionCard";
import { AttemptResultView } from "@/features/attempt/AttemptResultView";
import { DraftStatusBar } from "@/features/attempt/DraftStatusBar";
import { draftStore } from "@/features/attempt/draft-store";
import { SubmitConfirmDialog } from "@/features/attempt/SubmitConfirmDialog";
import { useAttemptAnswers } from "@/features/attempt/use-attempt-answers";
import { useAttemptEvents } from "@/features/attempt/use-attempt-events";
import {
  DraftSyncContext,
  useDraftSync,
} from "@/features/attempt/use-draft-sync";
import type { InkUploadController } from "@/features/attempt/use-ink-upload";
import { startWrongPracticeApi } from "@/lib/api";
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

export function AttemptSession({
  data,
  onExit,
}: {
  data: AttemptDetailData;
  /** 退出（返回首页/课程等；结果视图按钮与空试卷兜底用） */
  onExit: () => void;
}) {
  if (isResultDetail(data)) {
    return <AttemptResultWithDraftCleanup data={data} onBackHome={onExit} />;
  }
  return (
    <AnswerView data={data} attemptId={data.attempt.id} onBackHome={onExit} />
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
}: {
  data: AttemptResultData;
  onBackHome: () => void;
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
}: {
  data: AttemptDraftData;
  attemptId: string;
  onBackHome: () => void;
}) {
  /** 手写题的笔迹上传 controller（mount 注册、unmount 注销；交卷前逐题 flush，
   *  草稿同步循环也会逐题 sync——先声明再传给 useDraftSync） */
  const inkControllers = useRef(new Map<string, InkUploadController>());
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
  /** 笔迹 flush 进行中（交卷按钮/确认弹层的等待态） */
  const [inkFlushing, setInkFlushing] = useState(false);
  const submit = useSubmitAttempt(attemptId);

  // T2A.7：题目按单元分组下发；答题页平铺渲染、题号全卷连续（累计 index）。
  // 多单元时渲染节标题（单元标题），单单元不显示节头（避免与课程练习标题重复）。
  const flatQuestions = data.units.flatMap((unit) => unit.questions);
  const showUnitHeaders = data.units.length > 1;
  const questionIds = flatQuestions.map((question) => question.id);
  const total = flatQuestions.length;
  const answered = answers === null ? 0 : answeredCount(questionIds);
  const unanswered = total - answered;

  /**
   * 交卷（T2.8 口径）：先把每道手写题的最新笔迹 flush 上传（Promise.all），
   * 任一失败 → 阻止交卷并提示重试（「交卷时确保每道手写题最新笔迹已上传」）；
   * 全部成功后先收尾学习痕迹（T2.10：blur 当前聚焦 + submit 事件 + 事件队列
   * flush——保证服务端交卷计算时事件序列已入库），再调 submit（服务端判分），
   * 成功后清本地草稿（T2.9）。失败时关闭确认弹层让底栏提示可见（重新点
   * 「交卷」即可重试 flush）。
   */
  const confirmSubmit = async () => {
    setInkFlushing(true);
    setInkFlushError(false);
    const results = await Promise.all(
      [...inkControllers.current.values()].map((controller) =>
        controller.flush(),
      ),
    );
    setInkFlushing(false);
    if (!results.every(Boolean)) {
      setInkFlushError(true);
      setConfirmOpen(false);
      return;
    }
    // T2.10：submit 前收尾事件（尽力 flush；失败不阻塞交卷，宽松口径兜底迟到事件）
    await attemptEvents.finalizeSubmit();
    submit.mutate(undefined, {
      onSuccess: () => {
        void draftStore.clearDraft(attemptId);
      },
      onSettled: () => setConfirmOpen(false),
    });
  };

  // 交卷失败（网络等）：留在答题视图，底栏提示后可重试
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
          onOpenSubmit={() => setConfirmOpen(true)}
        />

        <SubmitConfirmDialog
          open={confirmOpen}
          unansweredCount={unanswered}
          submitting={submit.isPending || inkFlushing}
          onConfirm={() => void confirmSubmit()}
          onCancel={() => setConfirmOpen(false)}
        />
      </div>
    </DraftSyncContext.Provider>
  );
}
