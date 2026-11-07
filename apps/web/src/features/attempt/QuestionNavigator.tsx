import { CircleHelp, Flag } from "lucide-react";
import type { Ref } from "react";
import { PracticeSubmittedMark } from "./PracticeWorkspace";
import {
  completionLabel,
  type QuestionCompletion,
} from "./question-completion";

export interface QuestionNavigationItem {
  id: string;
  index: number;
  completion: QuestionCompletion;
  flagged: boolean;
  /** #6980-4：做题时标了「不会」（服务端保存；题号导航用不同图标与待检查并存） */
  unsure?: boolean;
  /**
   * 逐题提交进度（M3-D1，v1 新协议卷）：submitted=服务端已确认提交；
   * feedbackReadable=当前节奏与教师 gate 是否允许读本题反馈。undefined =
   * 旧协议/讲练卷，维持原三态呈现（零变化）。统一公布模式下已提交行不得
   * 出现红绿对错或正确率暗示（§9.1），仅用中性图标与文字区分。
   */
  practice?: { submitted: boolean; feedbackReadable: boolean };
}

/** 单格的可达名：已提交行先报提交事实，不混入对错与得分 */
function itemLabel(item: QuestionNavigationItem, label?: string): string {
  const state = item.practice?.submitted
    ? item.practice.feedbackReadable
      ? "已提交"
      : "已提交，反馈待公布"
    : (label ?? completionLabel(item.completion));
  return `第 ${item.index + 1} 题，${state}${item.flagged ? "，待检查" : ""}${item.unsure ? "，标过不会" : ""}`;
}

/** 单格样式：已提交用中性前景色系（可读=浅底实线、待公布=灰底），非红绿 */
function itemClass(
  item: QuestionNavigationItem,
  current: boolean,
  state: QuestionCompletion["state"],
): string {
  const base =
    "relative flex size-11 items-center justify-center rounded-md border text-sm font-medium tabular-nums outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
  const currentRing = current
    ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
    : "";
  if (item.practice?.submitted) {
    return `${base} ${item.practice.feedbackReadable ? "border-foreground/40 bg-foreground/10 text-foreground" : "border-foreground/25 bg-muted text-muted-foreground"} ${currentRing}`;
  }
  const completion =
    state === "filled"
      ? "border-primary bg-primary text-primary-foreground"
      : state === "partial"
        ? "border-primary bg-primary/10 text-primary"
        : "border-border bg-card text-foreground";
  return `${base} ${completion} ${currentRing}`;
}

export function QuestionNavigationTile({
  item,
  current,
  onJump,
  locked,
  ref,
  answerCardState,
}: {
  item: QuestionNavigationItem;
  current: boolean;
  onJump: (id: string) => void;
  locked?: boolean;
  ref?: Ref<HTMLButtonElement> | undefined;
  answerCardState?: QuestionCompletion["state"] | "unknown" | undefined;
}) {
  const state =
    answerCardState === undefined || answerCardState === "unknown"
      ? item.completion.state
      : answerCardState;
  const label =
    answerCardState === "partial"
      ? "部分作答"
      : answerCardState === "unknown"
        ? "作答状态尚未确认"
        : undefined;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={itemLabel(item, label)}
      aria-current={current ? "location" : undefined}
      disabled={locked}
      onClick={() => onJump(item.id)}
      className={itemClass(item, current, state)}
    >
      {item.index + 1}
      {item.practice?.submitted && (
        <PracticeSubmittedMark
          feedbackReadable={item.practice.feedbackReadable}
        />
      )}
      {answerCardState === undefined && state === "partial" && (
        <span aria-hidden className="absolute bottom-1 h-0.5 w-3 bg-current" />
      )}
      {item.flagged && (
        <Flag aria-hidden className="absolute end-0.5 top-0.5 size-2.5" />
      )}
      {item.unsure && (
        <CircleHelp
          aria-hidden
          className={
            answerCardState === undefined
              ? "absolute bottom-0.5 right-0.5 size-2.5 text-amber-600 dark:text-amber-400"
              : item.practice?.submitted
                ? "absolute start-0.5 bottom-0.5 size-2.5"
                : "absolute start-0.5 top-0.5 size-2.5"
          }
        />
      )}
    </button>
  );
}
