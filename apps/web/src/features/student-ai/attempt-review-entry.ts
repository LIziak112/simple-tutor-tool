import { useQuery } from "@tanstack/react-query";
import type {
  AiAttemptReviewCounts,
  AiAttemptReviewTaskPublic,
} from "@tutor/contract";
import {
  fetchStudentAiAttemptReviewPreviewApi,
  listStudentAiAttemptReviewsApi,
} from "@/lib/api";

/**
 * 整卷复盘入口的状态模型（结果页顶栏、提示条、讲练完成页共用，单一出处）。
 *
 * 状态只由服务端事实派生：任务状态 + openedAt + 预览接口是否放行。前端不猜
 * 「能不能复盘」——预览被拒绝就是不可用。读取状态不产生任何写入；「已读」
 * 只在报告阅读器成功渲染正文后由 open 动作写入（见 AttemptReviewReportReader）。
 *
 * 查询键全部挂在 ["student", …] 下：登出 / 换账号时随账号缓存一起清掉。
 */

export const attemptReviewListKey = (attemptId: string) =>
  ["student", "ai-attempt-reviews", attemptId] as const;
export const attemptReviewPreviewKey = (attemptId: string) =>
  ["student", "ai-attempt-review-preview", attemptId] as const;
export const attemptReviewDetailKey = (taskId: string) =>
  ["student", "ai-attempt-review-detail", taskId] as const;
/** 「求助记录」里账号范围的整卷任务列表键前缀（后接归档分组） */
export const attemptReviewQueueKey = [
  "student",
  "ai-attempt-review-queue",
] as const;

/** 在途任务（等待领取 / 处理中）时任务列表的轮询间隔；有结局 / 无任务不轮询 */
export const ATTEMPT_REVIEW_POLL_INTERVAL_MS = 15_000;

/** 整卷任务状态短文案（顶栏、面板、求助记录共用） */
export const ATTEMPT_REVIEW_STATUS_LABEL = {
  created: "等待领取",
  claimed: "处理中",
  replied: "报告已出",
  failed: "失败",
  paused: "已暂停",
  cancelled: "已取消",
} as const satisfies Record<AiAttemptReviewTaskPublic["status"], string>;

/** 结果页地址参数：aiReview=<整卷任务 id> 打开报告；aiReview=panel 打开发起 / 进度面板 */
export const ATTEMPT_REVIEW_PARAM = "aiReview";
export const ATTEMPT_REVIEW_PANEL_TARGET = "panel";

const TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 解析地址参数：只认 "panel" 或任务 id（UUID）。参数来自地址栏，可能是别人
 * 构造的链接——其余值一律当作没有，不拿去拼接口路径。
 */
export function attemptReviewTargetOf(raw: string | null): string | null {
  if (raw === null) return null;
  return raw === ATTEMPT_REVIEW_PANEL_TARGET || TASK_ID_PATTERN.test(raw)
    ? raw
    : null;
}

/**
 * 整卷复盘的唯一地址：所有入口（顶栏、提示条、求助记录、讲练完成页）都只
 * 构造这个地址，由结果页上的承载组件按地址打开——同一份报告不会有两套打开
 * 方式。导航只用任务自己的 attemptId，不按「同一份卷的最新一次」推断轮次。
 * from：来源位置（站内 /s/ 路径），目标页据此提供「返回原页面」。
 */
export function attemptReviewHref(
  attemptId: string,
  target: string,
  from?: string,
): string {
  const params = new URLSearchParams({ [ATTEMPT_REVIEW_PARAM]: target });
  if (from !== undefined) params.set("aiFrom", from);
  return `/s/attempts/${encodeURIComponent(attemptId)}?${params}`;
}

/** 等待领取 / 处理中——入口要跟着它刷新 */
function isActiveTask(task: AiAttemptReviewTaskPublic): boolean {
  return task.status === "created" || task.status === "claimed";
}

/**
 * 活动中的任务优先；其余有结局的（已回信 / 失败 / 暂停）不分档，直接取**最近
 * 更新**的一次——#102-03：先复盘成功过、再发一轮却失败或暂停时，要报的是新
 * 任务待处理，不能让旧报告盖住它。排序键用 updatedAt 而不是 createdAt：重试
 * 复用同一任务行（failed / paused → created，createdAt 不变），重试后新出的
 * 报告才是「最新一次结局」。全部已取消 / 归档则无。
 */
export function pickAttemptReviewTask(
  tasks: readonly AiAttemptReviewTaskPublic[],
): AiAttemptReviewTaskPublic | undefined {
  const live = tasks.filter(
    (task) => task.archivedAt === null && task.status !== "cancelled",
  );
  const rank = (task: AiAttemptReviewTaskPublic): number =>
    isActiveTask(task) ? 0 : 1;
  return [...live].sort(
    (a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt),
  )[0];
}

export type AttemptReviewEntryState =
  | { readonly kind: "unavailable" }
  | { readonly kind: "launch"; readonly counts: AiAttemptReviewCounts }
  | {
      readonly kind: "waiting" | "processing" | "attention";
      readonly task: AiAttemptReviewTaskPublic;
    }
  | {
      readonly kind: "report";
      readonly task: AiAttemptReviewTaskPublic;
      readonly unread: boolean;
    };

/**
 * 入口状态：有任务按任务报；无任务且预览放行 → 可发起；否则不可用。
 * previewCounts 只在服务端本轮预览成功时传入（拒绝 / 加载中 / 未公布传 null）。
 */
export function attemptReviewEntryStateOf(
  task: AiAttemptReviewTaskPublic | undefined,
  previewCounts: AiAttemptReviewCounts | null,
): AttemptReviewEntryState {
  if (task === undefined) {
    return previewCounts === null
      ? { kind: "unavailable" }
      : { kind: "launch", counts: previewCounts };
  }
  switch (task.status) {
    case "created":
      return { kind: "waiting", task };
    case "claimed":
      return { kind: "processing", task };
    case "replied":
      return { kind: "report", task, unread: task.openedAt === null };
    default:
      // paused / failed 需要本人处理；cancelled 已被 pickAttemptReviewTask 排除，
      // 万一传入也按需处理呈现（面板里如实显示状态）
      return { kind: "attention", task };
  }
}

/** 入口按钮呈现：文字、主次、点击目标（面板或某份报告）、未读与警示标记 */
export interface AttemptReviewEntryView {
  readonly label: string;
  readonly tone: "primary" | "outline";
  readonly target: string;
  readonly unread: boolean;
  readonly attention: boolean;
  /**
   * 结果页顶栏在窄屏是否收起为紧凑形态：只有已读的报告收起（入口仍在，不再
   * 占一整行）。再发起一轮、或新报告未读时状态变了，自然重新展开。
   */
  readonly compact: boolean;
}

export function attemptReviewEntryViewOf(
  state: AttemptReviewEntryState,
): AttemptReviewEntryView | null {
  const panel = {
    target: ATTEMPT_REVIEW_PANEL_TARGET,
    unread: false,
    compact: false,
  };
  switch (state.kind) {
    case "unavailable":
      return null;
    case "launch":
      return { ...panel, label: "整卷复盘", tone: "primary", attention: false };
    case "waiting":
    case "processing":
      return {
        ...panel,
        label: `整卷复盘 · ${ATTEMPT_REVIEW_STATUS_LABEL[state.task.status]}`,
        tone: "outline",
        attention: false,
      };
    case "attention":
      return {
        ...panel,
        label: "整卷复盘 · 需处理",
        tone: "outline",
        attention: true,
      };
    case "report":
      return {
        label: "查看整卷复盘报告",
        tone: state.unread ? "primary" : "outline",
        target: state.task.id,
        unread: state.unread,
        attention: false,
        compact: !state.unread,
      };
  }
}

/**
 * 入口状态查询（只读）：任务列表 + 无任务时的可用性预览。
 * - 可用门全部在服务端：预览接口（整卷已交 + 答案已公布 + 全部题当前策略允许）
 *   拒绝即不可用；
 * - #102-01：等待领取 / 处理中时每 15 秒核对一次（页面隐藏时 TanStack 默认
 *   暂停）；无任务 / 已有结局不轮询；
 * - #102-02：TanStack v5 重取失败后 status=error 但仍保留上次 data——教师刚
 *   收紧策略时不能拿旧缓存继续引导点击，所以只认本轮 isSuccess。
 */
export function useAttemptReviewEntry(
  attemptId: string,
  released: boolean,
): AttemptReviewEntryState {
  const tasksQuery = useQuery({
    queryKey: attemptReviewListKey(attemptId),
    queryFn: () => listStudentAiAttemptReviewsApi(attemptId),
    enabled: released,
    staleTime: 15_000,
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined) return false;
      const current = pickAttemptReviewTask(data.tasks);
      return current !== undefined && isActiveTask(current)
        ? ATTEMPT_REVIEW_POLL_INTERVAL_MS
        : false;
    },
  });
  const task =
    tasksQuery.data === undefined
      ? undefined
      : pickAttemptReviewTask(tasksQuery.data.tasks);
  const previewQuery = useQuery({
    queryKey: attemptReviewPreviewKey(attemptId),
    queryFn: () => fetchStudentAiAttemptReviewPreviewApi(attemptId),
    enabled: released && tasksQuery.isSuccess && task === undefined,
    staleTime: 15_000,
    retry: false,
  });
  if (!released) return { kind: "unavailable" };
  return attemptReviewEntryStateOf(
    task,
    previewQuery.isSuccess ? previewQuery.data.counts : null,
  );
}
