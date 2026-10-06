import { cn } from "cn";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";

/**
 * 对话框组件（shadcn/ui 风格、radix-ui Dialog 底座，源码落在仓库内可改）。
 * T1.12 起用于删除确认、新建课程等居中模态；键盘可达（Esc 关闭、焦点圈闭）。
 */

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = ({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) => (
  <DialogPrimitive.Overlay
    data-slot="dialog-overlay"
    className={cn(
      "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
);

const DialogContent = ({
  className,
  children,
  /** 关闭钮禁用（T6R.10 交卷准备中）：× 退化为非交互占位（不可点/不可聚焦），防准备中途关闭打断流程 */
  closeDisabled = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  closeDisabled?: boolean;
}) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      data-slot="dialog-content"
      className={cn(
        // max-h + 内滚：内容超出视口时限高在弹窗内部滚动，保证底部按钮
        // （取消/创建等）始终可达。固定定位居中的弹窗无法靠页面滚动救回
        // 视口外的内容——小屏 iPad 或数据多（如「新增学生」的课程多选）
        // 时会把 footer 挤出屏幕（webkit E2E 高负载下曾致「创建」按钮
        // 滚不进视口超时）。与原 AssignmentComposeWizard/
        // AssignmentEditDialog 的 per-usage 写法同一取值，已收敛到基座。
        "fixed top-1/2 left-1/2 z-50 grid max-h-[88vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        className,
      )}
      {...props}
    >
      {children}
      {/* 关闭钮触控目标 ≥44px（size-11，Opus 实测③-3）；图标中心保持
          在 padding 网格原位（top-2.5 + 22px = 原 top-4 + 16px = 32px），
          仅扩大热区，视觉位置不变。closeDisabled 时以非交互占位替换
          （Radix Close 无 disabled 语义——span 占位杜绝点击与键盘激活，
          关闭=取消=中止的语义由调用方统一） */}
      {closeDisabled ? (
        <span
          data-slot="dialog-close"
          aria-hidden
          className="absolute top-2.5 right-2.5 flex size-11 items-center justify-center rounded-md text-muted-foreground opacity-50"
        >
          <X aria-hidden className="size-4" />
        </span>
      ) : (
        <DialogPrimitive.Close
          data-slot="dialog-close"
          aria-label="关闭弹层"
          className="absolute top-2.5 right-2.5 flex size-11 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <X aria-hidden className="size-4" />
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
);

const DialogHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    data-slot="dialog-header"
    className={cn("flex flex-col gap-1.5 text-left", className)}
    {...props}
  />
);

const DialogFooter = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    data-slot="dialog-footer"
    className={cn(
      "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
      className,
    )}
    {...props}
  />
);

const DialogTitle = ({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) => (
  <DialogPrimitive.Title
    data-slot="dialog-title"
    className={cn("text-base leading-none font-semibold", className)}
    {...props}
  />
);

const DialogDescription = ({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) => (
  <DialogPrimitive.Description
    data-slot="dialog-description"
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
);

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
