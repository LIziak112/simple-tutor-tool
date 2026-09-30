import type { SharedFileSummary } from "@tutor/contract";
import { CircleAlert, Eye, FolderInput, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { useSharedPreview } from "@/features/shared/shared-queries";

/**
 * 共享文件「查看预览」抽屉：RichMarkdown 只读渲染共享文件原文（公式/指令与
 * 讲义阅读同一渲染管线；共享文件是他人快照，不提供编辑）。响应里的动作清单
 * 属导入流程，这里不展示——「导入到我的资源库」切换到导入抽屉再算。
 * 文件存在 error 级 lint 时仅提示（导入会被拒绝），不影响查看；三态齐全（§4.6）。
 */
export function SharedPreviewSheet({
  file,
  onClose,
  onImport,
}: {
  file: SharedFileSummary;
  onClose: () => void;
  /** 切换到「导入到我的资源库」抽屉（SharedPage 关闭本抽屉后打开） */
  onImport: () => void;
}) {
  // folderId 固定 null：预览只看内容，动作清单不算（导入抽屉里才按目标文件夹算）
  const previewQuery = useSharedPreview(file.filename, null);
  const preview = previewQuery.data ?? null;
  const errorIssues =
    preview?.issues.filter((issue) => issue.level === "error") ?? [];
  const loadError =
    previewQuery.isError && previewQuery.error instanceof Error
      ? previewQuery.error.message
      : null;

  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Eye aria-hidden className="size-4 text-muted-foreground" />
            {file.title}
          </SheetTitle>
          <SheetDescription className="font-mono text-xs break-all">
            {file.filename}（只读）
          </SheetDescription>
        </SheetHeader>

        {previewQuery.isPending ? (
          <div
            aria-live="polite"
            className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground"
          >
            <Loader2 aria-hidden className="size-6 animate-spin" />
            <p className="text-sm">正在加载内容…</p>
          </div>
        ) : loadError !== null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
            <p className="px-6 text-center text-sm">{loadError}</p>
            <Button
              variant="outline"
              className="min-h-11 px-6"
              onClick={() => void previewQuery.refetch()}
            >
              重试
            </Button>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {errorIssues.length > 0 ? (
                <p
                  role="alert"
                  className="mb-3 flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-300"
                >
                  <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                  文件存在 {errorIssues.length} 个错误级问题，可以查看，
                  但「导入到我的资源库」会被拒绝（可联系发布者修复后重新发布）。
                </p>
              ) : null}
              <div className="mx-auto max-w-3xl">
                <RichMarkdown source={preview?.markdown ?? ""} />
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-3">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 px-4"
                onClick={onClose}
              >
                关闭
              </Button>
              <Button
                type="button"
                className="min-h-11 px-6"
                onClick={onImport}
              >
                <FolderInput aria-hidden />
                导入到我的资源库
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
