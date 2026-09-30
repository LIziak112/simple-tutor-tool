import { cn } from "cn";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { InkReplayPane } from "./InkReplayPane";

/** 快照 / 回放 双视图的取值（题卡与放大层共用） */
export type InkViewTab = "snapshot" | "replay";

/**
 * 手写笔迹放大层（T3.1，D7；T3.3 扩展双视图）：详情页缩略图点击后全屏查看。
 * 自实现覆盖层（无新增依赖）：Esc / 点击背景 / 「关闭」按钮三种退出方式；
 * 触控目标 ≥44px。传入 inkId 时提供「快照 / 回放」切换（T3.3），回放态三态
 * 交给 InkReplayPane（加载 / 重演 / PNG 降级）；不传（如待批队列）仅快照，
 * 行为与 T3.2b 一致。
 */
export function InkLightbox({
  pngUrl,
  alt,
  onClose,
  inkId,
  initialTab = "snapshot",
}: {
  /** 笔迹 PNG 地址（契约下发的相对路径 /api/teacher/ink/{inkId}.png） */
  pngUrl: string;
  /** 图片替代文本（含题号） */
  alt: string;
  onClose: () => void;
  /** 笔迹定位 id：提供时显示「快照 / 回放」切换（矢量接口的定位） */
  inkId?: string;
  /** 打开时的初始视图（题卡当前处于回放态时从回放打开） */
  initialTab?: InkViewTab;
}) {
  const [tab, setTab] = useState<InkViewTab>(initialTab);

  // Esc 关闭（对话框内键盘可达）
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      data-slot="ink-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="手写笔迹放大查看"
      className="fixed inset-0 z-50 flex flex-col bg-black/80 p-4"
    >
      <div className="relative z-10 flex shrink-0 items-center justify-between gap-2">
        {/* 快照 / 回放 切换（≥44px 触控目标）；无 inkId（无回放数据源）不渲染 */}
        {inkId === undefined ? (
          <span className="min-w-0" />
        ) : (
          <InkViewTabs value={tab} onChange={setTab} />
        )}
        <Button
          type="button"
          variant="outline"
          className="min-h-11 shrink-0 bg-card"
          onClick={onClose}
        >
          <X aria-hidden className="size-4" />
          关闭
        </Button>
      </div>
      {/* 背景即「关闭」按钮（铺满整层的透明按钮，位于内容之下）：
          点击图片以外的任意处关闭，且是真实交互元素（无静态 div 挂 onClick） */}
      <button
        type="button"
        aria-label="点击背景关闭放大查看"
        className="absolute inset-0 cursor-default bg-transparent outline-none"
        onClick={onClose}
      />
      <div className="relative z-10 flex min-h-0 w-full flex-1 items-center justify-center">
        {tab === "replay" && inkId !== undefined ? (
          <InkReplayPane
            inkId={inkId}
            pngUrl={pngUrl}
            alt={alt}
            layout="fill"
          />
        ) : (
          <img
            src={pngUrl}
            alt={alt}
            className="max-h-full max-w-full rounded-lg bg-white object-contain"
          />
        )}
      </div>
    </div>
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
