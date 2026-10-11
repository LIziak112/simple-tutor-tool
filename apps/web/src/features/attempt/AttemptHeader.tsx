import { ArrowLeft, MoreHorizontal } from "lucide-react";
import { type ReactNode, useState } from "react";
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
  status: ReactNode;
  onBack: () => void;
  children: ReactNode;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <header
      data-slot="attempt-header"
      className="sticky top-0 z-20 -mx-3 flex min-h-16 flex-col gap-1.5 border-b border-border bg-background/95 px-3 py-2 backdrop-blur sm:-mx-6 sm:px-6"
    >
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          className="size-11 shrink-0 p-0"
          aria-label="返回"
          title="返回"
          onClick={onBack}
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Button>
        <h1 className="line-clamp-2 min-w-0 flex-1 text-lg leading-[26px] font-semibold break-words">
          {title}
        </h1>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="size-11 shrink-0 p-0"
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
      <div className="pl-13">{status}</div>
      {children}
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-h-[70dvh] overflow-y-auto">
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
