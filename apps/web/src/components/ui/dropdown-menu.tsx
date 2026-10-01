import { cn } from "cn";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import type * as React from "react";

/**
 * 下拉菜单组件（shadcn/ui 风格、radix-ui DropdownMenu 底座，源码落在仓库内可改）。
 * 资源库文件夹行「⋯ 更多操作」菜单起用；Content 走 portal 挂 body，菜单项
 * min-h-11 保证触屏目标（§4-9）。
 */

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

const DropdownMenuContent = ({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      data-slot="dropdown-menu-content"
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-40 overflow-hidden rounded-lg border border-border bg-card p-1 text-sm shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
);

const DropdownMenuItem = ({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  /** destructive：红色文字与悬停底色（如删除类操作） */
  variant?: "default" | "destructive";
}) => (
  <DropdownMenuPrimitive.Item
    data-slot="dropdown-menu-item"
    data-variant={variant}
    className={cn(
      "relative flex min-h-11 cursor-default items-center gap-2 rounded-md px-2 py-2 text-sm outline-none select-none focus:bg-muted focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
      variant === "destructive" &&
        "text-destructive focus:bg-destructive/10 focus:text-destructive",
      className,
    )}
    {...props}
  />
);

const DropdownMenuSeparator = ({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) => (
  <DropdownMenuPrimitive.Separator
    data-slot="dropdown-menu-separator"
    className={cn("-mx-1 my-1 h-px bg-border", className)}
    {...props}
  />
);

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
};
