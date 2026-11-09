import { Grid2X2 } from "lucide-react";
import type { ComponentProps, SyntheticEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LiveAttemptAnswerCard } from "./AttemptAnswerCard";

/**
 * 题号导航上滑面板（阶段 B 做题工作区改版，2026-11，从 AttemptSession 抽出）：
 * 窄屏（< lg，左栏题号导航不渲染）的答题卡入口落点——底部贴边上滑、保留
 * safe-area；lg 起退为居中弹层（左栏已常驻，面板只在学生显式点底栏题号时
 * 出现，承担筛选与「部分作答」细分）。
 * 内容复用 LiveAttemptAnswerCard：打开时才订阅草稿纸/标画仓判「部分作答」。
 * 进出场沿用 DialogContent 的淡入 + 95% 缩放（不加自底上滑：上滑动画途中面板
 * 底边会越出视口，既有 e2e 以打开瞬间的几何边界断言贴底）。
 */
export function AttemptNavigatorSheet({
  open,
  onOpenChange,
  onCloseAutoFocus,
  answered,
  total,
  submittedCount,
  ...card
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 关闭后的焦点归还策略由页面决定（跳题后不抢焦点；否则回触发按钮） */
  onCloseAutoFocus: (event: SyntheticEvent | Event) => void;
  answered: number;
  total: number;
  /** v1 卷逐题提交数；legacy 卷 undefined 不显示该段 */
  submittedCount?: number | undefined;
} & ComponentProps<typeof LiveAttemptAnswerCard>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-navigator-sheet="true"
        onCloseAutoFocus={onCloseAutoFocus}
        className="flex h-[560px] max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] max-w-[608px] flex-col gap-3 overflow-hidden rounded-[25px] p-4 shadow-md max-lg:inset-x-0 max-lg:top-auto max-lg:bottom-0 max-lg:w-full max-lg:max-w-full max-lg:translate-x-0 max-lg:translate-y-0 max-lg:rounded-b-none max-lg:pb-[max(16px,env(safe-area-inset-bottom))] [&>[data-slot=dialog-close]]:bg-muted motion-safe:[&>[data-slot=dialog-close]]:transition-transform motion-safe:[&>[data-slot=dialog-close]]:duration-150 motion-safe:[&>[data-slot=dialog-close]]:active:scale-[0.96] [&>[data-slot=dialog-close]]:ease-out motion-reduce:[&>[data-slot=dialog-close]]:transition-opacity motion-reduce:[&>[data-slot=dialog-close]]:duration-150 motion-reduce:[&>[data-slot=dialog-close]]:active:opacity-75"
      >
        <DialogHeader className="shrink-0 pe-12">
          <DialogTitle className="flex items-center gap-2">
            <Grid2X2 aria-hidden className="size-4" />
            答题卡
          </DialogTitle>
          <DialogDescription>
            已填写 {answered}/{total} 题
            {submittedCount !== undefined && (
              <>
                {" "}
                · 已提交 {submittedCount}/{total} 题
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <LiveAttemptAnswerCard {...card} />
      </DialogContent>
    </Dialog>
  );
}
