import { cn } from "cn";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { type RefObject, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogTitle } from "@/components/ui/dialog";
import { InkReplayPane } from "./InkReplayPane";

/** 快照 / 回放 双视图的取值（题卡与放大层共用） */
export type InkViewTab = "snapshot" | "replay";

/**
 * 手写笔迹放大层（T3.1，D7；T3.3 扩展双视图）：详情页缩略图点击后全屏查看。
 * 共用模态焦点管理，保留 Esc / 点击背景 / 「关闭」按钮三种退出方式。
 * 触控目标 ≥44px。传入 inkId 时提供「快照 / 回放」切换（T3.3），回放态三态
 * 交给 InkReplayPane（加载 / 重演 / PNG 降级）；不传（如待批队列）仅快照，
 * 行为与 T3.2b 一致。
 */
export function InkLightbox({
  pngUrl,
  alt,
  onClose,
  triggerRef,
  inkId,
  hasStrokes = true,
  initialTab = "snapshot",
}: {
  /** 笔迹 PNG 地址（契约下发的相对路径 /api/teacher/ink/{inkId}.png） */
  pngUrl: string;
  /** 图片替代文本（含题号） */
  alt: string;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** 笔迹定位 id：提供时显示「快照 / 回放」切换（矢量接口的定位） */
  inkId?: string;
  /** 契约 ink.hasStrokes：false 时回放态不发矢量请求直接降级（透传 InkReplayPane） */
  hasStrokes?: boolean;
  /** 打开时的初始视图（题卡当前处于回放态时从回放打开） */
  initialTab?: InkViewTab;
}) {
  const [tab, setTab] = useState<InkViewTab>(initialTab);
  const closeRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="ink-lightbox-overlay"
          className="fixed inset-0 z-50 bg-black/80"
        />
        {/* 仅工具栏和笔迹接收指针，空白处命中遮罩并走 Radix 的外点关闭。 */}
        <DialogPrimitive.Content
          data-slot="ink-lightbox"
          aria-describedby={undefined}
          className="pointer-events-none! fixed top-0 left-0 z-50 flex h-dvh w-dvw flex-col p-4"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            closeRef.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus({ preventScroll: true });
          }}
        >
          <DialogTitle className="sr-only">手写笔迹放大查看</DialogTitle>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 [&>*]:pointer-events-auto">
            {inkId === undefined ? (
              <span />
            ) : (
              <InkViewTabs value={tab} onChange={setTab} />
            )}
            <DialogClose asChild>
              <Button
                ref={closeRef}
                type="button"
                variant="outline"
                className="ml-auto min-h-11 shrink-0 bg-card"
              >
                <X aria-hidden className="size-4" />
                关闭
              </Button>
            </DialogClose>
          </div>
          <div className="flex min-h-0 w-full flex-1 items-center justify-center [&>*]:pointer-events-auto">
            {tab === "replay" && inkId !== undefined ? (
              <InkReplayPane
                inkId={inkId}
                pngUrl={pngUrl}
                alt={alt}
                layout="fill"
                hasStrokes={hasStrokes}
              />
            ) : (
              <img
                src={pngUrl}
                alt={alt}
                className="max-h-full max-w-full rounded-lg bg-white object-contain"
              />
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </Dialog>
  );
}

/** 快照 / 回放 切换控件（题卡与放大层共用；分页签样式，≥44px 触控目标） */
export function InkViewTabs({
  value,
  onChange,
}: {
  value: InkViewTab;
  onChange: (tab: InkViewTab) => void;
}) {
  return (
    <div className="inline-flex shrink-0 overflow-hidden rounded-lg border border-border bg-card">
      <InkViewTabButton
        active={value === "snapshot"}
        onClick={() => onChange("snapshot")}
      >
        快照
      </InkViewTabButton>
      <InkViewTabButton
        active={value === "replay"}
        onClick={() => onChange("replay")}
      >
        回放
      </InkViewTabButton>
    </div>
  );
}

/** 单个页签按钮（active 态与 aria-pressed 同步） */
function InkViewTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "min-h-11 px-4 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
        active
          ? "bg-secondary text-secondary-foreground"
          : "bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
