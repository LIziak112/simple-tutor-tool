import type {
  PracticeFeedbackMode,
  PracticeLayout,
  PracticeWorkflow,
} from "@tutor/contract";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Keyboard,
} from "lucide-react";
import { type ReactNode, useId } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  formatKeys,
  PRACTICE_KEYBOARD_COMMANDS,
} from "@/features/keyboard/command-registry";
import { useKeyboardBindings } from "@/features/keyboard/keyboard-binding-store";
import {
  practiceLayoutLabel,
  practiceLayoutOptions,
  practiceRestrictionCopy,
  practiceRhythmLabel,
} from "./practice-protocol";

/** 反馈节奏两枚选项（标签复用 practiceRhythmLabel 单一出处） */
const feedbackModeOptions = [
  { value: "per_question" },
  { value: "after_attempt" },
] as const;

/** 单元预选与作答中的单选提交选项。 */
export function ChoiceSubmitOptions({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
}) {
  const name = useId();
  return (
    <fieldset
      disabled={disabled}
      className="grid min-w-0 gap-2 sm:grid-cols-2 disabled:opacity-60"
    >
      <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
        单选题怎么提交
      </legend>
      {([false, true] as const).map((auto) => (
        <label
          key={String(auto)}
          className={`flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm font-medium has-focus-visible:ring-3 has-focus-visible:ring-ring/50 ${value === auto ? "border-primary bg-primary/5" : "border-border"} ${disabled ? "" : "cursor-pointer"}`}
        >
          <input
            className="size-4 shrink-0 accent-primary"
            type="radio"
            name={name}
            checked={value === auto}
            onChange={() => onChange(auto)}
          />
          {auto ? "选中即提交" : "点提交按钮"}
        </label>
      ))}
    </fieldset>
  );
}

interface PracticeModeEditorProps {
  workflow: PracticeWorkflow;
  layout: PracticeLayout;
  onLayoutChange: (layout: PracticeLayout) => void;
  autoSubmitChoice?: boolean;
  onAutoSubmitChoiceChange?: (auto: boolean) => void;
  /** 反馈节奏切换回调（M5-D3）：由调用方 PATCH CAS 提交；缺省仅呈现 */
  onFeedbackModeChange?: (mode: PracticeFeedbackMode) => void;
  /** PATCH 在途：节奏组临时禁用防重复提交 */
  feedbackBusy?: boolean;
  /** 就地错误提示（stale「已刷新请重试」或服务端 message） */
  feedbackError?: string | null;
}

/** 做题方式唯一编辑器：布局与反馈节奏两组选项 + 限制说明 */
function PracticeModeEditor({
  workflow,
  layout,
  onLayoutChange,
  autoSubmitChoice = false,
  onAutoSubmitChoiceChange,
  onFeedbackModeChange,
  feedbackBusy = false,
  feedbackError = null,
}: PracticeModeEditorProps) {
  const restriction = practiceRestrictionCopy(workflow);
  return (
    <div className="space-y-2">
      <fieldset className="grid min-w-0 gap-2 sm:grid-cols-2">
        <legend className="sr-only">选择本次做题布局</legend>
        {practiceLayoutOptions.map(({ value, title }) => (
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
      {/* 反馈节奏（M5-D3）：canChangeFeedback=false 整组禁用（fieldset
          disabled 连带输入）；allowedFeedbackModes 外的项单项禁用——
          均只按服务端投影，不客户端预判 */}
      <fieldset
        className="grid min-w-0 gap-2 sm:grid-cols-2"
        disabled={!workflow.canChangeFeedback}
      >
        <legend className="sr-only">选择反馈节奏</legend>
        {feedbackModeOptions.map(({ value }) => {
          const itemDisabled =
            feedbackBusy || !workflow.allowedFeedbackModes.includes(value);
          return (
            <label
              key={value}
              className={`flex min-h-11 items-center gap-2 rounded-lg border px-3 outline-none has-focus-visible:ring-3 has-focus-visible:ring-ring/50 ${
                workflow.feedbackMode === value
                  ? "border-primary bg-primary/5"
                  : itemDisabled
                    ? "border-border opacity-60"
                    : "cursor-pointer border-border hover:bg-muted/40"
              }`}
            >
              <input
                className="size-4 shrink-0 accent-primary"
                type="radio"
                name="practice-attempt-feedback-mode"
                value={value}
                checked={workflow.feedbackMode === value}
                disabled={itemDisabled}
                onChange={() => onFeedbackModeChange?.(value)}
              />
              <span className="text-sm font-medium">
                {practiceRhythmLabel(value)}
              </span>
            </label>
          );
        })}
      </fieldset>
      {onAutoSubmitChoiceChange && (
        <ChoiceSubmitOptions
          value={autoSubmitChoice}
          onChange={onAutoSubmitChoiceChange}
          disabled={!workflow.canSubmitQuestion || feedbackBusy}
        />
      )}
      {restriction !== null && (
        <p className="text-xs text-muted-foreground">{restriction}</p>
      )}
      {!workflow.canChangeFeedback && restriction === null && (
        <p className="text-xs text-muted-foreground">
          本卷已有题目提交，反馈节奏已固定；仍可切换布局。
        </p>
      )}
      {feedbackError !== null && (
        <p role="alert" className="text-xs text-destructive">
          {feedbackError}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        仅对本次作答生效，不改变默认偏好。
      </p>
    </div>
  );
}

/** 列表和单题共用的做题方式弹窗。 */
export function PracticeModeDialog({
  open,
  onOpenChange,
  onReturnFocus,
  ...editor
}: PracticeModeEditorProps & {
  onReturnFocus?: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85dvh] w-[calc(100%-24px)] max-w-lg overflow-y-auto rounded-lg"
        onCloseAutoFocus={(event) => {
          if (onReturnFocus) {
            event.preventDefault();
            onReturnFocus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>做题方式</DialogTitle>
          <DialogDescription className="break-words">
            做题方式：{practiceLayoutLabel(editor.layout)} ·{" "}
            {practiceRhythmLabel(editor.workflow.feedbackMode)}
          </DialogDescription>
        </DialogHeader>
        <PracticeModeEditor
          {...editor}
          onLayoutChange={(layout) => {
            editor.onLayoutChange(layout);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * 单题主操作条（§7.2）：上一题 / 主操作位 / 下一题，嵌在吸底栏内不自带
 * 边框卡片；左右为带箭头的轻量导航，与主动作区分。
 * busy（本题提交在途）时上一题/下一题禁用——单题模式提交中禁切题（§7.2）；
 * 导航跳题由页面层 locked 同步禁用。
 */
export function SingleQuestionActionBar({
  showNext,
  hasPrev,
  hasNext,
  busy = false,
  middle,
  navigation,
  onPrev,
  onNext,
}: {
  showNext?: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  /** 本题提交在途：禁用切题（提交中不得离开当前题） */
  busy?: boolean;
  /** 主操作位内容（PracticeSingleActions）；缺省保持占位容器 */
  middle?: ReactNode;
  /** 题号兼答题卡入口，与主操作共用一行。 */
  navigation?: ReactNode;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div
      data-slot="practice-action-bar"
      className="flex min-w-0 items-center gap-1 sm:gap-2"
    >
      {navigation}
      <Button
        variant="ghost"
        className="ms-auto size-11 shrink-0 p-0 sm:w-auto sm:px-3"
        aria-label="上一题"
        disabled={!hasPrev || busy}
        onClick={onPrev}
      >
        <ChevronLeft aria-hidden className="size-4" />
        <span aria-hidden className="hidden sm:inline">
          上一题
        </span>
      </Button>
      <div
        data-slot="practice-action-placeholder"
        aria-hidden={middle === undefined ? true : undefined}
        className={middle === undefined ? "h-11 min-w-0" : "min-w-0"}
      >
        {middle}
      </div>
      {(showNext ?? middle === undefined) && (
        <Button
          variant="ghost"
          className="size-11 shrink-0 p-0 sm:w-auto sm:px-3"
          aria-label="下一题"
          disabled={!hasNext || busy}
          onClick={onNext}
        >
          <span aria-hidden className="hidden sm:inline">
            下一题
          </span>
          <ChevronRight aria-hidden className="size-4" />
        </Button>
      )}
    </div>
  );
}

/** 快捷键帮助的键位行（小弹层紧凑排版） */
function HelpKeyRow({ keys, action }: { keys: string; action: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 font-medium">{keys}</dt>
      <dd className="text-right text-muted-foreground">{action}</dd>
    </div>
  );
}

/**
 * 「更多」菜单快捷键帮助项（M3-D3 §9.2）：只渲染菜单项并回调 onOpen——
 * 菜单内容在选中后整树卸载，弹层状态须由调用方持有（弹层在菜单子树外渲染）。
 */
export function PracticeKeyboardHelpMenuItem({
  onOpen,
}: {
  onOpen: () => void;
}): ReactNode {
  return (
    <DropdownMenuItem onSelect={onOpen}>
      <Keyboard aria-hidden className="size-4" />
      快捷键
    </DropdownMenuItem>
  );
}

/**
 * 快捷键帮助小弹层（2026-10-28 起注册表驱动）：列出全部命令的中文含义与
 * 当前生效键位（含用户自定义），固定项标注「固定」。入口与弹层仅键盘设备
 * 渲染（调用方门控）——纯触控设备不出现任何快捷键 UI。
 */
export function PracticeKeyboardHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactNode {
  const bindings = useKeyboardBindings();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-lg">
        <DialogHeader>
          <DialogTitle>键盘快捷键</DialogTitle>
          <DialogDescription>
            单题专注作答时可用；列表作答不响应这些按键。可在「设置 → 学习
            偏好」修改键位。
          </DialogDescription>
        </DialogHeader>
        <dl className="space-y-2 text-sm">
          {PRACTICE_KEYBOARD_COMMANDS.map((command) => (
            <HelpKeyRow
              key={command.id}
              keys={formatKeys(bindings[command.id])}
              action={`${command.description}${command.customizable ? "" : "（固定）"}`}
            />
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          输入答案、书写纸面和弹层打开时快捷键自动让位；Esc 与 Tab 保持系统
          行为。
        </p>
      </DialogContent>
    </Dialog>
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
