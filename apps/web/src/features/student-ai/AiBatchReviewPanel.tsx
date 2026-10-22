import { useQueryClient } from "@tanstack/react-query";
import {
  AI_BATCH_MAX_QUESTIONS,
  type AiBatchCreateItemResult,
  type AiChannel,
} from "@tutor/contract";
import { Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  createStudentAiBatchReviewApi,
  createStudentAiShareTicketApi,
} from "@/lib/api";
import { randomUuid } from "@/lib/uuid";
import { CHANNEL_LABEL } from "./ai-channel-label";
import { useStudentAiConnections } from "./ai-connection-queries";
import { buildAiLinkPrompt } from "./ai-link-prompt";
import { studentAiQueueSummaryKey } from "./ai-queue-queries";
import { errorMessageOf } from "./error-text";
import { writeToClipboard } from "./use-ai-send-controller";

/**
 * SAI-31 批量错题复盘面板（B16；需求 §8 末段）：结果页「错题加入 AI 复盘
 * 队列」的一次确认入口。复用单题任务创建（服务端逐题装配快照/策略/配额），
 * 本面板只做三件事：
 * 1. 分组与默认勾选：仅已判错默认选；待批独立分组需学生主动勾选（不称
 *    错题）；判对题结构上不可选（无勾选框）。勾选只是 UI 便利——服务端
 *    逐项裁决才是防线（判对/未公布/无权题逐项拒绝，不因批量放宽）。
 * 2. 费用与交付语义先行：展示已选数量/上限、通道（SAI-19 单源
 *    CHANNEL_LABEL）与「每题一份上下文」说明；页内通道明示 N 次调用，
 *    确认后才创建；链接通道明示平台不会自动收到回复（不假装自动写回）。
 * 3. 逐项结果与只重试失败：成功/已存在/复用进行中/失败逐题可定位，失败
 *    项带服务端原因；重试只发失败项且换新幂等键（成功项不重复创建）。
 *
 * 「换页重进重新核对不凭旧筛选」由挂载方式保证：父组件以 {open && 面板}
 * 条件渲染（见 AiBatchReviewEntry），重开即按最新结果数据重建勾选。
 */

/** 面板可选题引用：判分由服务端结果投影携带，不在客户端判分 */
export interface AiBatchReviewQuestion {
  readonly questionId: string;
  /** 展示题号（「第 N 题」） */
  readonly label: string;
  /** 最终判定（null = 待批）；未公布时服务端恒置 null */
  readonly finalCorrect: boolean | null;
}

export interface AiBatchReviewGroups {
  readonly wrong: readonly AiBatchReviewQuestion[];
  readonly pending: readonly AiBatchReviewQuestion[];
  readonly correct: readonly AiBatchReviewQuestion[];
}

/** 按最终判定三分组（未公布时服务端已把 finalCorrect 置 null → 全进待批组） */
export function batchReviewGroupsOf(
  questions: readonly AiBatchReviewQuestion[],
): AiBatchReviewGroups {
  const wrong: AiBatchReviewQuestion[] = [];
  const pending: AiBatchReviewQuestion[] = [];
  const correct: AiBatchReviewQuestion[] = [];
  for (const question of questions) {
    if (question.finalCorrect === false) wrong.push(question);
    else if (question.finalCorrect === true) correct.push(question);
    else pending.push(question);
  }
  return { wrong, pending, correct };
}

const OUTCOME_LABEL = {
  created: "已加入",
  already_exists: "已存在",
  paused: "复用进行中",
  failed: "失败",
} as const;

const DEFAULT_BATCH_QUESTION = "请帮我复盘这些错题，指出错因并给出改进建议";

/** link 通道逐题票据的就地面板状态（URL 恒展示：自动复制失败时的手动兜底） */
interface LinkState {
  readonly url: string;
  readonly copied: boolean;
  readonly error: string | null;
}

/** 逐项结果合并：重试结果按题覆盖，其余保留（成功项不重发也不丢状态） */
function mergeItemResults(
  previous: readonly AiBatchCreateItemResult[] | null,
  incoming: readonly AiBatchCreateItemResult[],
): AiBatchCreateItemResult[] {
  if (previous === null) return [...incoming];
  const byQuestion = new Map(previous.map((row) => [row.questionId, row]));
  for (const row of incoming) byQuestion.set(row.questionId, row);
  return [...byQuestion.values()];
}

export function AiBatchReviewPanel(props: {
  readonly attemptId: string;
  readonly questions: readonly AiBatchReviewQuestion[];
  readonly released: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { attemptId, questions, released, open, onOpenChange } = props;
  const queryClient = useQueryClient();
  const groups = useMemo(() => batchReviewGroupsOf(questions), [questions]);
  const labelById = useMemo(
    () => new Map(questions.map((item) => [item.questionId, item.label])),
    [questions],
  );
  // 默认勾选 = 已判错全组（挂载时定格；重开由父级条件渲染重建）
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(groups.wrong.map((item) => item.questionId)),
  );
  const [channelOverride, setChannelOverride] = useState<AiChannel | null>(
    null,
  );
  const [questionText, setQuestionText] = useState(DEFAULT_BATCH_QUESTION);
  const [submitting, setSubmitting] = useState(false);
  const [itemResults, setItemResults] = useState<
    readonly AiBatchCreateItemResult[] | null
  >(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** link 通道逐题票据状态（题级隔离；重试/重开不携带他题链接） */
  const [links, setLinks] = useState<ReadonlyMap<string, LinkState>>(new Map());

  const connectionsQuery = useStudentAiConnections();
  const connections = connectionsQuery.data?.connections ?? [];
  const channels = useMemo(
    () => [...new Set(connections.map((connection) => connection.channel))],
    [connections],
  );
  const defaultChannel =
    connections.find((connection) => connection.isDefault)?.channel ??
    channels[0] ??
    null;
  const effectiveChannel = channelOverride ?? defaultChannel;

  const selectedQuestions = questions.filter((item) =>
    selectedIds.has(item.questionId),
  );
  const selectedCount = selectedQuestions.length;
  const overLimit = selectedCount > AI_BATCH_MAX_QUESTIONS;
  const failedItems = (itemResults ?? []).filter(
    (row) => row.outcome === "failed",
  );
  const canSubmit =
    released &&
    selectedCount > 0 &&
    !overLimit &&
    effectiveChannel !== null &&
    !submitting;

  const toggle = (questionId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });
  };

  /** 一次批量创建（items = 本次要发的题；重试只传失败项） */
  const submitBatch = async (
    items: readonly AiBatchReviewQuestion[],
  ): Promise<void> => {
    if (effectiveChannel === null) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const data = await createStudentAiBatchReviewApi({
        items: items.map((item) => ({
          attemptId,
          questionId: item.questionId,
        })),
        channel: effectiveChannel,
        question:
          questionText.trim() === ""
            ? DEFAULT_BATCH_QUESTION
            : questionText.trim(),
        mutationId: randomUuid(),
      });
      setItemResults((previous) => mergeItemResults(previous, data.items));
      // 任务已落库：队列角标与本题历史即时失效（与单题发送同口径）
      void queryClient.invalidateQueries({
        queryKey: studentAiQueueSummaryKey,
      });
      void queryClient.invalidateQueries({
        queryKey: ["student", "ai-tasks", attemptId],
      });
    } catch (cause) {
      setSubmitError(errorMessageOf(cause, "批量创建失败，请稍后重试"));
    } finally {
      setSubmitting(false);
    }
  };

  /** 仅重试失败项：载荷只含失败题 + 新幂等键；成功项不重发 */
  const retryFailed = () => {
    const failedIds = new Set(failedItems.map((row) => row.questionId));
    const retryQuestions = questions.filter((item) =>
      failedIds.has(item.questionId),
    );
    void submitBatch(retryQuestions);
  };

  /** link 通道逐题生成票据并复制（复制失败不掩盖生成成功：URL 就地展示） */
  const copyLink = async (taskId: string, questionId: string) => {
    try {
      const ticket = await createStudentAiShareTicketApi(taskId);
      const copied = await writeToClipboard(
        buildAiLinkPrompt(ticket.ticketUrl),
      );
      setLinks((previous) =>
        new Map(previous).set(questionId, {
          url: ticket.ticketUrl,
          copied,
          error: null,
        }),
      );
    } catch (cause) {
      setLinks((previous) =>
        new Map(previous).set(questionId, {
          url: "",
          copied: false,
          error: errorMessageOf(cause, "链接生成失败，请重试"),
        }),
      );
    }
  };

  const summary = useMemo(() => {
    const rows = itemResults ?? [];
    return {
      created: rows.filter((row) => row.outcome === "created").length,
      alreadyExists: rows.filter((row) => row.outcome === "already_exists")
        .length,
      paused: rows.filter((row) => row.outcome === "paused").length,
      failed: rows.filter((row) => row.outcome === "failed").length,
    };
  }, [itemResults]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>错题加入 AI 复盘队列</DialogTitle>
        </DialogHeader>
        {!released && (
          <p role="alert" className="text-sm text-muted-foreground">
            这份作业的答案未公布，公布后才能批量加入 AI 复盘。
          </p>
        )}
        {connectionsQuery.isSuccess && connections.length === 0 && (
          <p role="alert" className="text-sm text-muted-foreground">
            还没有可用的 AI 连接，请先在设置中完成连接与首次知情确认。
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          已选 {selectedCount} / {AI_BATCH_MAX_QUESTIONS} 题
        </p>
        {overLimit && (
          <p role="alert" className="text-sm text-destructive">
            单次批量最多 {AI_BATCH_MAX_QUESTIONS} 道题，请取消部分题目后再加入
          </p>
        )}

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">
            已判错（{groups.wrong.length} 题）——默认全部勾选
          </legend>
          {groups.wrong.map((item) => (
            <label key={item.questionId} className="flex items-center gap-2">
              <input
                type="checkbox"
                aria-label={item.label}
                checked={selectedIds.has(item.questionId)}
                onChange={() => toggle(item.questionId)}
                className="size-4 accent-primary"
              />
              <span className="text-sm">{item.label}</span>
            </label>
          ))}
        </fieldset>

        {groups.pending.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">
              待批改（{groups.pending.length} 题，不算错题——需人工批改确认，
              自行勾选后可一并加入）
            </legend>
            {groups.pending.map((item) => (
              <label key={item.questionId} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={item.label}
                  checked={selectedIds.has(item.questionId)}
                  onChange={() => toggle(item.questionId)}
                  className="size-4 accent-primary"
                />
                <span className="text-sm">{item.label}</span>
              </label>
            ))}
          </fieldset>
        )}

        {groups.correct.length > 0 && (
          <fieldset>
            <legend className="text-sm font-medium">
              已判对（{groups.correct.length} 题，无需复盘，不可加入）
            </legend>
            <p className="text-sm text-muted-foreground">
              {groups.correct.map((item) => item.label).join("、")}
            </p>
          </fieldset>
        )}

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">发送通道</legend>
          {channels.map((channel) => (
            <label key={channel} className="flex items-center gap-2">
              <input
                type="radio"
                name="batch-review-channel"
                aria-label={CHANNEL_LABEL[channel]}
                checked={effectiveChannel === channel}
                onChange={() => setChannelOverride(channel)}
                className="size-4 accent-primary"
              />
              <span className="text-sm">{CHANNEL_LABEL[channel]}</span>
            </label>
          ))}
        </fieldset>

        <div className="flex flex-col gap-1 text-sm text-muted-foreground">
          <p>
            每题一份上下文：题面、你的作答与按当前模式可用的答案解析，不携带其他题内容。
          </p>
          {effectiveChannel === "inapp" && selectedCount > 0 && (
            <p>
              不自动触发全部付费请求：确认后页内 AI 将逐题发送求助，共{" "}
              {selectedCount} 次 AI 调用。
            </p>
          )}
          {effectiveChannel === "mcp" && (
            <p>任务创建后等待你的外部 AI 客户端领取，逐题独立处理。</p>
          )}
          {effectiveChannel === "link" && (
            <p>
              每题生成一条独立链接，复制时附带重新读取说明。可发送多条，但需要
              AI 逐条打开并核对题号；平台不会自动收到回复。
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="batch-review-question"
            className="text-sm font-medium"
          >
            复盘诉求（每题共用这一句）
          </label>
          <Input
            id="batch-review-question"
            value={questionText}
            onChange={(event) => setQuestionText(event.target.value)}
            maxLength={2000}
          />
        </div>

        <Button
          disabled={!canSubmit}
          onClick={() => void submitBatch(selectedQuestions)}
        >
          {submitting ? "正在创建…" : `加入 AI 复盘队列（${selectedCount} 题）`}
        </Button>
        {submitError !== null && (
          <p role="alert" className="text-sm text-destructive">
            {submitError}
          </p>
        )}

        {itemResults !== null && (
          <section className="flex flex-col gap-2" aria-label="批量结果">
            <p className="text-sm">
              成功 {summary.created} · 已存在 {summary.alreadyExists} ·
              复用进行中 {summary.paused} · 失败 {summary.failed}
            </p>
            {effectiveChannel === "link" && (
              <p className="text-sm text-muted-foreground">
                回复在外部 AI，平台未取得；逐题复制链接发给外部 AI 即可。
              </p>
            )}
            <ul className="flex flex-col gap-1">
              {itemResults.map((row) => {
                const taskId = row.taskId;
                const link = links.get(row.questionId);
                return (
                  <li
                    key={row.questionId}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <span>
                      {labelById.get(row.questionId) ?? row.questionId} —{" "}
                    </span>
                    <span>{OUTCOME_LABEL[row.outcome]}</span>
                    {row.outcome === "failed" && row.error !== null && (
                      <span className="text-destructive">：{row.error}</span>
                    )}
                    {effectiveChannel === "link" &&
                      row.outcome !== "failed" &&
                      taskId !== null && (
                        <>
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() =>
                              void copyLink(taskId, row.questionId)
                            }
                          >
                            复制链接
                          </Button>
                          {link !== undefined && link.error !== null && (
                            <span className="text-destructive">
                              {link.error}
                            </span>
                          )}
                          {link !== undefined && link.url !== "" && (
                            <span className="text-muted-foreground break-all">
                              {link.url}
                              {link.copied
                                ? "（已复制）"
                                : "（自动复制失败，请手动复制）"}
                            </span>
                          )}
                        </>
                      )}
                  </li>
                );
              })}
            </ul>
            {failedItems.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={submitting}
                onClick={retryFailed}
              >
                仅重试失败项（{failedItems.length} 题）
              </Button>
            )}
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * 结果页入口（自持开合）：关闭即卸载面板内容，重开按最新结果数据重建
 * 勾选与通道（不凭旧筛选）；打开只展示与选择，不创建任务。
 */
export function AiBatchReviewEntry(props: {
  readonly attemptId: string;
  readonly questions: readonly AiBatchReviewQuestion[];
  readonly released: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="relative flex h-11 min-w-11 shrink-0 items-center gap-1.5 px-2"
        aria-label="批量复盘"
        title="批量复盘"
        onClick={() => setOpen(true)}
      >
        <Sparkles aria-hidden className="size-5" />
        <span className="hidden text-sm sm:inline">批量复盘</span>
      </Button>
      {open && (
        <AiBatchReviewPanel
          attemptId={props.attemptId}
          questions={props.questions}
          released={props.released}
          open
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}
