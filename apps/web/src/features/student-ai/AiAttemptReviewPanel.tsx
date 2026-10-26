import { useQueryClient } from "@tanstack/react-query";
import {
  AI_QUESTION_MAX_CHARS,
  type AiAttemptReviewDetailData,
  type AiAttemptReviewPreviewData,
  type AiAttemptReviewTaskPublic,
} from "@tutor/contract";
import { ListChecks } from "lucide-react";
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
  fetchStudentAiAttemptReviewDetailApi,
  fetchStudentAiAttemptReviewPreviewApi,
  listStudentAiAttemptReviewsApi,
  postStudentAiAttemptReviewActionApi,
} from "@/lib/api";
import { randomUuid } from "@/lib/uuid";
import { studentAiQueueSummaryKey } from "./ai-queue-queries";
import { errorMessageOf } from "./error-text";

/**
 * 本次练习整体复盘面板（任务 1ef854c7）：与「错题加入 AI 复盘队列」并行的
 * 第二个入口（交接方案 §3.1 三个明确动作 + §8 结果展示）。打开面板只做
 * 只读预览（范围、四类计数、发送字段说明）与既有任务/报告查看；学生填写
 * 复盘诉求并显式确认后才创建**一个** MCP 整体任务。创建遇范围变化（409）
 * 自动重新预览，不拿着旧版本反复撞墙；报告到达后在本面板查看并记打开。
 */

const DEFAULT_PURPOSE = "请帮我复盘这次练习的整体情况，指出问题并给出训练建议";

const STATUS_LABEL = {
  created: "等待外部 AI 领取",
  claimed: "外部 AI 处理中",
  replied: "已出整体报告",
  failed: "失败",
  paused: "已暂停（范围或授权变化，可重试）",
  cancelled: "已取消",
} as const;

function findingBasisLabel(basis: "platform_fact" | "ai_hypothesis"): string {
  return basis === "platform_fact" ? "事实" : "假设";
}

function ReportCard(props: { readonly detail: AiAttemptReviewDetailData }) {
  const { result } = props.detail;
  if (result === null) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="整体复盘报告">
      <p className="text-sm">{result.overview}</p>
      {(
        [
          ["知识点发现", result.knowledgeFindings],
          ["错误模式", result.errorPatterns],
          ["表现说明", result.performanceNotes],
        ] as const
      ).map(([title, findings]) =>
        findings.length > 0 ? (
          <fieldset key={title} className="flex flex-col gap-1">
            <legend className="text-sm font-medium">{title}</legend>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {findings.map((finding) => (
                <li key={`${finding.statement}`}>
                  {finding.statement}（
                  {finding.evidenceQuestionNos.length > 0
                    ? `证据：第 ${finding.evidenceQuestionNos.join("、")} 题 · `
                    : ""}
                  {findingBasisLabel(finding.basis)} · 置信度
                  {finding.confidence}）
                </li>
              ))}
            </ul>
          </fieldset>
        ) : null,
      )}
      {result.trainingPlan.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">训练建议</legend>
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {result.trainingPlan.map((item) => (
              <li key={`${item.action}`}>
                {item.knowledgePoint !== null && `【${item.knowledgePoint}】`}
                {item.action}
                （优先级 {item.priority}
                {item.caveat !== null && `；${item.caveat}`}）
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {result.limitations.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">局限说明</legend>
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {result.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </fieldset>
      )}
    </section>
  );
}

function AiAttemptReviewPanel(props: {
  readonly attemptId: string;
  readonly released: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { attemptId, released, open, onOpenChange } = props;
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<AiAttemptReviewPreviewData | null>(
    null,
  );
  const [tasks, setTasks] = useState<readonly AiAttemptReviewTaskPublic[]>([]);
  const [detail, setDetail] = useState<AiAttemptReviewDetailData | null>(null);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTick 是手动重新取数的触发器，不是遗漏
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listStudentAiAttemptReviewsApi(attemptId)
      .then(async (data) => {
        if (cancelled) return;
        setTasks(data.tasks);
        const replied = data.tasks.find((task) => task.status === "replied");
        if (replied === undefined) {
          setDetail(null);
          return;
        }
        const detailData = await fetchStudentAiAttemptReviewDetailApi(
          replied.id,
        );
        if (cancelled) return;
        setDetail(detailData);
        if (replied.openedAt === null) {
          // 打开即记已读（服务端 openedAt；顶栏未读随队列摘要刷新）
          await postStudentAiAttemptReviewActionApi(replied.id, "open");
          void queryClient.invalidateQueries({
            queryKey: studentAiQueueSummaryKey,
          });
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(errorMessageOf(cause, "任务读取失败，请稍后重试"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, attemptId, refreshTick, queryClient]);

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
          ? "整体复盘任务已创建，等待你的外部 AI 客户端通过 MCP 领取处理。"
          : "已有进行中的整体复盘任务，本次未重复创建。",
      );
      setPreview(null);
      setRefreshTick((tick) => tick + 1);
      void queryClient.invalidateQueries({
        queryKey: studentAiQueueSummaryKey,
      });
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
      setRefreshTick((tick) => tick + 1);
      void queryClient.invalidateQueries({
        queryKey: studentAiQueueSummaryKey,
      });
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
          <DialogTitle>本次练习整体复盘（MCP）</DialogTitle>
        </DialogHeader>
        {!released && (
          <p role="alert" className="text-sm text-muted-foreground">
            这份练习还未交卷或答案未公布，满足条件后才能发起整体复盘。
          </p>
        )}
        {loading && (
          <p className="text-sm text-muted-foreground">正在核对本次练习范围…</p>
        )}
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {statusLine !== null && (
          <p className="text-sm text-muted-foreground">{statusLine}</p>
        )}

        {tasks.length > 0 && (
          <section className="flex flex-col gap-2" aria-label="整体复盘任务">
            {tasks.map((task) => (
              <div key={task.id} className="flex flex-col gap-1">
                <p className="text-sm">
                  {STATUS_LABEL[task.status]} · 覆盖 {task.questionCount} 题 ·{" "}
                  {task.allowedActions.length === 0 ? "无可用操作" : null}
                </p>
                {task.allowedActions.some((action) => action !== "open") && (
                  <div className="flex flex-wrap gap-2">
                    {task.allowedActions
                      .filter((action) => action !== "open")
                      .map((action) => (
                        <Button
                          key={action}
                          variant="outline"
                          size="xs"
                          onClick={() => void runAction(task.id, action)}
                        >
                          {action === "cancel"
                            ? "取消任务"
                            : action === "retry"
                              ? "重试"
                              : action === "archive"
                                ? "归档"
                                : "打开报告"}
                        </Button>
                      ))}
                  </div>
                )}
              </div>
            ))}
          </section>
        )}

        {detail !== null && <ReportCard detail={detail} />}

        {preview !== null && counts !== undefined && !hasActiveTask && (
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
            <Button disabled={submitting} onClick={() => void confirmCreate()}>
              {submitting
                ? "正在创建…"
                : `确认创建整体复盘任务（${counts.total} 题）`}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * 结果页入口（自持开合）：关闭即卸载面板内容，重开按最新结果数据重新
 * 预览核对（不凭旧预览确认）。
 */
export function AiAttemptReviewEntry(props: {
  readonly attemptId: string;
  readonly released: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="relative flex h-11 min-w-11 shrink-0 items-center gap-1.5 px-2"
        aria-label="整体复盘"
        title="整体复盘"
        onClick={() => setOpen(true)}
      >
        <ListChecks aria-hidden className="size-5" />
        <span className="hidden text-sm sm:inline">整体复盘</span>
      </Button>
      {open && (
        <AiAttemptReviewPanel
          attemptId={props.attemptId}
          released={props.released}
          open
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}
