import type {
  AttemptDetailData,
  AttemptDraftData,
  AttemptResultData,
} from "@tutor/contract";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { AttemptQuestionCard } from "@/features/attempt/AttemptQuestionCard";
import { AttemptResultView } from "@/features/attempt/AttemptResultView";
import {
  useAttemptDetail,
  useStartAttempt,
  useSubmitAttempt,
} from "@/features/attempt/attempt-queries";
import { SubmitConfirmDialog } from "@/features/attempt/SubmitConfirmDialog";
import { useAttemptAnswers } from "@/features/attempt/use-attempt-answers";
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
 *    已交卷（submitted/graded）直接走结果视图；
 * 2. 答题视图：题卡列表（题号/题型徽章/难度/考点）、各题型作答控件、
 *    底部吸底操作条（已答 n/m + 交卷）；作答即保存草稿（文本防抖 600ms）；
 * 3. 交卷确认弹层显示未答数量 → POST submit（服务端判分）→ 切结果视图；
 * 4. 三态齐全（加载骨架/错误重试/空试卷提示），适配 iPad 横竖屏。
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
      <AttemptResultView
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

/** 答题视图（draft）：题卡 + 吸底操作条 + 交卷确认 */
function AnswerView({
  data,
  attemptId,
  onBackHome,
}: {
  data: AttemptDraftData;
  attemptId: string;
  onBackHome: () => void;
}) {
  const { answers, setAnswer, answeredCount, saveFailed } = useAttemptAnswers(
    attemptId,
    data.drafts,
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const submit = useSubmitAttempt(attemptId);

  const questionIds = data.questions.map((question) => question.id);
  const total = data.questions.length;
  const answered = answers === null ? 0 : answeredCount(questionIds);
  const unanswered = total - answered;

  const confirmSubmit = () => {
    submit.mutate(undefined, {
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
    <div className="flex flex-col gap-5 pb-24">
      {/* 作业头：标题 + 截止 */}
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-lg font-bold">{data.title}</h1>
        <p className="text-xs text-muted-foreground">
          {data.dueAt === null
            ? "不限截止"
            : `${formatDueTime(data.dueAt)} 截止`}
        </p>
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
        submitting={submit.isPending}
        onConfirm={confirmSubmit}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
