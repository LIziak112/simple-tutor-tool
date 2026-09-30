import { X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * 手写笔迹放大层（T3.1，D7）：详情页缩略图点击后全屏查看 PNG 快照。
 * 自实现覆盖层（无新增依赖）：Esc / 点击背景 / 「关闭」按钮三种退出方式；
 * 触控目标 ≥44px。笔迹回放切换在 T3.3 接入（本层届时扩展为快照/回放双页签）。
 */
export function InkLightbox({
  pngUrl,
  alt,
  onClose,
}: {
  /** 笔迹 PNG 地址（契约下发的相对路径 /api/teacher/ink/{inkId}.png） */
  pngUrl: string;
  /** 图片替代文本（含题号） */
  alt: string;
  onClose: () => void;
}) {
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
      <div className="relative z-10 flex shrink-0 justify-end">
        <Button
          type="button"
          variant="outline"
          className="min-h-11 bg-card"
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
      <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center">
        <img
          src={pngUrl}
          alt={alt}
          className="max-h-full max-w-full rounded-lg bg-white object-contain"
        />
      </div>
    </div>
  );
}
