import { Loader2, Share2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  usePublishLectureToShared,
  usePublishUnitToShared,
} from "@/features/shared/shared-queries";

/**
 * 「发布到共享」按钮 + 确认弹层（T2B.7，D16）：单元/讲义详情（抽屉）底部共用。
 * 确认弹层说明**快照语义**——发布的是当前内容的快照副本，之后源内容的修改
 * 不影响已发布文件；成功后展示实际写入的文件名（含重名序号）。
 * 发布本身不依赖本弹层以外的状态：调 publish 接口（服务端逐字复用导出实现）。
 */
export function PublishConfirmDialog({
  kind,
  id,
  title,
}: {
  kind: "unit" | "lecture";
  id: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishedFilename, setPublishedFilename] = useState<string | null>(
    null,
  );
  const unitMutation = usePublishUnitToShared();
  const lectureMutation = usePublishLectureToShared();
  const mutation = kind === "unit" ? unitMutation : lectureMutation;

  const kindLabel = kind === "unit" ? "单元" : "讲义";
  const kindNote =
    kind === "unit"
      ? "将导出该单元当前未删除的全部题目（与「导出 Markdown」同一格式）。"
      : "将导出讲义全文（含标题行，与「导出 Markdown」同一格式）。";

  function handleConfirm(): void {
    setError(null);
    mutation.mutate(id, {
      onSuccess: (data) => setPublishedFilename(data.filename),
      onError: (err) =>
        setError(err instanceof Error ? err.message : "发布失败，请稍后重试"),
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 px-4"
        onClick={() => {
          setPublishedFilename(null);
          setError(null);
          setOpen(true);
        }}
      >
        <Share2 aria-hidden />
        发布到共享
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          {publishedFilename === null ? (
            <>
              <DialogHeader>
                <DialogTitle>发布{kindLabel}到共享目录？</DialogTitle>
                <DialogDescription>
                  {kindNote}共享目录内的文件可供其他老师浏览、导入到他们自己的
                  资源库。
                </DialogDescription>
              </DialogHeader>
              <p className="rounded-lg bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground">
                发布的是「{title}」当前内容的
                <strong className="text-foreground">快照副本</strong>
                ——发布后继续修改源{kindLabel}，已发布文件不受影响。
              </p>
              {error !== null ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 px-4"
                  onClick={() => setOpen(false)}
                  disabled={mutation.isPending}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  className="min-h-11 px-5"
                  disabled={mutation.isPending}
                  onClick={handleConfirm}
                >
                  {mutation.isPending ? (
                    <>
                      <Loader2 aria-hidden className="animate-spin" />
                      发布中…
                    </>
                  ) : (
                    "确认发布"
                  )}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>已发布到共享目录</DialogTitle>
                <DialogDescription>
                  文件名：{publishedFilename}
                  。其他老师可在「共享」页看到并导入。
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  className="min-h-11 px-5"
                  onClick={() => setOpen(false)}
                  autoFocus
                >
                  完成
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
