import {
  ClipboardCopy,
  Download,
  LoaderCircle,
  RefreshCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { saveBlobAs } from "@/lib/api";
import { copyPngBlobToClipboard } from "@/lib/copy";

export function AnnotationExportDialog({
  open,
  onOpenChange,
  createImage,
  filename,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  createImage(): Promise<Blob>;
  filename: string;
}) {
  const createRef = useRef(createImage);
  createRef.current = createImage;
  const [result, setResult] = useState<{ blob: Blob; url: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [originalSize, setOriginalSize] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies(retry): 显式重试重新生成并释放旧预览URL
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    generation.current += 1;
    let url: string | null = null;
    setResult(null);
    setError(null);
    setCopyStatus(null);
    setCopying(false);
    setOriginalSize(false);
    void createRef
      .current()
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setResult({ blob, url });
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(
            cause instanceof Error ? cause.message : "图片生成失败，请重试",
          );
      });
    return () => {
      cancelled = true;
      generation.current += 1;
      if (url) URL.revokeObjectURL(url);
    };
  }, [open, retry]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100%-24px)] max-w-3xl flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 pr-10">
            <DialogTitle>导出标画</DialogTitle>
            <Button
              variant="outline"
              className="size-11 shrink-0 p-0"
              disabled={!result}
              aria-pressed={originalSize}
              aria-label={originalSize ? "适应宽度预览" : "按原尺寸预览"}
              title={originalSize ? "适应宽度预览" : "按原尺寸预览"}
              onClick={() => setOriginalSize((value) => !value)}
            >
              {originalSize ? <ZoomOut aria-hidden /> : <ZoomIn aria-hidden />}
            </Button>
          </div>
          <DialogDescription className="break-all">
            {filename}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <div>
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
              <Button
                variant="outline"
                className="mt-3 h-11"
                onClick={() => setRetry((value) => value + 1)}
              >
                <RefreshCw aria-hidden />
                重试生成
              </Button>
            </div>
          ) : result ? (
            <img
              src={result.url}
              alt="标画导出预览"
              className={originalSize ? "h-auto max-w-none" : "h-auto w-full"}
              onError={() => setError("预览加载失败，请重试生成")}
            />
          ) : (
            <p
              role="status"
              className="flex min-h-24 items-center justify-center gap-2 text-sm text-muted-foreground"
            >
              <LoaderCircle aria-hidden className="size-4 animate-spin" />
              正在生成图片…
            </p>
          )}
        </div>
        {copyStatus && (
          <p role="status" className="text-sm text-muted-foreground">
            {copyStatus}
          </p>
        )}
        <DialogFooter className="flex-wrap">
          <Button
            className="h-11"
            disabled={!result}
            onClick={() => {
              if (result) saveBlobAs(result.blob, filename);
            }}
          >
            <Download aria-hidden />
            下载图片
          </Button>
          <Button
            variant="outline"
            className="h-11"
            disabled={!result || copying}
            onClick={async () => {
              if (!result) return;
              const expected = generation.current;
              setCopying(true);
              const copied = await copyPngBlobToClipboard(result.blob);
              if (expected !== generation.current) return;
              setCopyStatus(copied ? "已复制图片" : "复制失败，请下载图片");
              setCopying(false);
            }}
          >
            <ClipboardCopy aria-hidden />
            复制图片
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
