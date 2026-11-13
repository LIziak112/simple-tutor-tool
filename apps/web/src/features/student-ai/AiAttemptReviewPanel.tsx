import { useQueryClient } from "@tanstack/react-query";
import {
  AI_QUESTION_MAX_CHARS,
  type AiAttemptReviewPreviewData,
} from "@tutor/contract";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  ApiError,
  createStudentAiAttemptReviewApi,
  fetchStudentAiAttemptReviewPreviewApi,
  postStudentAiAttemptReviewActionApi,
} from "@/lib/api";
import { formatCnTime } from "@/lib/time";
import { randomUuid } from "@/lib/uuid";
import { studentAiQueueSummaryKey } from "./ai-queue-queries";
import {
  ATTEMPT_REVIEW_STATUS_LABEL,
  attemptReviewListKey,
  attemptReviewPreviewKey,
  attemptReviewQueueKey,
  useAttemptReviewTasks,
} from "./attempt-review-entry";
import { errorMessageOf } from "./error-text";

/**
 * 整卷复盘发起 / 进度面板（任务 1ef854c7 起；与「批量复盘」并行的另一个入口）。
 * 打开面板只读：范围预览（四类计数、发送字段说明）与本次作答已有的整卷任务
 * 进度——看进度不取报告正文、不记已读。学生填写复盘诉求并显式确认后才创建
 * **一条**整卷任务（不会按题拆成多条逐题任务）。创建遇范围变化（409）自动
 * 重新预览，不拿着旧版本反复撞墙。报告在独立的阅读器里看（onOpenReport）。
 */

const DEFAULT_PURPOSE = "请帮我复盘这次练习的整体情况，指出问题并给出训练建议";

const TASK_ACTION_LABEL = {
  cancel: "取消任务",
  retry: "重试",
  archive: "归档",
} as const;

export function AiAttemptReviewPanel(props: {
  readonly attemptId: string;
  readonly released: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 打开某份报告（由结果页的承载组件切到报告阅读器） */
  readonly onOpenReport: (taskId: string) => void;
}) {
  const { attemptId, released, open, onOpenChange, onOpenReport } = props;
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<AiAttemptReviewPreviewData | null>(
    null,
  );
  const tasksQuery = useAttemptReviewTasks(attemptId, open);
  const tasks = tasksQuery.data?.tasks ?? [];
  const [loading, setLoading] = useState(false);
  const [purpose, setPurpose] = useState(DEFAULT_PURPOSE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTick 是手动重新取数的触发器，不是遗漏
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPreview(null);
    fetchStudentAiAttemptReviewPreviewApi(attemptId)
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(errorMessageOf(cause, "预览失败，请稍后重试"));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, attemptId, refreshTick]);

  /** 面板里改了任务：顶栏入口、提示条、求助记录与角标一起按最新状态刷新 */
  const refreshEntry = () => {
    setRefreshTick((tick) => tick + 1);
    for (const queryKey of [
      attemptReviewListKey(attemptId),
      attemptReviewPreviewKey(attemptId),
      attemptReviewQueueKey,
      studentAiQueueSummaryKey,
    ]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };

  const confirmCreate = async () => {
    if (preview === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const data = await createStudentAiAttemptReviewApi({
        attemptId,
        mutationId: randomUuid(),
        expectedPreviewVersion: preview.opaquePreviewVersion,
        purpose: purpose.trim() === "" ? DEFAULT_PURPOSE : purpose.trim(),
        channel: "mcp",
      });
      setStatusLine(
        data.created
          ? "已创建 1 条整卷复盘任务，等待你的外部 AI 客户端通过 MCP 领取。报告出来后，顶栏会出现「查看整卷复盘报告」。"
          : "已有进行中的整卷复盘任务，本次未重复创建。",
      );
      setPreview(null);
      refreshEntry();
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.code === "AI_ATTEMPT_REVIEW_RANGE_CHANGED"
      ) {
        // 范围/判分已变化：丢掉旧预览立即重新核对，不让学生拿旧版本反复 409
        setStatusLine("本次练习的范围或判定已变化，已重新核对，请再次确认。");
        setPreview(null);
        setRefreshTick((tick) => tick + 1);
      } else {
        setError(errorMessageOf(cause, "创建失败，请稍后重试"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const runAction = async (
    taskId: string,
    action: "cancel" | "archive" | "retry",
  ) => {
    setError(null);
    try {
      await postStudentAiAttemptReviewActionApi(taskId, action);
      refreshEntry();
    } catch (cause) {
      setError(errorMessageOf(cause, "操作失败，请稍后重试"));
    }
  };

  const counts = preview?.counts;
  const hasActiveTask = tasks.some(
    (task) => task.status === "created" || task.status === "claimed",
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>整卷复盘</DialogTitle>
        </DialogHeader>
        {!released && (
          <p role="alert" className="text-sm text-muted-foreground">
            这份练习还未交卷或答案未公布，满足条件后才能发起整卷复盘。
          </p>
        )}
        {loading && (
          <p className="text-sm text-muted-foreground">正在核对本次练习范围…</p>
        )}
        {tasksQuery.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessageOf(tasksQuery.error, "任务读取失败，请稍后重试")}
          </p>
        )}
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {statusLine !== null && (
          <p role="status" className="text-sm text-muted-foreground">
            {statusLine}
          </p>
        )}

        {tasks.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label="整卷复盘任务">
            {tasks.map((task) => (
              <li
                key={task.id}
                className="flex flex-col gap-2 rounded-xl border border-border p-3"
              >
                <p className="text-sm">
                  <span className="font-medium">
                    {ATTEMPT_REVIEW_STATUS_LABEL[task.status]}
                  </span>
                  {task.archivedAt !== null && "（已归档）"} · 覆盖{" "}
                  {task.questionCount} 题 · {formatCnTime(task.createdAt)} 发起
                </p>
                {task.errorText !== null && (
                  <p className="text-sm text-muted-foreground">
                    {task.errorText}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {task.status === "replied" && (
                    <Button
                      className="min-h-11"
                      onClick={() => onOpenReport(task.id)}
                    >
                      查看整卷复盘报告
                    </Button>
                  )}
                  {(["retry", "cancel", "archive"] as const)
                    .filter((action) => task.allowedActions.includes(action))
                    .map((action) => (
                      <Button
                        key={action}
                        variant="outline"
                        className="min-h-11"
                        onClick={() => void runAction(task.id, action)}
                      >
                        {TASK_ACTION_LABEL[action]}
                      </Button>
                    ))}
                </div>
              </li>
            ))}
          </ul>
        )}

        {preview !== null &&
          counts !== undefined &&
          tasksQuery.isSuccess &&
          !hasActiveTask && (
            <div className="flex flex-col gap-3">
              <p className="text-sm">
                本次练习共 {counts.total} 题：判对 {counts.correctCount} · 判错{" "}
                {counts.incorrectCount} · 未作答 {counts.unansweredCount} · 待批{" "}
                {counts.pendingCount}
                {counts.unknownAnswerCount > 0
                  ? `（含 ${counts.unknownAnswerCount} 题是否作答无法确认）`
                  : ""}
                。
              </p>
              {counts.accuracyAmongGraded !== null && (
                <p className="text-sm text-muted-foreground">
                  已判分正确率 {Math.round(counts.accuracyAmongGraded * 100)}%
                  （分母为已判分题数，待批不算错）。
                </p>
              )}
              <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                {preview.fieldNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
                {preview.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="attempt-review-purpose"
                  className="text-sm font-medium"
                >
                  复盘诉求
                </label>
                <Input
                  id="attempt-review-purpose"
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value)}
                  maxLength={AI_QUESTION_MAX_CHARS}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                确认后只创建 1 条整卷任务，覆盖全部 {counts.total}{" "}
                题，不会按题拆成多条。想让 AI
                逐题讲解错题，请用顶栏的「批量复盘」。
              </p>
              <Button
                className="min-h-11"
                disabled={submitting}
                onClick={() => void confirmCreate()}
              >
                {submitting
                  ? "正在创建…"
                  : `确认发起整卷复盘（${counts.total} 题）`}
              </Button>
            </div>
          )}
      </DialogContent>
    </Dialog>
  );
}
