import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { InkDoc, InkEngine } from "@/features/ink/engine/index.ts";
import { InkPad } from "@/features/ink/InkPad";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";

/**
 * 全屏作答层（T2.8，架构 §5.4「全屏作答（大题）」）：
 * - 顶部固定题干（可滚动，不占过高），下方 Excalidraw 画布占满余下空间；
 * - 题干固定 + 满屏书写适合长过程/画图题；退出后笔迹经 onDocChange 汇回
 *   该题的上传状态机（页内引擎与全屏引擎不混用，切换策略见 HandwrittenControls）；
 * - 退出按钮触控 ≥44px；iPad 竖屏/横屏都可用（flex 布局自适应）。
 */
export function InkFullscreenLayer({
  stemMd,
  initial,
  onDocChange,
  onClose,
  engineRef,
}: {
  /** 题干 Markdown（固定顶部；填空题的脱敏空框照常渲染） */
  stemMd: string;
  /** 全屏引擎的初始笔迹（仅当权威笔迹本身是 excalidraw 引擎时非空） */
  initial?: InkDoc | undefined;
  /** 笔迹变化（全屏内每笔结束触发，与页内同一回调语义） */
  onDocChange: (doc: InkDoc) => void;
  /** 关闭全屏（「完成」按钮；Esc 由 Dialog/浏览器处理或再次点击按钮） */
  onClose: () => void;
  /** 引擎实例透出（上传状态机导出 PNG 用） */
  engineRef?: React.RefObject<InkEngine | null>;
}) {
  return (
    <div
      data-slot="ink-fullscreen"
      role="dialog"
      aria-modal="true"
      aria-label="全屏作答"
      className="fixed inset-0 z-50 flex flex-col bg-background"
    >
      {/* 顶部：题干（限高可滚动）+ 完成按钮 */}
      <header className="flex shrink-0 items-start gap-3 border-b border-border bg-card px-4 py-3">
        <div className="max-h-[28vh] min-h-11 flex-1 overflow-y-auto text-base">
          <RichMarkdown source={stemMd} />
        </div>
        <Button
          type="button"
          variant="default"
          className="h-11 shrink-0 px-5"
          onClick={onClose}
        >
          <X aria-hidden className="size-4" />
          完成
        </Button>
      </header>

      {/* 画布：占满余下空间（Excalidraw 懒加载，独立 chunk） */}
      <div className="min-h-0 flex-1 p-2">
        <InkPad
          engine="excalidraw"
          initial={initial}
          fill
          label="全屏手写作答区"
          onDocChange={onDocChange}
          engineRef={engineRef}
        />
      </div>
    </div>
  );
}
