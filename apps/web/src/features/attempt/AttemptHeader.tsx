import { ArrowLeft, MoreHorizontal } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
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
import { AttemptEditorNotice } from "./AttemptEditorContext";

export function AttemptHeader({
  title,
  status,
  onBack,
  actions,
  menuItems,
  children,
}: {
  title: string;
  status: (closeDetails: () => void) => ReactNode;
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
  const navigating = useRef(false);
  const closeDetails = () => {
    navigating.current = detailsOpen;
    setDetailsOpen(false);
  };
  const hasActions = actions != null;
  return (
    <header
      data-slot="attempt-header"
      className={`sticky top-0 z-20 -mx-3 grid min-h-16 items-center gap-x-2 gap-y-1 border-b border-border bg-background/95 px-3 py-2 backdrop-blur sm:-mx-6 sm:px-6 ${hasActions ? "grid-cols-[44px_minmax(0,1fr)_44px_44px] sm:grid-cols-[44px_minmax(0,1fr)_44px_auto_44px]" : "grid-cols-[44px_minmax(0,1fr)_44px] sm:grid-cols-[44px_minmax(0,1fr)_auto_44px]"}`}
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
        <h1 className="col-start-2 row-start-1 line-clamp-2 min-w-0 text-lg leading-[1.45] font-semibold break-words">
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
              className={`row-start-1 size-11 shrink-0 p-0 ${hasActions ? "col-start-4 sm:col-start-5" : "col-start-3 sm:col-start-4"}`}
              aria-label="练习更多"
              title="练习信息"
            >
              <MoreHorizontal aria-hidden className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-w-[calc(100vw-24px)]">
            {menuItems}
            <DropdownMenuItem onSelect={() => setDetailsOpen(true)}>
              练习信息
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="contents">
        <div
          className={`hidden min-w-0 sm:col-start-2 sm:row-start-2 sm:block ${hasActions ? "sm:col-span-4" : "sm:col-span-3"}`}
        >
          {children}
        </div>
        <div
          className={`hidden min-w-0 sm:row-start-1 sm:block sm:max-w-sm ${hasActions ? "sm:col-start-4" : "sm:col-start-3"}`}
        >
          {status(closeDetails)}
        </div>
      </div>
      <AttemptEditorNotice />
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent
          className="max-h-[70dvh] overflow-y-auto"
          onCloseAutoFocus={(event) => {
            if (navigating.current) {
              event.preventDefault();
              navigating.current = false;
            }
          }}
        >
          <DialogHeader>
            <DialogTitle className="break-words">{title}</DialogTitle>
            <DialogDescription>练习信息</DialogDescription>
          </DialogHeader>
          <div>{children}</div>
          {status(closeDetails)}
        </DialogContent>
      </Dialog>
    </header>
  );
}
