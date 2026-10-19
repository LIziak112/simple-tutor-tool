import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiTaskPublic } from "@tutor/contract";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  fetchStudentAiTaskApi,
  followupStudentAiTaskApi,
  listStudentAiTasksApi,
  openStudentAiReplyApi,
} from "@/lib/api";
import { randomUuid } from "@/lib/uuid";
import { AiReadingWorkspace } from "./AiReadingWorkspace";
import { AiReplyMarkdown } from "./AiReplyMarkdown";
import {
  studentAiQueueKey,
  studentAiQueueSummaryKey,
  useStudentAiQueueAction,
} from "./ai-queue-queries";
import { errorMessageOf } from "./error-text";
import { useAiDraftMap } from "./use-ai-draft-map";
import { AI_MODE_LABEL, type AiSendController } from "./use-ai-send-controller";

/**
 * SAI-21 会话面板（B11）：回信可见性、追问与查询策略。
 *
 * 数据源与轮询：任务列表读发送控制器（send.history，查询按账号/attempt/
 * 绑定题隔离）；面板在**同 key** 上挂一个只带 refetchInterval 的观察者——
 * 与控制器共享缓存（一轮只发一次请求），页面可见时每 10s 增量查询、错误
 * 退避 3 倍，隐藏页由 TanStack 默认 refetchIntervalInBackground=false
 * 暂停；恢复可见只核对状态，不重发任何出站动作。刷新只重渲染面板自身
 * （卡片按任务 id 稳定、回信经 memo 的受限渲染），不重解析主区题面。
 *
 * 回信可见性：未读（hasReply 且未打开）给轻提示（role=status 的
 * aria-live，不抢焦点、不自动滚动、不自动展开）；学生查看时记一次
 * opened（SAI-14 幂等口径客户端侧：本地已打开集合与服务端
 * replyDeliveredAt 合判已读，收起再展开不重复记）。禁用期回信正文由
 * 服务端门禁不下发——详情里没有 assistant 消息时只呈现「已收到回信」
 * 事实，客户端不做本地查表推导。
 *
 * 追问：绑定本题对话，只发 question + mutationId（服务端幂等去重；
 * 追问不重采材料——新稿 = 新任务新快照），对用户明确「基于原发送材料」；
 * 追问入口按服务端权威 allowedActions 判定，策略层变化以该字段为准。
 * 外部链接通道（link）无平台回信时如实显示外部未知，不伪造已完成。
 */

/** 页面可见时的任务列表增量查询间隔（隐藏页暂停，恢复可见续跑） */
export const AI_TASKS_POLL_INTERVAL_MS = 10_000;
/** 查询失败后的退避间隔（不放大轮询风暴） */
const AI_TASKS_POLL_ERROR_INTERVAL_MS = 30_000;

/** 追问上下文说明：不悄悄附新笔迹，新稿走新任务 */
const FOLLOWUP_HINT =
  "追问基于原发送材料，不会附带新笔迹；检查新步骤时请使用新稿。";

/** 处理状态事实文案（处理状态与查看状态分开，见 aiTaskPublicSchema） */
function taskFactText(task: AiTaskPublic): string | null {
  switch (task.status) {
    case "created":
      return task.channel === "mcp"
        ? "已加入队列，等待外部 AI 领取"
        : "已发送，等待处理";
    case "dispatching":
      return "正在发送给 AI…";
    case "uncertain":
      return "发送结果待确认";
    case "claimed":
      return "已被领取，正在处理";
    case "paused":
      return "已暂停";
    case "failed":
      return task.errorText === null || task.errorText.trim() === ""
        ? "发送失败，可重试"
        : `发送失败：${task.errorText}`;
    case "cancelled":
      return "已取消，已外发的信息无法撤回";
    case "replied":
      // 回信可见性走 hasReply/已读分支，不在此给处理状态文案
      return null;
  }
}

/** 快照时间本地呈现（YYYY-MM-DD HH:mm；各任务快照各自保留，不互相覆盖；
 * AiLinkShareBox 的生成时刻/有效期同格式共用） */
export function formatSnapshotTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 展开后的对话正文：详情查询 + 学生消息 + 受限渲染的回信 */
function ConversationMessages({
  taskId,
  updatedAt,
  onVisible,
}: {
  taskId: string;
  updatedAt: string;
  onVisible: () => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["student", "ai-task-detail", taskId],
    queryFn: () => fetchStudentAiTaskApi(taskId),
  });
  // 任务行更新（追问重排队/新回信）→ 失效重取，对话与任务状态保持一致
  const previousUpdatedRef = useRef(updatedAt);
  useEffect(() => {
    if (previousUpdatedRef.current === updatedAt) return;
    previousUpdatedRef.current = updatedAt;
    void queryClient.invalidateQueries({
      queryKey: ["student", "ai-task-detail", taskId],
    });
  }, [updatedAt, taskId, queryClient]);
  // 正文成功取得并挂入可见工作区后才记交付；失败不清未读。
  const hasVisibleReply =
    query.isSuccess &&
    !query.isFetching &&
    query.data?.messages.some((message) => message.role === "assistant") ===
      true;
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  const deliveryVersion = hasVisibleReply ? query.dataUpdatedAt : null;
  useEffect(() => {
    if (deliveryVersion !== null) onVisibleRef.current();
  }, [deliveryVersion]);

  if (query.isPending || query.isFetching)
    return (
      <p className="text-xs text-muted-foreground" aria-live="polite">
        正在载入对话…
      </p>
    );
  if (query.isError)
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">对话读取失败</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11 self-start px-2"
          onClick={() => void query.refetch()}
        >
          重试读取
        </Button>
      </div>
    );
  const messages = query.data?.messages ?? [];
  const hasAssistant = messages.some((message) => message.role === "assistant");
  const latestAssistant = messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  const orderedMessages = messages.map((message, index) => ({
    message,
    index,
  }));
  if (latestAssistant >= 0) {
    const [latest] = orderedMessages.splice(latestAssistant, 1);
    if (latest) orderedMessages.unshift(latest);
  }
  return (
    <div className="flex flex-col gap-3">
      {orderedMessages.map(({ message, index }) => {
        if (message.role === "student")
          return (
            <details key={message.id} className="text-sm text-muted-foreground">
              <summary className="min-h-11 cursor-pointer py-3 focus-visible:outline-2 focus-visible:outline-ring">
                你问：
                {index === messages.length - 2 ? "本次提问" : "之前的提问"}
              </summary>
              <p className="whitespace-pre-wrap break-words">
                {message.contentMd}
              </p>
            </details>
          );
        const reply = (
          <AiReplyMarkdown key={message.id} source={message.contentMd} />
        );
        return index === latestAssistant ? (
          <div key={message.id} className="min-w-0">
            {reply}
          </div>
        ) : (
          <details key={message.id} className="min-w-0">
            <summary className="min-h-11 cursor-pointer py-3 text-sm focus-visible:outline-2 focus-visible:outline-ring">
              之前的回复
            </summary>
            {reply}
          </details>
        );
      })}
      {/* 服务端门禁：禁用期详情不带 assistant 正文，只保留已收信事实 */}
      {!hasAssistant && (
        <p className="text-xs text-muted-foreground">
          已收到回信，当前教学模式下暂不能查看
        </p>
      )}
    </div>
  );
}

interface AiTaskCardProps {
  viewedVersion: string;
  task: AiTaskPublic;
  read: boolean;
  expanded: boolean;
  followupDraft: string;
  followupAllowed: boolean;
  followupSending: boolean;
  followupError: string | null;
  onToggle: () => void;
  onFollowupText: (text: string) => void;
  onFollowup: () => void;
  onNewRequest: () => void;
  onVisible: () => void;
  onReturnToWork?: (() => void) | undefined;
  editing: boolean;
  onClarify: (quote: string) => void;
  actionPending: boolean;
  onAction: (action: "retry" | "resume") => void;
}

function AiTaskCard({
  viewedVersion,
  task,
  read,
  expanded,
  followupDraft,
  followupAllowed,
  followupSending,
  followupError,
  onToggle,
  onFollowupText,
  onFollowup,
  onNewRequest,
  onVisible,
  onReturnToWork,
  editing,
  onClarify,
  actionPending,
  onAction,
}: AiTaskCardProps) {
  const followupInputRef = useRef<HTMLTextAreaElement>(null);
  const previousEditingRef = useRef(editing);
  useLayoutEffect(() => {
    if (editing && !previousEditingRef.current) {
      followupInputRef.current?.focus({ preventScroll: true });
      followupInputRef.current?.scrollIntoView?.({
        block: "nearest",
        behavior: "instant",
      });
    }
    previousEditingRef.current = editing;
  }, [editing]);
  const unread = task.hasReply && !read;
  const hasNewVersion =
    expanded &&
    task.hasReply &&
    task.status === "replied" &&
    viewedVersion !== task.updatedAt;
  // 链接通道回信在外部：平台没有回信就如实说外部未知，不伪造完成
  const externalUnknown = task.channel === "link" && !task.hasReply;
  const fact = taskFactText(task);
  return (
    <article
      data-testid={`ai-task-card-${task.id}`}
      className="flex min-w-0 flex-col gap-3 py-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>依据：{formatSnapshotTime(task.snapshotAt)} 的题目与作答</span>
        <details>
          <summary className="flex min-h-11 cursor-pointer items-center text-primary focus-visible:outline-2 focus-visible:outline-ring">
            查看材料
          </summary>
          <p>
            发送时：{AI_MODE_LABEL[task.modeAtSend]}。这份材料不会随新笔迹改变。
          </p>
          {task.materials.length === 0 ? (
            <p>本次没有附加手写图片。</p>
          ) : (
            <ul>
              {task.materials.map((material) => (
                <li key={material.id}>
                  {material.kind === "annotation"
                    ? "圈画"
                    : material.kind === "draft"
                      ? "草稿"
                      : "正式手写"}{" "}
                  · 第 {material.pageIndex + 1} 页 ·{" "}
                  {material.state === "ready"
                    ? "已上传"
                    : (material.missingReason ?? "尚未就绪")}
                </li>
              ))}
            </ul>
          )}
        </details>
      </div>
      {!expanded && <p className="line-clamp-2 text-sm">{task.question}</p>}
      {externalUnknown ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            回复在外部，平台未收到回信
          </p>
          <p className="text-xs text-muted-foreground">查看情况未知</p>
        </div>
      ) : hasNewVersion ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" className="min-h-11" onClick={onToggle}>
            查看新回复
          </Button>
          <p role="status" className="text-xs text-muted-foreground">
            收到新回复
          </p>
        </div>
      ) : unread && !expanded ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="min-h-11 px-3"
            onClick={onToggle}
          >
            {expanded
              ? viewedVersion === task.updatedAt
                ? "收起对话"
                : "查看新回复"
              : "查看回信"}
          </Button>
          <p role="status" className="text-xs font-medium text-primary">
            收到新回复（未读）
          </p>
        </div>
      ) : task.hasReply && !expanded ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={expanded ? "ghost" : "outline"}
            size="sm"
            className="min-h-11 self-start px-2"
            onClick={onToggle}
          >
            {expanded ? "收起对话" : "查看对话"}
          </Button>
          {!expanded && (
            <span className="text-xs text-muted-foreground">已查看回复</span>
          )}
        </div>
      ) : fact !== null ? (
        <p className="text-xs text-muted-foreground">{fact}</p>
      ) : null}
      {(["retry", "resume"] as const)
        .filter((action) => task.allowedActions.includes(action))
        .map((action) => (
          <Button
            key={action}
            type="button"
            variant="outline"
            className="min-h-11 self-start"
            disabled={actionPending}
            onClick={() => onAction(action)}
          >
            {action === "retry" ? "重试这次求助" : "继续这次求助"}
          </Button>
        ))}
      {expanded && unread && !hasNewVersion && (
        <p role="status" className="text-sm text-muted-foreground">
          收到新回复（未读）
        </p>
      )}
      {expanded && !externalUnknown && (
        <AiReadingWorkspace>
          <div
            data-task-reading={task.id}
            className="flex min-w-0 flex-col gap-4"
          >
            <ConversationMessages
              taskId={task.id}
              updatedAt={viewedVersion}
              onVisible={onVisible}
            />
            {task.hasReply && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  {onReturnToWork && (
                    <Button
                      type="button"
                      className="min-h-11"
                      onClick={onReturnToWork}
                    >
                      回题试一试
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={!followupAllowed}
                    onClick={() => {
                      const selection = window.getSelection();
                      const ownerOf = (node: Node | null | undefined) =>
                        (node instanceof Element ? node : node?.parentElement)
                          ?.closest("[data-task-reading]")
                          ?.getAttribute("data-task-reading");
                      const sameTask =
                        ownerOf(selection?.anchorNode) === task.id &&
                        ownerOf(selection?.focusNode) === task.id;
                      onClarify(
                        sameTask
                          ? (selection?.toString().trim().slice(0, 600) ?? "")
                          : "",
                      );
                      followupInputRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    这一步没懂
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11"
                    onClick={onToggle}
                  >
                    收起对话
                  </Button>
                </div>
                {editing && (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-muted-foreground">
                      {FOLLOWUP_HINT}
                    </p>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        继续问这份稿 · 材料{" "}
                        {formatSnapshotTime(task.snapshotAt)}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        className="min-h-11"
                        onClick={onNewRequest}
                      >
                        带新稿另问
                      </Button>
                    </div>
                    <textarea
                      ref={followupInputRef}
                      data-testid="followup-input"
                      aria-label="继续追问本题"
                      rows={2}
                      className="min-h-11 w-full resize-y rounded-lg border border-input bg-background px-2 py-1.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                      placeholder="继续追问本题"
                      value={followupDraft}
                      disabled={followupSending || !followupAllowed}
                      onChange={(event) => onFollowupText(event.target.value)}
                    />
                    <Button
                      type="button"
                      size="sm"
                      className="min-h-11 self-start px-3"
                      disabled={followupSending || !followupAllowed}
                      onClick={onFollowup}
                    >
                      {followupSending ? "追问中…" : "追问"}
                    </Button>
                    {!followupAllowed && (
                      <p
                        role="status"
                        className="text-xs text-muted-foreground"
                      >
                        {fact ?? "当前不可追问，请查看 AI 设置"}
                      </p>
                    )}
                    {followupError !== null && (
                      <p role="alert" className="text-sm text-destructive">
                        {followupError}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </AiReadingWorkspace>
      )}
    </article>
  );
}

/** 会话状态归页面共享控制器所有，切换题下/对照容器不丢草稿。 */
export function useAiConversationController(
  send: AiSendController,
  active = true,
) {
  const queryClient = useQueryClient();
  const taskAction = useStudentAiQueueAction();
  const attemptId = send.attemptId;
  const boundQuestionId = send.boundQuestionId;

  // 任务状态变化（回信到达/被领取/失败）→ 刷新状态摘要，避免面板头一直显示
  // 旧的「处理中 N」。签名相同则不请求；首次渲染由控制器自己的查询负责。
  const refreshStatusRef = useRef(send.refreshStatus);
  refreshStatusRef.current = send.refreshStatus;
  const tasksSignature = (send.history?.tasks ?? [])
    .map((task) => `${task.id}:${task.status}:${task.replyDeliveredAt ?? ""}`)
    .join("|");
  const statusSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (tasksSignature === "" || statusSignatureRef.current === tasksSignature)
      return;
    const firstObservation = statusSignatureRef.current === null;
    statusSignatureRef.current = tasksSignature;
    if (!firstObservation) refreshStatusRef.current();
  }, [tasksSignature]);

  // 同 key 轮询观察者：控制器已按账号/attempt/绑定题建查询，这里只带来
  // refetchInterval（共享缓存，一轮一次请求）；隐藏页暂停、错误退避。
  useQuery({
    queryKey:
      boundQuestionId === null
        ? ["student", "ai-tasks", "none"]
        : (["student", "ai-tasks", attemptId, boundQuestionId] as const),
    queryFn: () =>
      listStudentAiTasksApi({
        attemptId,
        questionId: boundQuestionId ?? "",
      }),
    enabled: active && boundQuestionId !== null,
    refetchInterval: (query) =>
      query.state.error === null
        ? AI_TASKS_POLL_INTERVAL_MS
        : AI_TASKS_POLL_ERROR_INTERVAL_MS,
    refetchOnWindowFocus: false,
  });

  const [expandedByQuestion, setExpandedByQuestion] = useState<
    ReadonlyMap<string, string | null>
  >(() => new Map());
  const [viewedVersions, setViewedVersions] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const expandedId =
    boundQuestionId === null
      ? null
      : (expandedByQuestion.get(boundQuestionId) ?? null);
  const setExpandedId = (id: string | null) => {
    if (boundQuestionId !== null)
      setExpandedByQuestion((previous) =>
        new Map(previous).set(boundQuestionId, id),
      );
  };
  /** 用户是否亲手操作过展开（亲手收起后不再自动展开） */
  const expandedTouchedRef = useRef(new Set<string>());
  // 只在首次取得本题历史时恢复已读回信；后续其他设备的已读变更也不能抢走输入。
  const latestTask = send.history?.tasks[0];
  const latestReadId =
    latestTask?.hasReply === true && latestTask.replyDeliveredAt !== null
      ? latestTask.id
      : null;
  useEffect(() => {
    if (
      boundQuestionId === null ||
      send.history === undefined ||
      expandedByQuestion.has(boundQuestionId) ||
      expandedTouchedRef.current.has(boundQuestionId) ||
      send.historyLoading
    )
      return;
    setExpandedByQuestion((previous) =>
      previous.has(boundQuestionId)
        ? previous
        : new Map(previous).set(boundQuestionId, latestReadId),
    );
    if (latestReadId !== null && latestTask !== undefined)
      setViewedVersions((previous) =>
        new Map(previous).set(latestReadId, latestTask.updatedAt),
      );
  }, [
    latestReadId,
    boundQuestionId,
    latestTask,
    expandedByQuestion,
    send.history,
    send.historyLoading,
  ]);
  /** 本会话已打开过回信的任务（与服务端 replyDeliveredAt 合判已读） */
  const [openedIds, setOpenedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** 同步守卫：连点/收起再展开不重复发 opened（幂等的客户端侧） */
  const openedRef = useRef<Set<string>>(new Set());
  /** 追问草稿按任务隔离（切任务互不覆盖） */
  const [followupDrafts, setFollowupDrafts] = useAiDraftMap<string>(
    "followup",
    attemptId,
  );
  const [editingTasks, setEditingTasks] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [preparingQuestions, setPreparingQuestions] = useState<
    ReadonlySet<string>
  >(() => new Set());
  useEffect(() => {
    if (send.sendState.phase !== "sent" || send.sendState.questionId === null)
      return;
    const questionId = send.sendState.questionId;
    setPreparingQuestions((previous) => {
      if (!previous.has(questionId)) return previous;
      const next = new Set(previous);
      next.delete(questionId);
      return next;
    });
  }, [send.sendState]);
  const [followupSending, setFollowupSending] = useState(false);
  const followupSendingRef = useRef(false);
  /** 在途/待重试的追问动作（同文重试复用同一幂等键，不重复计费出站） */
  const followupPendingRef = useRef<{
    taskId: string;
    question: string;
    mutationId: string;
  } | null>(null);
  const [followupError, setFollowupError] = useState<{
    taskId: string;
    message: string;
  } | null>(null);

  const toggle = (task: AiTaskPublic) => {
    if (boundQuestionId !== null)
      expandedTouchedRef.current.add(boundQuestionId);
    const changedReply =
      viewedVersions.get(task.id) !== task.updatedAt &&
      task.hasReply &&
      task.status === "replied";
    const next = expandedId === task.id && !changedReply ? null : task.id;
    if (next !== null)
      setViewedVersions((previous) =>
        new Map(previous).set(task.id, task.updatedAt),
      );
    setExpandedId(next);
  };
  const markOpened = (task: AiTaskPublic) => {
    if (viewedVersions.get(task.id) !== task.updatedAt) return;
    const deliveryKey = `${task.id}:${task.updatedAt}`;
    if (
      !task.hasReply ||
      task.replyDeliveredAt !== null ||
      openedRef.current.has(deliveryKey)
    )
      return;
    // 学生查看回信：记一次 opened（服务端按当前策略与完成态重校验落
    // reply_delivered 事实；失败撤销本地标记，下次展开重试，不虚报已读）
    openedRef.current.add(deliveryKey);
    void openStudentAiReplyApi(task.id)
      .then(() => {
        setOpenedIds((previous) => {
          const nextSet = new Set(previous);
          nextSet.add(deliveryKey);
          return nextSet;
        });
        void queryClient.invalidateQueries({
          queryKey: studentAiQueueSummaryKey,
        });
        void queryClient.invalidateQueries({ queryKey: studentAiQueueKey });
      })
      .catch(() => {
        openedRef.current.delete(deliveryKey);
        setOpenedIds((previous) => {
          const nextSet = new Set(previous);
          nextSet.delete(deliveryKey);
          return nextSet;
        });
      });
  };

  const submitFollowup = async (task: AiTaskPublic) => {
    const question = (followupDrafts.get(task.id) ?? "").trim();
    if (question === "") {
      setFollowupError({
        taskId: task.id,
        message: "先写下追问内容，再点追问",
      });
      return;
    }
    if (followupSendingRef.current) return; // 在途重复点击：一次动作
    const reuse = followupPendingRef.current;
    const pending =
      reuse !== null && reuse.taskId === task.id && reuse.question === question
        ? reuse
        : { taskId: task.id, question, mutationId: randomUuid() };
    followupPendingRef.current = pending;
    followupSendingRef.current = true;
    setFollowupSending(true);
    setFollowupError(null);
    try {
      await followupStudentAiTaskApi(task.id, {
        question: pending.question,
        mutationId: pending.mutationId,
      });
      setFollowupDrafts((previous) => new Map(previous).set(task.id, ""));
      followupPendingRef.current = null;
      // 追问重排队：刷新列表呈现最新任务状态（不本地改写任务行）
      void queryClient.invalidateQueries({
        queryKey: ["student", "ai-tasks", attemptId],
      });
    } catch (cause) {
      setFollowupError({
        taskId: task.id,
        message: errorMessageOf(cause, "追问失败，请检查网络后重试"),
      });
    } finally {
      followupSendingRef.current = false;
      setFollowupSending(false);
    }
  };

  const startNew = (questionId = boundQuestionId) => {
    if (questionId !== null) {
      send.prepareNew(questionId);
      expandedTouchedRef.current.add(questionId);
      setPreparingQuestions((previous) => new Set(previous).add(questionId));
      setExpandedByQuestion((previous) =>
        new Map(previous).set(questionId, null),
      );
    }
  };
  return {
    expandedId,
    taskAction,
    preparingQuestions,
    editingTasks,
    clarify: (taskId: string, quote: string) => {
      setEditingTasks((previous) => new Set(previous).add(taskId));
      setFollowupDrafts((previous) => {
        if ((previous.get(taskId) ?? "").trim()) return previous;
        return new Map(previous).set(
          taskId,
          `${quote ? `关于这一步：“${quote}”\n` : ""}请换一种方式解释这一步。`,
        );
      });
    },
    openTask: (task: AiTaskPublic) => {
      expandedTouchedRef.current.add(task.questionId);
      setExpandedByQuestion((previous) =>
        new Map(previous).set(task.questionId, task.id),
      );
      setViewedVersions((previous) =>
        new Map(previous).set(task.id, task.updatedAt),
      );
    },
    viewedVersions,
    openedIds,
    followupDrafts,
    followupSending,
    followupError,
    toggle,
    markOpened,
    submitFollowup,
    startNew,
    setFollowupText: (taskId: string, text: string) =>
      setFollowupDrafts((previous) => new Map(previous).set(taskId, text)),
    retryHistory: () =>
      void queryClient.invalidateQueries({
        queryKey: ["student", "ai-tasks", attemptId],
      }),
  };
}

type ConversationController = ReturnType<typeof useAiConversationController>;
interface ConversationProps {
  send: AiSendController;
  controller?: ConversationController;
  composer?: ReactNode;
  quickButtons?: ReactNode;
  onReturnToWork?: (() => void) | undefined;
  onCheckNewSteps?: (() => void) | undefined;
}

export function AiConversationPanel(props: ConversationProps) {
  return props.controller ? (
    <AiConversationView {...props} controller={props.controller} />
  ) : (
    <StandaloneConversation {...props} />
  );
}
function StandaloneConversation(props: ConversationProps) {
  const controller = useAiConversationController(props.send);
  return <AiConversationView {...props} controller={controller} />;
}
function AiConversationView({
  send,
  controller,
  composer,
  quickButtons,
  onReturnToWork,
  onCheckNewSteps,
}: ConversationProps & { controller: ConversationController }) {
  const {
    expandedId,
    viewedVersions,
    openedIds,
    followupDrafts,
    followupSending,
    followupError,
    toggle,
    markOpened,
    submitFollowup,
  } = controller;
  const boundQuestionId = send.boundQuestionId;
  if (boundQuestionId === null)
    return (
      <p className="text-xs text-muted-foreground">
        先在题目上打开 AI 助教，再查看对话
      </p>
    );
  if (send.historyLoading && send.history === undefined)
    return (
      <p className="text-xs text-muted-foreground" aria-live="polite">
        正在载入求助记录…
      </p>
    );
  if (send.historyError && send.history === undefined)
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">
          求助记录读取失败，可以重试或继续输入新的问题。
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11 self-start px-2"
          onClick={() => {
            controller.retryHistory();
          }}
        >
          重试读取
        </Button>
        {quickButtons}
        {composer}
      </div>
    );
  const tasks = send.history?.tasks ?? [];
  const selectedTask = tasks.find((task) => task.id === expandedId);
  const failedHere =
    send.sendState.phase === "failed" &&
    send.sendState.questionId === boundQuestionId;
  const sentHere =
    send.sendState.phase === "sent" &&
    send.sendState.questionId === boundQuestionId;
  const showComposer =
    selectedTask === undefined &&
    (failedHere ||
      !sentHere ||
      controller.preparingQuestions.has(boundQuestionId) ||
      send.linkShare?.questionId === boundQuestionId);
  const renderTask = (task: AiTaskPublic) => (
    <AiTaskCard
      key={task.id}
      task={task}
      viewedVersion={viewedVersions.get(task.id) ?? task.updatedAt}
      read={
        task.replyDeliveredAt !== null ||
        openedIds.has(`${task.id}:${task.updatedAt}`)
      }
      expanded={expandedId === task.id}
      followupDraft={followupDrafts.get(task.id) ?? ""}
      followupAllowed={task.allowedActions.includes("followup")}
      followupSending={followupSending}
      followupError={
        followupError !== null && followupError.taskId === task.id
          ? followupError.message
          : null
      }
      onToggle={() => toggle(task)}
      onFollowupText={(text) => controller.setFollowupText(task.id, text)}
      onFollowup={() => void submitFollowup(task)}
      editing={controller.editingTasks.has(task.id)}
      onClarify={(quote) => controller.clarify(task.id, quote)}
      onReturnToWork={onReturnToWork}
      onNewRequest={onCheckNewSteps ?? (() => controller.startNew())}
      onVisible={() => markOpened(task)}
      actionPending={controller.taskAction.isPending}
      onAction={(action) =>
        controller.taskAction.mutate({ taskId: task.id, action })
      }
    />
  );
  return (
    <div className="flex flex-col gap-3">
      {controller.taskAction.isError && (
        <p role="alert" className="text-sm text-destructive">
          操作未生效：
          {errorMessageOf(controller.taskAction.error, "请检查网络后重试")}
        </p>
      )}
      {tasks.length === 0 && (
        <p className="text-xs text-muted-foreground">
          卡住了也没关系。先拿一点提示，再自己试一步。
        </p>
      )}

      {tasks
        .filter(
          (task) =>
            task.id !== (selectedTask ?? tasks[0])?.id &&
            task.hasReply &&
            task.replyDeliveredAt === null &&
            !openedIds.has(`${task.id}:${task.updatedAt}`),
        )
        .map((task) => (
          <div
            key={task.id}
            role="status"
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <span>本题还有一条新回复</span>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => controller.openTask(task)}
            >
              查看这条回复
            </Button>
          </div>
        ))}
      {tasks[0] && renderTask(selectedTask ?? tasks[0])}
      {tasks.length > 1 && (
        <details>
          <summary className="min-h-11 cursor-pointer py-3 text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
            之前的求助（{tasks.length - 1}）
          </summary>
          {tasks
            .filter((task) => task.id !== (selectedTask ?? tasks[0])?.id)
            .map(renderTask)}
        </details>
      )}
      {onReturnToWork && tasks[0] && !tasks[0].hasReply && (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 self-start"
          onClick={onReturnToWork}
        >
          继续做题，稍后查看回复
        </Button>
      )}
      {showComposer && (
        <>
          {quickButtons}
          {composer}
        </>
      )}
      {!showComposer && selectedTask === undefined && (
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 self-start"
          onClick={() => controller.startNew()}
        >
          准备新的求助
        </Button>
      )}
    </div>
  );
}
