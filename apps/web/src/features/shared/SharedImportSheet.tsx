import type { SharedFileSummary } from "@tutor/contract";
import { CircleAlert, Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ActionsPanel } from "@/features/content/ActionsPanel";
import {
  useImportSharedFile,
  useSharedPreview,
} from "@/features/shared/shared-queries";
import { ApiError } from "@/lib/api";
import { StatsBar } from "@/pages/teacher/SingleImportPreview";

/**
 * 共享文件「导入到我的资源库」预览抽屉（T2B.7，D17）：复用单文件预览组件
 * （StatsBar 统计条 + ActionsPanel 动作清单/注意事项），动作清单由服务端按
 * **本人域**计算（D13）；目标文件夹可选（切换即重算）。
 * 与导入页预览的差别：原文只读（共享文件是别人的快照，不提供在线编辑），
 * 有 error 级 lint 时「确认导入」禁用（提交也会被 422 LINT_ERROR 拒绝）。
 */
export function SharedImportSheet({
  file,
  folders,
  onClose,
}: {
  file: SharedFileSummary;
  /** 本人的文件夹选项（导入目标）；「未归类」为固定项 */
  folders: { id: string; name: string }[];
  onClose: () => void;
}) {
  const [folderId, setFolderId] = useState<string>("none");
  const [importError, setImportError] = useState<string | null>(null);
  const [importedReport, setImportedReport] = useState<string | null>(null);

  const previewQuery = useSharedPreview(
    file.filename,
    folderId === "none" ? null : folderId,
  );
  const importMutation = useImportSharedFile();

  const preview = previewQuery.data ?? null;
  const issues = preview?.issues ?? [];
  const hasError = issues.some((issue) => issue.level === "error");
  const previewError =
    previewQuery.isError && previewQuery.error instanceof Error
      ? previewQuery.error.message
      : null;

  function handleImport(): void {
    setImportError(null);
    importMutation.mutate(
      {
        filename: file.filename,
        ...(folderId !== "none" ? { folderId } : {}),
      },
      {
        onSuccess: (report) => {
          const unitsPart = `单元 ${report.units.length} 个（新增 ${report.units.filter((u) => u.inserted).length} / 更新 ${report.units.filter((u) => u.updated).length}）`;
          const lecturesPart = `讲义 ${report.lectures.length} 篇`;
          setImportedReport(
            `导入完成：${unitsPart}，${lecturesPart}，题目新增 ${report.questions.inserted} / 更新 ${report.questions.updated}。`,
          );
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === "LINT_ERROR") {
            setImportError(
              `文件存在错误级问题，无法导入（${err.message}）。可联系发布者修复后重新发布。`,
            );
            return;
          }
          setImportError(
            err instanceof Error ? err.message : "导入失败，请稍后重试",
          );
        },
      },
    );
  }

  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Download aria-hidden className="size-4 text-muted-foreground" />
            导入共享文件
          </SheetTitle>
          <SheetDescription className="font-mono text-xs break-all">
            {file.filename}
          </SheetDescription>
        </SheetHeader>

        {importedReport !== null ? (
          <div className="flex flex-1 flex-col items-start justify-center gap-4 p-6">
            <p
              role="status"
              className="text-sm text-emerald-600 dark:text-emerald-400"
            >
              {importedReport}
            </p>
            <p className="text-sm text-muted-foreground">
              已导入到你的资源库，与发布者不再有任何关联。
            </p>
            <Button
              type="button"
              className="min-h-11 px-5"
              onClick={onClose}
              autoFocus
            >
              完成
            </Button>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="shared-import-folder"
                  className="text-sm font-medium"
                >
                  导入到文件夹
                </label>
                <select
                  id="shared-import-folder"
                  value={folderId}
                  onChange={(e) => setFolderId(e.target.value)}
                  className="min-h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <option value="none">未归类</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
              </div>

              <StatsBar
                preview={preview}
                pending={previewQuery.isPending}
                error={previewError}
                onRetry={() => void previewQuery.refetch()}
              />

              {preview !== null ? <ActionsPanel preview={preview} /> : null}

              {hasError ? (
                <div
                  role="alert"
                  className="space-y-1 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
                >
                  <p className="flex items-center gap-1.5 font-medium">
                    <CircleAlert aria-hidden className="size-4 shrink-0" />
                    文件存在 {issues.filter((i) => i.level === "error").length}{" "}
                    个错误级问题，无法导入
                  </p>
                  {issues
                    .filter((i) => i.level === "error")
                    .slice(0, 3)
                    .map((issue) => (
                      <p
                        key={`${issue.line}-${issue.message}`}
                        className="pl-5.5 text-xs"
                      >
                        第 {issue.line} 行：{issue.message}
                      </p>
                    ))}
                </div>
              ) : null}

              {importError !== null ? (
                <p role="alert" className="text-sm text-destructive">
                  {importError}
                </p>
              ) : null}
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-3">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 px-4"
                onClick={onClose}
                disabled={importMutation.isPending}
              >
                关闭
              </Button>
              <Button
                type="button"
                className="min-h-11 px-6"
                disabled={
                  hasError ||
                  preview === null ||
                  previewQuery.isPending ||
                  previewError !== null ||
                  importMutation.isPending
                }
                onClick={handleImport}
              >
                {importMutation.isPending ? (
                  <>
                    <Loader2 aria-hidden className="animate-spin" />
                    正在导入…
                  </>
                ) : (
                  "确认导入"
                )}
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
