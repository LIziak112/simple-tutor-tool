import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiTaskPublic } from "@tutor/contract";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  fetchStudentAiTaskApi,
  followupStudentAiTaskApi,
  listStudentAiTasksApi,
  openStudentAiReplyApi,
} from "@/lib/api";
import { randomUuid } from "@/lib/uuid";
import { AiReplyMarkdown } from "./AiReplyMarkdown";
import { errorMessageOf } from "./error-text";
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
  "追问基于原发送材料，不会附带此后的新笔迹；想让 AI 参考新稿，请到上方输入区新建一次求助并勾选材料。";

/** 处理状态事实文案（处理状态与查看状态分开，见 aiTaskPublicSchema） */
function taskFactText(task: AiTaskPublic): string | null {
  switch (task.status) {
    case "created":
      return "已发送，等待处理";
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
}: {
  taskId: string;
  updatedAt: string;
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

  if (query.isPending)
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
          className="min-h-9 self-start px-2"
          onClick={() => void query.refetch()}
        >
          重试读取
        </Button>
      </div>
    );
  const messages = query.data?.messages ?? [];
  const hasAssistant = messages.some((message) => message.role === "assistant");
  return (
    <div className="flex flex-col gap-3">
      {messages.map((message) =>
        message.role === "student" ? (
          <div key={message.id} className="flex justify-end">
            <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary/10 px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words">
              <span className="sr-only">你：</span>
              {message.contentMd}
            </p>
          </div>
        ) : (
          <div key={message.id} className="flex min-w-0 gap-2">
            <span
              aria-hidden
              className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-[0.625rem] font-semibold text-primary"
            >
              AI
            </span>
            <div className="min-w-0 flex-1">
              <AiReplyMarkdown source={message.contentMd} />
            </div>
          </div>
        ),
      )}
      {/* 服务端门禁：禁用期详情不带 assistant 正文，只保留已收信事实 */}
      {!hasAssistant && (
        <p className="text-xs text-muted-foreground">
          已收到回信，当前教学模式下暂不能查看
        </p>
      )}
    </div>
  );
}

/** 任务进度三段（失败/取消不显示进度，只给事实文案） */
const TASK_STEPS = ["已发送", "处理中", "已回复"] as const;
const TASK_STEP_INDEX: Partial<Record<AiTaskPublic["status"], number>> = {
  created: 0,
  dispatching: 0,
  uncertain: 0,
  paused: 0,
  claimed: 1,
  replied: 2,
};

function TaskProgress({
  status,
  channel,
}: {
  status: AiTaskPublic["status"];
  channel: AiTaskPublic["channel"];
}) {
  // 外部链接通道没有平台回信事实，不画平台进度（避免读成「已回复」）
  if (channel === "link") return null;
  const active = TASK_STEP_INDEX[status];
  if (active === undefined) return null;
  return (
    <ol className="flex items-center gap-1 text-[0.6875rem]">
      {TASK_STEPS.map((label, index) => (
        <li
          key={label}
          className={
            index === active
              ? "rounded-full bg-primary/10 px-1.5 py-0.5 font-medium text-primary"
              : "px-1.5 py-0.5 text-muted-foreground"
          }
        >
          {label}
        </li>
      ))}
    </ol>
  );
}

interface AiTaskCardProps {
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
}

function AiTaskCard({
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
}: AiTaskCardProps) {
  const unread = task.hasReply && !read;
  // 链接通道回信在外部：平台没有回信就如实说外部未知，不伪造完成
  const externalUnknown = task.channel === "link" && !task.hasReply;
  const fact = taskFactText(task);
  return (
    <article
      data-testid={`ai-task-card-${task.id}`}
      className="flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2.5 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <TaskProgress status={task.status} channel={task.channel} />
        <span className="text-xs text-muted-foreground">
          {formatSnapshotTime(task.snapshotAt)} ·{" "}
          {AI_MODE_LABEL[task.modeAtSend]}
        </span>
      </div>
      {!expanded && <p className="line-clamp-2 text-sm">{task.question}</p>}
      {externalUnknown ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            回复在外部，平台未收到回信
          </p>
          <p className="text-xs text-muted-foreground">查看情况未知</p>
        </div>
      ) : unread ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="min-h-10 px-3"
            onClick={onToggle}
          >
            {expanded ? "收起对话" : "查看回信"}
          </Button>
          <p role="status" className="text-xs font-medium text-primary">
            收到新回复（未读）
          </p>
        </div>
      ) : task.hasReply ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={expanded ? "ghost" : "outline"}
            size="sm"
            className="min-h-9 self-start px-2"
            onClick={onToggle}
          >
            {expanded ? "收起对话" : "查看对话"}
          </Button>
          <span className="text-xs text-muted-foreground">已查看回复</span>
        </div>
      ) : fact !== null ? (
        <p className="text-xs text-muted-foreground">{fact}</p>
      ) : null}
      {expanded && !externalUnknown && (
        <div className="mt-1 flex flex-col gap-2 border-t border-border pt-2">
          <ConversationMessages taskId={task.id} updatedAt={task.updatedAt} />
          {followupAllowed && (
            <div className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">{FOLLOWUP_HINT}</p>
              <textarea
                data-testid="followup-input"
                rows={2}
                className="min-h-11 w-full resize-y rounded-lg border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                placeholder="继续追问本题"
                value={followupDraft}
                disabled={followupSending}
                onChange={(event) => onFollowupText(event.target.value)}
              />
              <Button
                type="button"
                size="sm"
                className="min-h-9 self-start px-3"
                disabled={followupSending}
                onClick={onFollowup}
              >
                {followupSending ? "追问中…" : "追问"}
              </Button>
              {followupError !== null && (
                <p role="alert" className="text-xs text-muted-foreground">
                  {followupError}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function AiConversationPanel({ send }: { send: AiSendController }) {
  const queryClient = useQueryClient();
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
    enabled: boundQuestionId !== null,
    refetchInterval: (query) =>
      query.state.error === null
        ? AI_TASKS_POLL_INTERVAL_MS
        : AI_TASKS_POLL_ERROR_INTERVAL_MS,
    refetchOnWindowFocus: false,
  });

  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 用户是否亲手操作过展开（亲手收起后不再自动展开） */
  const expandedTouchedRef = useRef(false);
  // 换绑定题：重置展开与「亲手操作」标记，新题按自己的最新任务重新判定
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅按绑定题重置
  useEffect(() => {
    expandedTouchedRef.current = false;
    setExpandedId(null);
  }, [boundQuestionId]);
  // 已看过的回信直接展开（再打开面板不必多点一次）；未读保持折叠，
  // 符合需求规格 §7.2「新回信不自动展开长回复」。
  const latestTask = send.history?.tasks[0];
  const latestReadId =
    latestTask?.hasReply === true && latestTask.replyDeliveredAt !== null
      ? latestTask.id
      : null;
  useEffect(() => {
    if (expandedTouchedRef.current || latestReadId === null) return;
    setExpandedId(latestReadId);
  }, [latestReadId]);
  /** 本会话已打开过回信的任务（与服务端 replyDeliveredAt 合判已读） */
  const [openedIds, setOpenedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** 同步守卫：连点/收起再展开不重复发 opened（幂等的客户端侧） */
  const openedRef = useRef<Set<string>>(new Set());
  /** 追问草稿按任务隔离（切任务互不覆盖） */
  const [followupDrafts, setFollowupDrafts] = useState<
    ReadonlyMap<string, string>
  >(new Map());
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
    expandedTouchedRef.current = true;
    const next = expandedId === task.id ? null : task.id;
    setExpandedId(next);
    if (
      next === null ||
      !task.hasReply ||
      task.replyDeliveredAt !== null ||
      openedRef.current.has(task.id)
    )
      return;
    // 学生查看回信：记一次 opened（服务端按当前策略与完成态重校验落
    // reply_delivered 事实；失败撤销本地标记，下次展开重试，不虚报已读）
    openedRef.current.add(task.id);
    void openStudentAiReplyApi(task.id)
      .then(() => {
        setOpenedIds((previous) => {
          const nextSet = new Set(previous);
          nextSet.add(task.id);
          return nextSet;
        });
      })
      .catch(() => {
        openedRef.current.delete(task.id);
        setOpenedIds((previous) => {
          const nextSet = new Set(previous);
          nextSet.delete(task.id);
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
        <p className="text-xs text-muted-foreground">求助记录读取失败</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-9 self-start px-2"
          onClick={() => {
            void queryClient.invalidateQueries({
              queryKey: ["student", "ai-tasks", attemptId],
            });
          }}
        >
          重试读取
        </Button>
      </div>
    );
  const tasks = send.history?.tasks ?? [];
  if (tasks.length === 0)
    return <p className="text-xs text-muted-foreground">本题还没有求助记录</p>;
  return (
    <div className="flex flex-col gap-3">
      {tasks.map((task) => (
        <AiTaskCard
          key={task.id}
          task={task}
          read={task.replyDeliveredAt !== null || openedIds.has(task.id)}
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
          onFollowupText={(text) =>
            setFollowupDrafts((previous) =>
              new Map(previous).set(task.id, text),
            )
          }
          onFollowup={() => void submitFollowup(task)}
        />
      ))}
    </div>
  );
}
