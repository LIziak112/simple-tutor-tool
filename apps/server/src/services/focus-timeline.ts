import { Buffer } from "node:buffer";
import type { TimelineEvent } from "./active-time.ts";

/** 服务端动作和提交时钟不能混进浏览器焦点区间。 */
export function isFocusTimelineEvent(
  event: Pick<TimelineEvent, "type">,
): boolean {
  return !["submit", "hint_open", "question_submit"].includes(event.type);
}

/** 在线落账与历史回放共用筛选和次序；id 按 SQLite BINARY 的 UTF-8 字节比较。 */
export function focusTimelineOf<
  T extends TimelineEvent & { readonly id: string },
>(rows: readonly T[]): T[] {
  return rows
    .filter(isFocusTimelineEvent)
    .sort(
      (left, right) =>
        left.clientTs - right.clientTs ||
        Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)),
    );
}
