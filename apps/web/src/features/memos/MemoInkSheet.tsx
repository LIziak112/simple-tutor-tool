import type { InkDoc } from "@tutor/contract";
import { Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { InkEngine } from "@/features/ink/engine";
import { PaperEditor } from "@/features/ink/PaperEditor";
import { renderInkSnapshot } from "@/features/ink/render-ink-snapshot";

/**
 * 手写随笔（模块 5 第一步）：抽屉里一张纸（复用 PaperEditor 笔迹能力——Pencil /
 * 手指、撤销、橡皮、颜色粗细同作答纸），「完成」把笔迹渲染成 PNG 交给调用方入队。
 * 随笔只存快照 PNG（原始随笔不可变、不需要再编辑），矢量不上传。
 */
export default function MemoInkSheet({
  open,
  onOpenChange,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (png: Blob) => void;
}) {
  const engineRef = useRef<InkEngine | null>(null);
  const [doc, setDoc] = useState<InkDoc | null>(null);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasStrokes =
    doc !== null &&
    (doc.engine === "atrament"
      ? doc.data.strokes.length > 0
      : doc.data.scene.elements.length > 0);

  async function finish(): Promise<void> {
    const current = engineRef.current?.getData() ?? doc;
    if (current === null) return;
    setRendering(true);
    setError(null);
    try {
      onComplete(await renderInkSnapshot(current));
    } catch (err) {
      setError(err instanceof Error ? err.message : "手写内容渲染失败，请重试");
    } finally {
      setRendering(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent closeLabel="关闭手写随笔" className="gap-3 p-4">
        <SheetHeader className="pr-12">
          <SheetTitle>手写随笔</SheetTitle>
          <SheetDescription>
            写完点「完成」，保存为一张图片；原稿不可再改，想补充就再记一条。
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PaperEditor
            label="手写随笔纸面"
            engineRef={engineRef}
            onDocChange={(next) => setDoc(next)}
            inputEnabled
            allowFingerWriting
            background="white"
            clearLabel="清空纸面"
            onClearRequest={() => {
              engineRef.current?.clear();
              setDoc(null);
            }}
            initialHeight={480}
          />
        </div>
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={!hasStrokes || rendering}
            onClick={() => void finish()}
          >
            {rendering && (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            )}
            完成
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
