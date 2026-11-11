import { Grid2X2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** 作答和结果回看共用题号弹层的尺寸、标题与焦点交接。 */
export function AttemptNavigationDialog({
  open,
  onOpenChange,
  onCloseFocus,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseFocus: () => void;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[560px] max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] max-w-[608px] flex-col gap-3 overflow-hidden rounded-[25px] p-4 shadow-md max-sm:inset-x-0 max-sm:top-auto max-sm:bottom-0 max-sm:w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:pb-[max(16px,env(safe-area-inset-bottom))] [&>[data-slot=dialog-close]]:bg-muted motion-safe:[&>[data-slot=dialog-close]]:transition-transform motion-safe:[&>[data-slot=dialog-close]]:duration-150 motion-safe:[&>[data-slot=dialog-close]]:active:scale-[0.96] [&>[data-slot=dialog-close]]:ease-out motion-reduce:[&>[data-slot=dialog-close]]:transition-opacity motion-reduce:[&>[data-slot=dialog-close]]:duration-150 motion-reduce:[&>[data-slot=dialog-close]]:active:opacity-75"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onCloseFocus();
        }}
      >
        <DialogHeader className="shrink-0 pe-12">
          <DialogTitle className="flex items-center gap-2">
            <Grid2X2 aria-hidden className="size-4" />
            答题卡
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
