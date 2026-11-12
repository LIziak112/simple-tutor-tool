import type {
  AiTaskBatchOrigin,
  AiTaskOriginSummary,
  AiTaskPublic,
} from "@tutor/contract";

/**
 * 「求助记录」逐题任务的分组模型：同一次批量复盘创建的任务合成一组（批次
 * 来源由服务端在来源摘要里给出，前端不按时间或问题文字猜），其余各自成条。
 */

export interface AiQueueBatchItem {
  readonly task: AiTaskPublic;
  readonly origin: AiTaskOriginSummary;
}

export type AiQueueEntry =
  | {
      readonly kind: "single";
      readonly task: AiTaskPublic;
      readonly origin: AiTaskOriginSummary | undefined;
    }
  | {
      readonly kind: "batch";
      readonly batch: AiTaskBatchOrigin;
      readonly items: readonly AiQueueBatchItem[];
    };

/**
 * 按列表次序分组：批次出现在它最新一条任务的位置，组内按题号排（题已不在
 * 卷内的排最后）。缺来源摘要的任务按单题呈现。
 */
export function aiQueueEntriesOf(
  tasks: readonly AiTaskPublic[],
  originOf: (taskId: string) => AiTaskOriginSummary | undefined,
): AiQueueEntry[] {
  const entries: AiQueueEntry[] = [];
  const itemsByBatch = new Map<string, AiQueueBatchItem[]>();
  for (const task of tasks) {
    const origin = originOf(task.id);
    const batch = origin?.batch ?? null;
    if (origin === undefined || batch === null) {
      entries.push({ kind: "single", task, origin });
      continue;
    }
    const items = itemsByBatch.get(batch.id);
    if (items !== undefined) {
      items.push({ task, origin });
      continue;
    }
    const created: AiQueueBatchItem[] = [{ task, origin }];
    itemsByBatch.set(batch.id, created);
    entries.push({ kind: "batch", batch, items: created });
  }
  const rank = (item: AiQueueBatchItem) =>
    item.origin.questionNo ?? Number.MAX_SAFE_INTEGER;
  for (const items of itemsByBatch.values()) {
    items.sort((a, b) => rank(a) - rank(b));
  }
  return entries;
}

/** 处理状态短文案（列表用；对话面板的完整文案在 AiConversationPanel） */
export function aiTaskStatusLabelOf(status: AiTaskPublic["status"]): string {
  switch (status) {
    case "created":
      return "待领取";
    case "dispatching":
      return "发送中";
    case "uncertain":
      return "待确认";
    case "claimed":
      return "处理中";
    case "replied":
      return "已回复";
    case "paused":
      return "已暂停";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

/** 进度汇总的状态次序：先报有结果的，再报在途的，最后报需要处理和已结束的 */
const PROGRESS_ORDER = [
  "replied",
  "claimed",
  "dispatching",
  "uncertain",
  "created",
  "paused",
  "failed",
  "cancelled",
] as const satisfies readonly AiTaskPublic["status"][];

/** 批次进度一句话：只列出现过的状态，如「已回复 2 · 处理中 1 · 待领取 3」 */
export function batchProgressTextOf(
  tasks: readonly Pick<AiTaskPublic, "status">[],
): string {
  return PROGRESS_ORDER.map((status) => ({
    status,
    count: tasks.filter((task) => task.status === status).length,
  }))
    .filter((row) => row.count > 0)
    .map((row) => `${aiTaskStatusLabelOf(row.status)} ${row.count}`)
    .join(" · ");
}
