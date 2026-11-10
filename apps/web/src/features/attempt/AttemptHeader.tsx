import { ArrowLeft, Info, MoreHorizontal, NotebookPen } from "lucide-react";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MemoQuickCaptureDialog } from "@/features/memos/MemoQuickCapture";
import { useReadingToolbar } from "@/features/student/use-reading-toolbar";
import { AttemptEditorNotice, useAttemptEditor } from "./AttemptEditorContext";

export function AttemptHeader({
  title,
  moreTriggerRef,
  onBack,
  actions,
  menuItems,
  children,
}: {
  title: string;
  moreTriggerRef?: RefObject<HTMLButtonElement | null>;
  onBack: () => void;
  /** 标题右侧的扩展动作位（SAI-19 AI 助教入口；无动作时不占格） */
  actions?: ReactNode;
  /**
   * 「练习更多」菜单的扩展项（M3-D1 做题方式切换等），插在「练习信息」前；
   * 不传时菜单维持原样（legacy/lesson 卷零变化）。
   */
  menuItems?: ReactNode;
  children: ReactNode;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  // 随手记（模块 5 第一步）：作答页有吸底操作条，浮动按钮会压住它，入口放菜单里
  const [memoOpen, setMemoOpen] = useState(false);
  const ownTrigger = useRef<HTMLButtonElement>(null);
  const trigger = moreTriggerRef ?? ownTrigger;
  const editor = useAttemptEditor();
  const toolbar = useReadingToolbar({
    blocked: detailsOpen || editor?.active != null,
  });
  const hasActions = actions != null;
  return (
    <header
      ref={toolbar.ref}
      data-reading-hidden={toolbar.hidden}
      data-slot="attempt-header"
      className={`reading-toolbar sticky top-0 z-20 -mx-3 grid min-h-14 items-center gap-x-2 border-b border-border bg-background/95 px-3 py-1.5 backdrop-blur sm:-mx-6 sm:min-h-16 sm:px-6 sm:py-2 ${hasActions ? "grid-cols-[44px_minmax(0,1fr)_44px_44px] sm:grid-cols-[44px_minmax(0,1fr)_auto_44px]" : "grid-cols-[44px_minmax(0,1fr)_44px]"}`}
    >
      <div className="contents">
        <Button
          type="button"
          variant="ghost"
          className="col-start-1 row-start-1 size-11 shrink-0 p-0"
          aria-label="返回"
          title="返回"
          onClick={onBack}
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Button>
        <h1 className="col-start-2 row-start-1 truncate min-w-0 text-base leading-[1.45] font-semibold sm:line-clamp-2 sm:whitespace-normal sm:text-lg sm:break-words">
          {title}
        </h1>
        {hasActions && (
          <div className="col-start-3 row-start-1 flex items-center justify-self-end">
            {actions}
          </div>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              ref={trigger}
              className={`row-start-1 size-11 shrink-0 p-0 ${hasActions ? "col-start-4" : "col-start-3"}`}
              aria-label="练习更多"
              title="练习更多"
            >
              <MoreHorizontal aria-hidden className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-w-[calc(100vw-24px)]">
            {menuItems}
            <DropdownMenuItem onSelect={() => setMemoOpen(true)}>
              <NotebookPen aria-hidden className="size-4" />
              随手记
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDetailsOpen(true)}>
              <Info aria-hidden className="size-4" />
              练习信息
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <AttemptEditorNotice />
      <MemoQuickCaptureDialog open={memoOpen} onOpenChange={setMemoOpen} />
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent
          className="max-h-[70dvh] overflow-y-auto"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle className="break-words">{title}</DialogTitle>
            <DialogDescription>练习信息</DialogDescription>
          </DialogHeader>
          <div>{children}</div>
        </DialogContent>
      </Dialog>
    </header>
  );
}
