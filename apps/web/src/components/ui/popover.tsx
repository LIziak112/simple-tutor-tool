import { cn } from "cn";
import { Popover as PopoverPrimitive } from "radix-ui";
import type * as React from "react";

/**
 * 浮层面板（shadcn/ui 风格、radix-ui Popover 底座，源码落在仓库内可改）。
 * 手写工具栏的工具选项面板起用。非模态：在面板外点一下就关（按下不关，等到
 * 随后的 click 才关），且不吞掉那一下指针——面板开着时可以直接在纸面落笔；
 * 要「按下当即关」的调用方自己监听 pointerdown（见 InkToolbar）。Esc 关闭并把
 * 焦点还给触发按钮。Content 走 portal 挂 body，role=dialog，调用方须给
 * aria-label。
 */

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverContent = ({
  className,
  align = "center",
  sideOffset = 8,
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      data-slot="popover-content"
      align={align}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        "z-50 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-card p-3 text-sm shadow-lg outline-none",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
);

export { Popover, PopoverContent, PopoverTrigger };
