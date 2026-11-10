import { NotebookPen } from "lucide-react";
import { useState } from "react";
import { useLocation } from "react-router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MemoComposer } from "./MemoComposer";
import { useMemoOutbox } from "./memo-outbox";

/**
 * 浮动「随手记」（模块 5 第一步）：学生端任意页面右下角一枚按钮，点开是记录端
 * 浮层——在题里、讲义里随手记，锚自动带上。随笔页本身有常驻记录端，不再叠加。
 * 角标 = 本机待补传条数（离线时让人知道「记下了、还没传」）。
 */
export function MemoQuickCapture() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const pending = useMemoOutbox().length;
  if (location.pathname.startsWith("/s/memos")) return null;
  return (
    <>
      <button
        type="button"
        aria-label={pending > 0 ? `随手记（${pending} 条待补传）` : "随手记"}
        title="随手记"
        onClick={() => setOpen(true)}
        className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-40 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg outline-none transition-transform hover:scale-105 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <NotebookPen aria-hidden className="size-5" />
        {pending > 0 && (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-destructive text-[10px] font-semibold text-white"
          >
            {pending > 9 ? "9+" : pending}
          </span>
        )}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>随手记</DialogTitle>
            <DialogDescription>
              记下来就行，整理交给之后的 Agent；离线也能记。
            </DialogDescription>
          </DialogHeader>
          <MemoComposer autoFocus onQueued={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
