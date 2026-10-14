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
import type { OngoingExportPage } from "@/features/export/ongoing-question-export";
import { saveBlobAs } from "@/lib/api";
import { copyPngBlobToClipboard } from "@/lib/copy";

export function AnnotationExportDialog({
  open,
  onOpenChange,
  createImage,
  filename,
  title = "导出标画",
  previewLabel = "标画导出预览",
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  createImage(): Promise<Blob | OngoingExportPage[]>;
  filename: string;
  title?: string;
  previewLabel?: string;
}) {
  const createRef = useRef(createImage);
  createRef.current = createImage;
  const [pages, setPages] = useState<Array<
    OngoingExportPage & { url: string }
  > | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const result = pages?.[pageIndex] ?? null;
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
    const urls: string[] = [];
    setPages(null);
    setPageIndex(0);
    setError(null);
    setCopyStatus(null);
    setCopying(false);
    setOriginalSize(false);
    void createRef
      .current()
      .then((output) => {
        if (cancelled) return;
        const images = Array.isArray(output)
          ? output
          : [{ blob: output, label: "" }];
        if (images.length === 0) throw new Error("未生成图片，请重试");
        setPages(
          images.map((page) => {
            const url = URL.createObjectURL(page.blob);
            urls.push(url);
            return { ...page, url };
          }),
        );
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
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [open, retry]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100%-24px)] max-w-3xl flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 pr-10">
            <DialogTitle>{title}</DialogTitle>
            <Button
              variant="outline"
              className="size-11 shrink-0 p-0"
              disabled={!result || error !== null}
              aria-pressed={originalSize}
              aria-label={originalSize ? "适应宽度预览" : "按原尺寸预览"}
              title={originalSize ? "适应宽度预览" : "按原尺寸预览"}
              onClick={() => setOriginalSize((value) => !value)}
            >
              {originalSize ? <ZoomOut aria-hidden /> : <ZoomIn aria-hidden />}
            </Button>
          </div>
          <DialogDescription className="break-all">
            {result?.label || filename}
          </DialogDescription>
        </DialogHeader>
        {pages && pages.length > 1 && (
          <div className="flex items-center justify-center gap-3">
            <Button
              variant="outline"
              className="h-11"
              disabled={pageIndex === 0 || copying}
              onClick={() => {
                setPageIndex((value) => value - 1);
                setCopyStatus(null);
              }}
            >
              上一页
            </Button>
            <span className="text-sm tabular-nums">
              第 {pageIndex + 1} / {pages.length} 页
            </span>
            <Button
              variant="outline"
              className="h-11"
              disabled={pageIndex === pages.length - 1 || copying}
              onClick={() => {
                setPageIndex((value) => value + 1);
                setCopyStatus(null);
              }}
            >
              下一页
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
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
              alt={previewLabel}
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
        <p role="status" className="text-sm text-muted-foreground">
          {copyStatus}
        </p>
        <DialogFooter className="flex-wrap">
          <Button
            className="h-11"
            disabled={!result || error !== null}
            onClick={() => {
              if (pages)
                for (const [index, page] of pages.entries())
                  saveBlobAs(
                    page.blob,
                    pages.length === 1
                      ? filename
                      : filename.replace(/\.png$/i, `-${index + 1}.png`),
                  );
            }}
          >
            <Download aria-hidden />
            {pages && pages.length > 1 ? "下载全部图片" : "下载图片"}
          </Button>
          <Button
            variant="outline"
            className="h-11"
            disabled={!result || error !== null || copying}
            onClick={async () => {
              if (!result) return;
              const expected = generation.current;
              setCopying(true);
              const copied = await copyPngBlobToClipboard(result.blob);
              if (expected !== generation.current) return;
              setCopyStatus(
                copied
                  ? pages && pages.length > 1
                    ? `已复制第 ${pageIndex + 1} 页图片`
                    : "已复制图片"
                  : "复制失败，请下载图片",
              );
              setCopying(false);
            }}
          >
            <ClipboardCopy aria-hidden />
            {pages && pages.length > 1 ? "复制本页图片" : "复制图片"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
