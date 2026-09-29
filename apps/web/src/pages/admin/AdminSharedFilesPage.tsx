import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SharedFileSummary } from "@tutor/contract";
import {
  CircleAlert,
  FileText,
  FolderOpen,
  Loader2,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ApiError,
  deleteAdminSharedFileApi,
  fetchAdminSharedFiles,
} from "@/lib/api";
import { formatCnTime, formatRelativeTime } from "@/lib/time";

/**
 * /a/shared-files 管理端共享文件页（T2B.7，D18/D19）：列表（与教师端同形状，
 * 来源标签「在线发布 / 本地文件」，§4.3）、搜索（前端即时过滤，§4.5）、
 * 删除任意文件（含本地放入的；确认框注明「已导入的资源不受影响」，§4.2）。
 * 三态齐全（§4.6）+ 空态引导 + 北京时间/相对时间（§4.7）+ ≥44px 触控（§4.8）。
 */

/** 管理端共享列表 key（删除后失效；教师端发布不联动失效，进页自动重取） */
const adminSharedKey = ["admin", "shared-files"] as const;

const KIND_LABELS: Record<SharedFileSummary["kind"], string> = {
  lecture: "讲义",
  practice: "练习",
};

export function AdminSharedFilesPage() {
  const queryClient = useQueryClient();
  const listQuery = useQuery({
    queryKey: adminSharedKey,
    queryFn: fetchAdminSharedFiles,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const deleteMutation = useMutation({
    mutationFn: (filename: string) => deleteAdminSharedFileApi(filename),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminSharedKey });
      void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] });
    },
  });

  const [query, setQuery] = useState("");
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

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <FolderOpen aria-hidden className="size-5 text-primary" />
            共享文件
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            共享目录（DATA_DIR/shared/）内的全部文件；管理员可删除任意文件，含老师直接放进服务器的本地文件。
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
            placeholder="搜索文件名 / 标题 / 发布者"
            aria-label="搜索共享文件"
            className="min-h-11 w-64 pl-9"
          />
        </div>
      </header>

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

      {listQuery.data?.truncated ? (
        <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-300">
          目录文件过多，仅显示前 200 个。建议与老师们清理不再需要的文件。
        </p>
      ) : null}
      {listQuery.data !== undefined && listQuery.data.oversizeHidden > 0 ? (
        <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-300">
          有 {listQuery.data.oversizeHidden} 个超过 1MB
          的文件未列出（超出单文件上限）。
        </p>
      ) : null}

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
          <FolderOpen aria-hidden className="size-8" />
          <p className="text-sm">共享目录还是空的</p>
          <p className="max-w-md text-xs">
            老师发布单元 / 讲义、或把 .md 文件放进服务器的 DATA_DIR/shared/
            目录后，会出现在这里。
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
              className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex min-h-6 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                    <FileText aria-hidden className="size-3" />
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
                    "本地文件（服务器直接放入）"
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
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 shrink-0 px-4 text-destructive hover:bg-destructive/10 hover:text-destructive"
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
            </li>
          ))}
        </ul>
      )}

      {/* 删除确认（D18：管理员可删任意，含本地文件；§4.2 影响先说清） */}
      {deleting !== null ? (
        <div
          role="alertdialog"
          aria-labelledby="admin-shared-delete-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg">
            <h3
              id="admin-shared-delete-title"
              className="text-base font-semibold"
            >
              删除共享文件？
            </h3>
            <p className="mt-2 truncate font-mono text-xs text-muted-foreground">
              {deleting.filename}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              以管理员身份删除该文件（
              {deleting.source === "published" ? "在线发布" : "本地文件"}
              ）。删除后老师们将不能继续导入；
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
                  deleteMutation.mutate(deleting.filename, {
                    onSuccess: () => {
                      setActionHint(`已删除 ${deleting.filename}`);
                      setDeleting(null);
                    },
                    onError: (err) => {
                      if (
                        err instanceof ApiError &&
                        err.code === "SHARED_FILE_NOT_FOUND"
                      ) {
                        setDeleting(null);
                        setActionError("该文件已被删除（可能刚被他人清理）");
                        void queryClient.invalidateQueries({
                          queryKey: adminSharedKey,
                        });
                      }
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
export default AdminSharedFilesPage;
