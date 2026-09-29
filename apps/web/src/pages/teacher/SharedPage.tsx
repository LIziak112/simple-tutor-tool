import type { SharedFileSummary } from "@tutor/contract";
import {
  BookOpen,
  CircleAlert,
  FileText,
  FolderInput,
  Loader2,
  Search,
  Share2,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLibraryFolders } from "@/features/library/library-queries";
import { SharedImportSheet } from "@/features/shared/SharedImportSheet";
import {
  useDeleteSharedFile,
  useSharedFiles,
} from "@/features/shared/shared-queries";
import { ApiError } from "@/lib/api";
import { formatCnTime, formatRelativeTime } from "@/lib/time";

/**
 * /t/shared 共享页（T2B.7，D15–D18）：共享目录文件卡片（类型 + 来源标签 +
 * 发布者 + 相对时间 + 题数）、搜索（前端即时过滤）、「导入到我的资源库」预览
 * 抽屉（复用单文件预览组件）、删除按钮按权限显示（canDelete——发布者本人；
 * 本地文件仅管理员可删，在管理端操作）。三态齐全（§4.6）+ 空态引导。
 * 规模防线提示：目录文件过多（truncated）与超大文件未列出（oversizeHidden）。
 */

/** 类型标签文案 */
const KIND_LABELS: Record<SharedFileSummary["kind"], string> = {
  lecture: "讲义",
  practice: "练习",
};

export function SharedPage() {
  const listQuery = useSharedFiles();
  const foldersQuery = useLibraryFolders();
  const deleteMutation = useDeleteSharedFile();
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState<SharedFileSummary | null>(null);
  const [deleting, setDeleting] = useState<SharedFileSummary | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionHint, setActionHint] = useState<string | null>(null);

  const files = listQuery.data?.files ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return files;
    return files.filter(
      (file) =>
        file.title.toLowerCase().includes(q) ||
        file.filename.toLowerCase().includes(q) ||
        (file.publisher?.toLowerCase().includes(q) ?? false),
    );
  }, [files, query]);

  const folders = (foldersQuery.data?.folders ?? []).map((folder) => ({
    id: folder.id,
    name: folder.name,
  }));

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Share2 aria-hidden className="size-5 text-primary" />
            共享
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            老师们发布到这里的内容与服务器本地的文件；「导入到我的资源库」进入你自己的域。
          </p>
        </div>
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题 / 文件名 / 发布者"
            aria-label="搜索共享文件"
            className="min-h-11 w-64 pl-9"
          />
        </div>
      </header>

      {/* 操作反馈（成功 toast 化的轻量形态：一次性提示） */}
      {actionHint !== null ? (
        <p
          role="status"
          className="mt-3 rounded-lg bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-700 dark:text-emerald-300"
        >
          {actionHint}
        </p>
      ) : null}
      {actionError !== null ? (
        <p
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {actionError}
        </p>
      ) : null}

      {/* 规模防线提示（D15） */}
      {listQuery.data?.truncated ? (
        <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-300">
          目录文件过多，仅显示前 200
          个。建议清理共享目录（发布者删除自己发布的，本地文件联系管理员）。
        </p>
      ) : null}
      {listQuery.data !== undefined && listQuery.data.oversizeHidden > 0 ? (
        <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-300">
          有 {listQuery.data.oversizeHidden} 个超过 1MB
          的文件未列出（超出单文件上限）。
        </p>
      ) : null}

      {/* 三态：加载 / 错误 / 空态 / 列表 */}
      {listQuery.isPending ? (
        <div
          aria-live="polite"
          className="mt-10 flex flex-col items-center gap-3 text-muted-foreground"
        >
          <Loader2 aria-hidden className="size-6 animate-spin" />
          <p className="text-sm">正在加载共享目录…</p>
        </div>
      ) : listQuery.isError ? (
        <div className="mt-10 flex flex-col items-center gap-3 text-muted-foreground">
          <p className="text-sm">
            {listQuery.error instanceof Error
              ? listQuery.error.message
              : "加载失败"}
          </p>
          <Button
            variant="outline"
            className="min-h-11 px-6"
            onClick={() => void listQuery.refetch()}
          >
            重试
          </Button>
        </div>
      ) : files.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-3 rounded-xl border border-dashed border-border p-10 text-center text-muted-foreground">
          <Share2 aria-hidden className="size-8" />
          <p className="text-sm">共享目录还是空的</p>
          <p className="max-w-md text-xs">
            在资源库的单元 / 讲义详情里点「发布到共享」，或把 .md
            文件直接放进服务器的 DATA_DIR/shared/
            目录，其他老师就能在这里看到并导入。
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-2 rounded-xl border border-dashed border-border p-10 text-center text-muted-foreground">
          <Search aria-hidden className="size-6" />
          <p className="text-sm">没有匹配「{query.trim()}」的文件</p>
        </div>
      ) : (
        <ul className="mt-4 space-y-3" aria-label="共享文件列表">
          {filtered.map((file) => (
            <li
              key={file.filename}
              className="rounded-xl border border-border bg-card px-4 py-3.5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex min-h-6 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                      {file.kind === "lecture" ? (
                        <BookOpen aria-hidden className="size-3" />
                      ) : (
                        <FileText aria-hidden className="size-3" />
                      )}
                      {KIND_LABELS[file.kind]}
                    </span>
                    <span
                      data-testid="shared-source"
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        file.source === "published"
                          ? "bg-sky-500/10 text-sky-700 dark:text-sky-300"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {file.source === "published" ? "在线发布" : "本地文件"}
                    </span>
                    <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
                      {file.title}
                    </h2>
                  </div>
                  <p
                    className="mt-1.5 truncate font-mono text-xs text-muted-foreground"
                    title={file.filename}
                  >
                    {file.filename}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {file.publisher === null ? (
                      "本地文件"
                    ) : (
                      <>
                        发布者：<strong>{file.publisher}</strong>
                      </>
                    )}
                    {" · "}
                    {file.kind === "practice"
                      ? `${file.questionCount} 题 · `
                      : ""}
                    <span title={formatCnTime(file.publishedAt)}>
                      {formatRelativeTime(file.publishedAt)}
                    </span>
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    className="min-h-11 px-4"
                    onClick={() => {
                      setActionError(null);
                      setActionHint(null);
                      setImporting(file);
                    }}
                  >
                    <FolderInput aria-hidden />
                    导入到我的资源库
                  </Button>
                  {file.canDelete ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="min-h-11 px-4 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`删除共享文件 ${file.filename}`}
                      onClick={() => {
                        setActionError(null);
                        setActionHint(null);
                        setDeleting(file);
                      }}
                    >
                      <Trash2 aria-hidden />
                      删除
                    </Button>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 导入预览抽屉（复用单文件预览组件，D17） */}
      {importing !== null ? (
        <SharedImportSheet
          file={importing}
          folders={folders}
          onClose={() => setImporting(null)}
        />
      ) : null}

      {/* 删除确认（§4.2：已导入的资源不受影响） */}
      {deleting !== null ? (
        <div
          role="alertdialog"
          aria-labelledby="shared-delete-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg">
            <h3 id="shared-delete-title" className="text-base font-semibold">
              删除共享文件？
            </h3>
            <p className="mt-2 truncate font-mono text-xs text-muted-foreground">
              {deleting.filename}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              删除后其他老师将不能继续导入该文件；
              <strong>已导入进资源库的内容不受影响</strong>。此操作不可撤销。
            </p>
            {deleteMutation.isError ? (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {deleteMutation.error instanceof Error
                  ? deleteMutation.error.message
                  : "删除失败，请稍后重试"}
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 px-4"
                onClick={() => setDeleting(null)}
                disabled={deleteMutation.isPending}
              >
                取消
              </Button>
              <Button
                type="button"
                variant="destructive"
                className="min-h-11 px-4"
                disabled={deleteMutation.isPending}
                onClick={() => {
                  deleteMutation.mutate(deleting, {
                    onSuccess: () => {
                      setActionHint("已删除共享文件");
                      setDeleting(null);
                    },
                    onError: (err) => {
                      if (
                        err instanceof ApiError &&
                        err.code === "FORBIDDEN_SHARED_FILE"
                      ) {
                        setDeleting(null);
                        setActionError(
                          "只能删除自己发布的共享文件；本地放入的文件需要管理员在管理端删除",
                        );
                        return;
                      }
                      // 其余错误在弹层内展示（上方 deleteMutation.isError 分支）
                    },
                  });
                }}
              >
                {deleteMutation.isPending ? (
                  <>
                    <Loader2 aria-hidden className="animate-spin" />
                    删除中…
                  </>
                ) : (
                  "确认删除"
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// 供 App.tsx 路由级懒加载
export default SharedPage;
