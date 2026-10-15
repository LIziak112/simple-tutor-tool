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

export function AttemptHeader({
  title,
  status,
  onBack,
  children,
}: {
  title: string;
  status: (closeDetails: () => void) => ReactNode;
  onBack: () => void;
  children: ReactNode;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const navigating = useRef(false);
  const closeDetails = () => {
    navigating.current = detailsOpen;
    setDetailsOpen(false);
  };
  return (
    <header
      data-slot="attempt-header"
      className="sticky top-0 z-20 -mx-3 grid min-h-16 grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-x-2 gap-y-1 border-b border-border bg-background/95 px-3 py-2 backdrop-blur sm:-mx-6 sm:grid-cols-[44px_minmax(0,1fr)_auto_44px] sm:px-6"
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="col-start-3 row-start-1 size-11 shrink-0 p-0 sm:col-start-4"
              aria-label="练习更多"
              title="练习信息"
            >
              <MoreHorizontal aria-hidden className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-w-[calc(100vw-24px)]">
            <DropdownMenuItem onSelect={() => setDetailsOpen(true)}>
              练习信息
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="contents">
        <div className="hidden min-w-0 sm:col-span-3 sm:col-start-2 sm:row-start-2 sm:block">
          {children}
        </div>
        <div className="hidden min-w-0 sm:col-start-3 sm:row-start-1 sm:block sm:max-w-sm">
          {status(closeDetails)}
        </div>
      </div>
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
