import { NotebookPen } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  captureLearningSource,
  type LearningSource,
} from "@/features/learning-context/learning-context-store";
import { LearningPrincipalContext } from "@/features/learning-context/learning-principal";
import { MemoComposer } from "./MemoComposer";
import { useMemoOutbox } from "./memo-outbox";

/**
 * 「随手记」入口（模块 5 第一步）三种形态，共用一个浮层：
 * - 浮动按钮：学生端普通页面右下角（首页 / 课程 / 错题……），由布局渲染；
 *   作答 / 结果 / 讲练 / 讲义阅读这些「工作区」页面自带吸底操作条，浮动按钮会
 *   压住「下一题」「交卷」，所以工作区不浮——入口改放进各自的工具栏；
 * - 工具栏图标按钮：工作区页面顶栏用；
 * - 浮层本体：也可由「练习更多」菜单项打开。
 * 角标 = 本机待补传条数（离线时让人知道「记下了、还没传」）。
 */
export function MemoQuickCaptureDialog({
  open,
  onOpenChange,
  source,
  onReturnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source?: LearningSource | undefined;
  onReturnFocus?: () => void;
}) {
  const principal = useContext(LearningPrincipalContext);
  const snapshot = useRef<LearningSource | undefined>(undefined);
  const wasOpen = useRef(false);
  const opening = useRef(0);
  if (open && !wasOpen.current) {
    opening.current++;
    const current = captureLearningSource(principal);
    const selected = source ?? current;
    snapshot.current = structuredClone({
      ...selected,
      principal: selected.principal ?? current.principal ?? null,
    });
  }
  wasOpen.current = open;
  const currentOpening = opening.current;
  const sourcePrincipal = snapshot.current?.principal;
  useEffect(() => {
    if (open && principal !== undefined && sourcePrincipal !== principal)
      onOpenChange(false);
  }, [open, principal, sourcePrincipal, onOpenChange]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (event.target instanceof HTMLElement)
            event.target
              .querySelector<HTMLTextAreaElement>("textarea")
              ?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (onReturnFocus) {
            event.preventDefault();
            onReturnFocus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>随手记</DialogTitle>
          <DialogDescription>
            记下来就行，整理交给之后的 Agent；离线也能记。
          </DialogDescription>
        </DialogHeader>
        <MemoComposer
          key={currentOpening}
          source={snapshot.current}
          autoFocus
          onQueued={() => {
            // 旧记录的迟到本机/网络回执不能关闭新打开的记录。
            if (opening.current === currentOpening) onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function PendingBadge({ pending }: { pending: number }) {
  if (pending === 0) return null;
  return (
    <span
      aria-hidden
      className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-destructive text-[10px] font-semibold text-white"
    >
      {pending > 9 ? "9+" : pending}
    </span>
  );
}

function captureLabel(pending: number): string {
  return pending > 0 ? `随手记（${pending} 条待补传）` : "随手记";
}

/** 工作区顶栏用的图标按钮（44px 触控面），自带浮层。 */
export function MemoQuickCaptureButton({
  unanchored = false,
}: {
  unanchored?: boolean;
} = {}) {
  const [open, setOpen] = useState(false);
  const pending = useMemoOutbox().length;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        aria-label={captureLabel(pending)}
        title="随手记"
        onClick={() => setOpen(true)}
        className="relative size-11 shrink-0 p-0"
      >
        <NotebookPen aria-hidden className="size-5" />
        <PendingBadge pending={pending} />
      </Button>
      <MemoQuickCaptureDialog
        source={unanchored ? { anchor: { kind: "none" } } : undefined}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

/** 普通页面右下角的浮动按钮；随笔页本身有常驻记录端，不再叠加。 */
export function MemoQuickCapture() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const pending = useMemoOutbox().length;
  if (location.pathname.startsWith("/s/memos")) return null;
  return (
    <>
      <button
        type="button"
        aria-label={captureLabel(pending)}
        title="随手记"
        onClick={() => setOpen(true)}
        className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-40 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg outline-none transition-transform hover:scale-105 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <NotebookPen aria-hidden className="size-5" />
        <PendingBadge pending={pending} />
      </button>
      <MemoQuickCaptureDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
