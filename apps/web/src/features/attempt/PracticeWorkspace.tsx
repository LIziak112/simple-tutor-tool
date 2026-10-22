import type { PracticeLayout, PracticeWorkflow } from "@tutor/contract";
import { Check, ChevronDown, Clock } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";
import {
  practiceLayoutLabel,
  practiceRestrictionCopy,
  practiceRhythmLabel,
} from "./practice-protocol";

/**
 * PracticeWorkspace 呈现件（M3-D1，计划 §7.1/§7.2/§9.1）：做题方式摘要行、
 * 单题紧凑进度行、占位主操作条与「更多」菜单切换项。只改变呈现，不搬题卡、
 * 不复制题面（题卡列表仍在 AttemptSession 的同一 keyed 序列里，纪律 §11-1）；
 * 主操作条中间为占位容器，三态交互（提交本题→查看反馈→下一题）由 D2 接线。
 */

/** 摘要行：当前布局与反馈节奏一行摘要，可展开改本次布局（不写回默认偏好） */
export function PracticeModeSummary({
  workflow,
  layout,
  onLayoutChange,
}: {
  workflow: PracticeWorkflow;
  layout: PracticeLayout;
  onLayoutChange: (layout: PracticeLayout) => void;
}) {
  const [open, setOpen] = useState(false);
  const restriction = practiceRestrictionCopy(workflow);
  return (
    <div
      data-slot="practice-mode-summary"
      className="min-w-0 rounded-lg border border-border bg-card text-sm"
    >
      <button
        type="button"
        aria-label="调整做题方式"
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="min-w-0 flex-1 break-words">
          做题方式：{practiceLayoutLabel(layout)} ·{" "}
          {practiceRhythmLabel(workflow.feedbackMode)}
          {restriction !== null && (
            <span className="ml-1 text-muted-foreground">{restriction}</span>
          )}
        </span>
        <ChevronDown
          aria-hidden
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border p-3">
          <fieldset className="grid min-w-0 gap-2 sm:grid-cols-2">
            <legend className="sr-only">选择本次做题布局</legend>
            {(
              [
                { value: "list", title: "列表作答" },
                { value: "single", title: "单题专注" },
              ] as const
            ).map(({ value, title }) => (
              <label
                key={value}
                className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 outline-none has-focus-visible:ring-3 has-focus-visible:ring-ring/50 ${
                  layout === value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted/40"
                }`}
              >
                <input
                  className="size-4 shrink-0 accent-primary"
                  type="radio"
                  name="practice-this-attempt-layout"
                  value={value}
                  checked={layout === value}
                  onChange={() => onLayoutChange(value)}
                />
                <span className="text-sm font-medium">{title}</span>
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-muted-foreground">
            仅对本次作答生效，不改变默认偏好。
          </p>
        </div>
      )}
    </div>
  );
}

/** 单题紧凑进度行：题号与提交进度放工作区，不塞顶栏（§7.1） */
export function SingleQuestionProgressRow({
  current,
  total,
  submittedCount,
  onOpenNavigator,
}: {
  current: number;
  total: number;
  submittedCount: number;
  onOpenNavigator: () => void;
}) {
  return (
    <div
      data-slot="practice-progress-row"
      className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-border bg-card px-4 py-1.5 text-sm"
    >
      <p aria-live="polite" className="min-w-0 break-words tabular-nums">
        第 {current} / {total} 题 · 已提交 {submittedCount} 题
      </p>
      <Button
        variant="outline"
        className="min-h-9 shrink-0 px-3"
        onClick={onOpenNavigator}
      >
        题目导航
      </Button>
    </div>
  );
}

/**
 * 单题占位主操作条（§7.2）：上一题 / 主操作位 / 下一题。主操作位 D1 仅渲染
 * 占位容器，「提交本题 → 查看反馈 → 下一题」三态由 D2 接线，不得提前伪造。
 */
export function SingleQuestionActionBar({
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: {
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div
      data-slot="practice-action-bar"
      className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card p-2"
    >
      <Button
        variant="outline"
        className="min-h-11 shrink-0"
        disabled={!hasPrev}
        onClick={onPrev}
      >
        上一题
      </Button>
      <div
        data-slot="practice-action-placeholder"
        aria-hidden
        className="h-11 min-w-0 flex-1"
      />
      <Button
        variant="outline"
        className="min-h-11 shrink-0"
        disabled={!hasNext}
        onClick={onNext}
      >
        下一题
      </Button>
    </div>
  );
}

/** 「更多」菜单里的做题方式切换项：当前卷即时生效，不写回默认偏好 */
export function PracticeLayoutMenuItems({
  layout,
  onChange,
}: {
  layout: PracticeLayout;
  onChange: (layout: PracticeLayout) => void;
}): ReactNode {
  return (
    <>
      <DropdownMenuRadioItem
        checked={layout === "list"}
        onSelect={() => onChange("list")}
      >
        做题方式：列表
      </DropdownMenuRadioItem>
      <DropdownMenuRadioItem
        checked={layout === "single"}
        onSelect={() => onChange("single")}
      >
        做题方式：单题
      </DropdownMenuRadioItem>
    </>
  );
}

/** 已提交态的小图标（导航格右上角）：可读=已提交事实；待公布=时钟，均非对错 */
export function PracticeSubmittedMark({
  feedbackReadable,
}: {
  feedbackReadable: boolean;
}) {
  return feedbackReadable ? (
    <Check aria-hidden className="absolute left-0.5 top-0.5 size-2.5" />
  ) : (
    <Clock aria-hidden className="absolute left-0.5 top-0.5 size-2.5" />
  );
}
