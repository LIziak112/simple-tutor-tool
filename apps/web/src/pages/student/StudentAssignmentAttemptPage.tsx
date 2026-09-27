import type {
  AttemptDetailData,
  AttemptDraftData,
  AttemptResultData,
} from "@tutor/contract";
import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { AttemptQuestionCard } from "@/features/attempt/AttemptQuestionCard";
import { AttemptResultView } from "@/features/attempt/AttemptResultView";
import {
  useAttemptDetail,
  useStartAttempt,
  useSubmitAttempt,
} from "@/features/attempt/attempt-queries";
import { DraftStatusBar } from "@/features/attempt/DraftStatusBar";
import { draftStore } from "@/features/attempt/draft-store";
import { SubmitConfirmDialog } from "@/features/attempt/SubmitConfirmDialog";
import { useAttemptAnswers } from "@/features/attempt/use-attempt-answers";
import {
  DraftSyncContext,
  useDraftSync,
} from "@/features/attempt/use-draft-sync";
import type { InkUploadController } from "@/features/attempt/use-ink-upload";
import {
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";
import { formatDueTime } from "@/lib/time";

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
 * /s/assignments/:id 答题页（T2.6）：
 * 1. 进入即 POST attempt（幂等创建/取回）——draft 走答题视图，
 *    已交卷（submitted/graded）直接走结果视图（并清残留本地草稿，T2.9）；
 * 2. 答题视图：题卡列表（题号/题型徽章/难度/考点）、各题型作答控件、
 *    底部吸底操作条（已答 n/m + 交卷）；作答即保存草稿（文本防抖 600ms）；
 * 3. 交卷确认弹层显示未答数量 → POST submit（服务端判分）→ 切结果视图；
 * 4. 三态齐全（加载骨架/错误重试/空试卷提示），适配 iPad 横竖屏；
 * 5. 草稿防丢（T2.9）：作答同步写 IndexedDB，每 10 秒/切后台/断网恢复增量
 *    同步服务端，顶栏三态显示保存进度（draftSync + DraftStatusBar）。
 */

export default function StudentAssignmentAttemptPage() {
  const { id: assignmentId = "" } = useParams();
  const navigate = useNavigate();

  // 第 1 步：幂等创建/取回 attempt（进入页面触发一次；重试走错误态按钮）
  const startAttempt = useStartAttempt(assignmentId);
  const startMutate = startAttempt.mutate;
  useEffect(() => {
    if (assignmentId !== "") startMutate();
  }, [assignmentId, startMutate]);

  // 第 2 步：详情（draft→草稿视图 / 已交→结果视图）
  const attemptId = startAttempt.data?.id;
  const detailQuery = useAttemptDetail(attemptId);

  if (assignmentId === "") {
    return (
      <StudentErrorPanel
        title="地址不完整"
        message="缺少作业编号，请从首页的作业卡片重新进入。"
        onRetry={() => void navigate("/s/home")}
      />
    );
  }
  if (startAttempt.isPending) {
    return <StudentListSkeleton label="正在打开作业" />;
  }
  if (startAttempt.isError || startAttempt.data === undefined) {
    return (
      <StudentErrorPanel
        title="打不开这份作业"
        message={
          startAttempt.error instanceof Error
            ? startAttempt.error.message
            : "网络异常，请稍后重试"
        }
        onRetry={() => startAttempt.mutate()}
      />
    );
  }
  if (detailQuery.isPending) {
    return <StudentListSkeleton label="正在加载题目" />;
  }
  if (detailQuery.isError || detailQuery.data === undefined) {
    return (
      <StudentErrorPanel
        title="题目加载失败"
        message={
          detailQuery.error instanceof Error
            ? detailQuery.error.message
            : "网络异常，请稍后重试"
        }
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }

  const data = detailQuery.data;
  if (isResultDetail(data)) {
    return (
      <AttemptResultWithDraftCleanup
        data={data}
        onBackHome={() => void navigate("/s/home")}
      />
    );
  }
  return (
    <AnswerView
      data={data}
      attemptId={data.attempt.id}
      onBackHome={() => void navigate("/s/home")}
    />
  );
}

/**
 * 结果视图外壳（T2.9）：进入即清本地草稿——覆盖「在别的设备交卷后，本机残留
 * 旧草稿」的路径（正常交卷在 AnswerView 里清，这里是兜底，幂等）。
 */
function AttemptResultWithDraftCleanup({
  data,
  onBackHome,
}: {
  data: AttemptResultData;
  onBackHome: () => void;
}) {
  useEffect(() => {
    void draftStore.clearDraft(data.attempt.id);
  }, [data.attempt.id]);
  return <AttemptResultView data={data} onBackHome={onBackHome} />;
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
  const { answers, setAnswer, answeredCount, saveFailed } = useAttemptAnswers(
    attemptId,
    draftSync.recoveredDrafts,
    draftSync,
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** 笔迹上传失败提示（交卷 flush 失败时展示，重试交卷消除） */
  const [inkFlushError, setInkFlushError] = useState(false);
  /** 笔迹 flush 进行中（交卷按钮/确认弹层的等待态） */
  const [inkFlushing, setInkFlushing] = useState(false);
  const submit = useSubmitAttempt(attemptId);

  const questionIds = data.questions.map((question) => question.id);
  const total = data.questions.length;
  const answered = answers === null ? 0 : answeredCount(questionIds);
  const unanswered = total - answered;

  /**
   * 交卷（T2.8 口径）：先把每道手写题的最新笔迹 flush 上传（Promise.all），
   * 任一失败 → 阻止交卷并提示重试（「交卷时确保每道手写题最新笔迹已上传」）；
   * 全部成功才调 submit（服务端判分），成功后清本地草稿（T2.9）。
   * 失败时关闭确认弹层让底栏提示可见（重新点「交卷」即可重试 flush）。
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

  return (
    <DraftSyncContext.Provider value={draftSync}>
      <div className="flex flex-col gap-5 pb-24">
        {/* 作业头：标题 + 截止 + 草稿保存状态（T2.9 三态） */}
        <header className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <h1 className="text-lg font-bold">{data.title}</h1>
          <p className="text-xs text-muted-foreground">
            {data.dueAt === null
              ? "不限截止"
              : `${formatDueTime(data.dueAt)} 截止`}
          </p>
          <div className="ml-auto">
            <DraftStatusBar status={draftSync.status} />
          </div>
        </header>

        {/* 空试卷：单元没有可作答的题目 */}
        {total === 0 && (
          <div className="rounded-xl border border-dashed border-border bg-card px-6 py-10 text-center">
            <p className="text-sm font-medium">这份作业还没有题目</p>
            <p className="mt-1 text-sm text-muted-foreground">
              可能老师正在整理内容，请联系老师确认后再来。
            </p>
            <Button
              variant="outline"
              className="mt-4 min-h-11"
              onClick={onBackHome}
            >
              返回首页
            </Button>
          </div>
        )}

        {/* 题卡列表 */}
        <ol className="flex flex-col gap-4">
          {data.questions.map((question, index) => (
            <li key={question.id}>
              <AttemptQuestionCard
                index={index}
                question={question}
                answer={answers?.[question.id]}
                onAnswer={(answer, defer) =>
                  setAnswer(question.id, answer, defer ?? false)
                }
                attemptId={attemptId}
                registerInkController={registerInkController}
              />
            </li>
          ))}
        </ol>

        {/* 吸底操作条：已答进度 + 保存状态 + 交卷 */}
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span>
                已答 <b className="text-primary">{answered}</b> / {total} 题
              </span>
              {saveFailed && (
                <span className="flex items-center gap-1 text-xs text-destructive">
                  <AlertTriangle aria-hidden className="size-4" />
                  有答案保存失败，请检查网络后重试（重新作答该题即可）
                </span>
              )}
              {inkFlushError && (
                <span className="flex items-center gap-1 text-xs text-destructive">
                  <AlertTriangle aria-hidden className="size-4" />
                  有题目的笔迹还没上传成功，交卷被暂时阻止——请检查网络后重新点「交卷」
                </span>
              )}
              {submitError !== null && (
                <span className="flex items-center gap-1 text-xs text-destructive">
                  <AlertTriangle aria-hidden className="size-4" />
                  {submitError}
                </span>
              )}
            </p>
            <Button
              className="min-h-11 shrink-0 px-6"
              disabled={total === 0}
              onClick={() => setConfirmOpen(true)}
            >
              交卷
            </Button>
          </div>
        </div>

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
