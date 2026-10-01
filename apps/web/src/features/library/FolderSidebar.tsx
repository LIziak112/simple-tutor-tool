import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LibraryFolder } from "@tutor/contract";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Ellipsis,
  FolderOpen,
  FolderPlus,
  Loader2,
  PencilLine,
  Trash2,
  X,
} from "lucide-react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  DragHandle,
  SortableItem,
  SortableZone,
} from "@/features/content/sortable";
import {
  createLibraryFolderApi,
  deleteLibraryFolderApi,
  renameLibraryFolderApi,
  reorderLibraryFoldersApi,
} from "@/lib/api";
import { libraryFoldersKey } from "./library-queries";

/**
 * 资源库左侧文件夹栏（D2 / T2A.2；界面优化方案 A+C 后单行布局）：
 * - 「全部」与「未归类」为虚拟项（前端固定渲染，不可删改）；
 * - 文件夹行单行布局：拖拽把手 + 名称（占满剩余宽度，超长截断、title 悬停看
 *   全名）+ 计数 + 「⋯」更多操作菜单（重命名/上移/下移/删除）——操作收进菜单
 *   消除图标噪音，行高减半；「⋯」hover / 行内键盘聚焦时浮现，触屏
 *   （pointer-coarse）常显保证可发现；双击名称也可直接进入改名；
 * - 文件夹：新建、行内改名、删除（二次确认，显示将移动的讲义数/单元数）、
 *   拖拽排序（dnd-kit 把手 + 上移/下移菜单项兜底，§4-9）；
 * - 每项显示未删除讲义/单元计数。
 */

/** 选中值：undefined = 全部；null = 未归类；string = 指定文件夹 */
export type FolderSelection = string | null | undefined;

interface FolderSidebarProps {
  folders: LibraryFolder[];
  pending: boolean;
  error: string | null;
  selected: FolderSelection;
  onSelect: (value: FolderSelection) => void;
  onRetry: () => void;
  /** 未归类的未删除资源计数（列表数据汇总） */
  uncategorizedCount: { lectures: number; units: number };
  /** 全部资源计数（「全部」项展示） */
  totalCount: { lectures: number; units: number };
  onActionError: (message: string) => void;
}

export function FolderSidebar({
  folders,
  pending,
  error,
  selected,
  onSelect,
  onRetry,
  uncategorizedCount,
  totalCount,
  onActionError,
}: FolderSidebarProps) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<LibraryFolder | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: libraryFoldersKey });
  };

  const createMutation = useMutation({
    mutationFn: (name: string) => createLibraryFolderApi({ name }),
    onSuccess: async () => {
      await invalidate();
      setCreating(false);
    },
    onError: (err) => {
      setCreating(false);
      onActionError(
        err instanceof Error ? err.message : "新建文件夹失败，请稍后重试",
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteLibraryFolderApi(id),
    onSuccess: async () => {
      await invalidate();
      setDeleting(null);
    },
    onError: (err) => {
      setDeleting(null);
      onActionError(
        err instanceof Error ? err.message : "删除文件夹失败，请稍后重试",
      );
    },
  });

  const reorderMutation = useMutation({
    mutationFn: (ids: string[]) => reorderLibraryFoldersApi({ ids }),
    onSuccess: () => invalidate(),
    onError: (err) => {
      onActionError(
        err instanceof Error ? err.message : "排序保存失败，请稍后重试",
      );
    },
  });

  /** 上移/下移兜底（§4-9） */
  function moveFolder(index: number, delta: -1 | 1): void {
    const next = folders.map((f) => f.id);
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [
      next[target] as string,
      next[index] as string,
    ];
    reorderMutation.mutate(next);
  }

  const uncategorizedTotal =
    uncategorizedCount.lectures + uncategorizedCount.units;
  const allTotal = totalCount.lectures + totalCount.units;

  return (
    <aside
      aria-label="资源库文件夹"
      className="w-full shrink-0 space-y-2 rounded-xl border bg-muted/30 p-2 md:sticky md:top-6 md:max-h-[calc(100vh-3rem)] md:w-64 md:overflow-y-auto"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">文件夹</h2>
        <Button
          type="button"
          variant="ghost"
          className="size-11"
          aria-label="新建文件夹"
          onClick={() => setCreating(true)}
        >
          <FolderPlus aria-hidden />
        </Button>
      </div>

      {pending ? (
        <div aria-live="polite" className="space-y-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-11 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : null}
      {error !== null ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm"
        >
          <p className="text-destructive">文件夹加载失败</p>
          <p className="mt-0.5 text-xs break-all text-muted-foreground">
            {error}
          </p>
          <Button
            variant="outline"
            className="mt-2 min-h-11 px-4"
            onClick={onRetry}
          >
            重试
          </Button>
        </div>
      ) : null}

      {!pending && error === null ? (
        <nav aria-label="文件夹列表">
          <ul className="space-y-1">
            <li>
              <FolderItemButton
                active={selected === undefined}
                onClick={() => onSelect(undefined)}
                icon={<FolderOpen aria-hidden className="size-4 shrink-0" />}
                label="全部"
                count={allTotal}
              />
            </li>
            <li>
              <FolderItemButton
                active={selected === null}
                onClick={() => onSelect(null)}
                icon={<FolderOpen aria-hidden className="size-4 shrink-0" />}
                label="未归类"
                count={uncategorizedTotal}
              />
            </li>
          </ul>
          {folders.length > 0 ? (
            <SortableZone
              ids={folders.map((f) => f.id)}
              ariaLabel="文件夹列表（拖拽把手调整顺序）"
              onReorder={(ids) => reorderMutation.mutate(ids)}
            >
              <ul className="mt-1 space-y-1">
                {folders.map((folder, index) => (
                  <SortableFolderRow
                    key={folder.id}
                    folder={folder}
                    active={selected === folder.id}
                    onSelect={onSelect}
                    onRename={(name) => {
                      renameLibraryFolderApi(folder.id, { name })
                        .then(() => invalidate())
                        .catch((err: unknown) => {
                          setRenameError(
                            err instanceof Error
                              ? err.message
                              : "改名失败，请稍后重试",
                          );
                        });
                    }}
                    renameError={renameError}
                    clearRenameError={() => setRenameError(null)}
                    onDelete={() => setDeleting(folder)}
                    onMove={(delta) => moveFolder(index, delta)}
                    canMoveUp={index > 0}
                    canMoveDown={index < folders.length - 1}
                  />
                ))}
              </ul>
            </SortableZone>
          ) : (
            <p className="mt-2 px-2 text-xs text-muted-foreground">
              还没有自定义文件夹。点右上角「+」新建一个。
            </p>
          )}
        </nav>
      ) : null}

      {creating ? (
        <NewFolderDialog
          pending={createMutation.isPending}
          onCancel={() => setCreating(false)}
          onSubmit={(name) => createMutation.mutate(name)}
        />
      ) : null}
      {deleting !== null ? (
        <DeleteFolderDialog
          folder={deleting}
          pending={deleteMutation.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            deleteMutation.mutate(deleting.id);
            // 删除后选中回落到「全部」（该文件夹已不存在）
            if (selected === deleting.id) onSelect(undefined);
          }}
        />
      ) : null}
    </aside>
  );
}

/** 文件夹行按钮（虚拟项用） */
function FolderItemButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 ${
        active
          ? "bg-primary/10 text-primary shadow-[inset_2px_0_0_var(--primary)]"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {count}
      </span>
    </button>
  );
}

/** 可排序的文件夹行（单行）：把手 + 名称/计数 + 「⋯」更多操作菜单 */
function SortableFolderRow({
  folder,
  active,
  onSelect,
  onRename,
  renameError,
  clearRenameError,
  onDelete,
  onMove,
  canMoveUp,
  canMoveDown,
}: {
  folder: LibraryFolder;
  active: boolean;
  onSelect: (value: FolderSelection) => void;
  onRename: (name: string) => void;
  renameError: string | null;
  clearRenameError: () => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(folder.name);
  const count = folder.lectureCount + folder.unitCount;

  const startRename = (): void => {
    setDraft(folder.name);
    clearRenameError();
    setRenaming(true);
  };

  return (
    <SortableItem id={folder.id}>
      {({ rowProps, handleListeners }) => (
        <li {...rowProps} className="group/item flex flex-col gap-0.5">
          {renaming ? (
            /* 改名占整行（改名期间不渲染把手与操作入口） */
            <form
              className="flex min-w-0 flex-wrap items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                setRenaming(false);
                const name = draft.trim();
                if (name.length > 0 && name !== folder.name) onRename(name);
              }}
            >
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label={`文件夹「${folder.name}」的新名称`}
                className="min-h-11 min-w-0 flex-1 basis-40"
                autoFocus
              />
              <Button
                type="submit"
                variant="ghost"
                className="size-11 shrink-0"
                aria-label="保存文件夹名"
              >
                <Check aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="size-11 shrink-0"
                aria-label="取消重命名"
                onClick={() => {
                  setRenaming(false);
                  clearRenameError();
                }}
              >
                <X aria-hidden />
              </Button>
              {renameError !== null ? (
                <p role="alert" className="w-full text-xs text-destructive">
                  {renameError}
                </p>
              ) : null}
            </form>
          ) : (
            /* 单行：把手 + 名称（计数在选中按钮内，点击目标更大）+ ⋯ 菜单 */
            <div className="flex items-center gap-1">
              <DragHandle
                label={`拖拽调整文件夹「${folder.name}」的顺序`}
                listeners={handleListeners}
              />
              <button
                type="button"
                onClick={() => onSelect(folder.id)}
                onDoubleClick={startRename}
                aria-current={active ? "true" : undefined}
                title={folder.name}
                className={`flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 ${
                  active
                    ? "bg-primary/10 text-primary shadow-[inset_2px_0_0_var(--primary)]"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <FolderOpen aria-hidden className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left">
                  {folder.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {count}
                </span>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  type="button"
                  aria-label={`文件夹「${folder.name}」的更多操作`}
                  className="size-11 shrink-0 opacity-0 transition-opacity group-hover/item:opacity-100 group-focus-within/item:opacity-100 pointer-coarse:opacity-100 data-[state=open]:opacity-100"
                >
                  <Ellipsis aria-hidden />
                </DropdownMenuTrigger>
                {/* 菜单可访问名由 radix 自动取触发器文案（aria-labelledby）：
                    「文件夹「X」的更多操作」，比裸文件夹名更具辨识度 */}
                <DropdownMenuContent>
                  <DropdownMenuItem
                    aria-label={`重命名文件夹 ${folder.name}`}
                    onSelect={startRename}
                  >
                    <PencilLine aria-hidden />
                    重命名
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    aria-label={`上移文件夹 ${folder.name}`}
                    disabled={!canMoveUp}
                    onSelect={() => onMove(-1)}
                  >
                    <ArrowUp aria-hidden />
                    上移
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    aria-label={`下移文件夹 ${folder.name}`}
                    disabled={!canMoveDown}
                    onSelect={() => onMove(1)}
                  >
                    <ArrowDown aria-hidden />
                    下移
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    aria-label={`删除文件夹 ${folder.name}`}
                    onSelect={onDelete}
                  >
                    <Trash2 aria-hidden />
                    删除
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </li>
      )}
    </SortableItem>
  );
}

/** 新建文件夹弹层 */
function NewFolderDialog({
  pending,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState("");
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderPlus aria-hidden className="size-4 text-muted-foreground" />
            新建文件夹
          </DialogTitle>
          <DialogDescription>
            文件夹为一级分组（不可嵌套），用于组织讲义库与题库。
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim().length > 0 && !pending) onSubmit(name.trim());
          }}
        >
          <label htmlFor="new-folder-name" className="text-sm font-medium">
            文件夹名
          </label>
          <Input
            id="new-folder-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如有理数"
            className="min-h-11"
            autoFocus
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 px-5"
              onClick={onCancel}
              disabled={pending}
            >
              取消
            </Button>
            <Button
              type="submit"
              className="min-h-11 px-5"
              disabled={name.trim().length === 0 || pending}
            >
              {pending ? (
                <>
                  <Loader2 aria-hidden className="animate-spin" />
                  创建中…
                </>
              ) : (
                "创建"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 删除文件夹二次确认（显示将移动的数量，D2） */
function DeleteFolderDialog({
  folder,
  pending,
  onCancel,
  onConfirm,
}: {
  folder: LibraryFolder;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 aria-hidden className="size-4 text-destructive" />
            删除文件夹
          </DialogTitle>
          <DialogDescription>{folder.name}</DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          删除文件夹不会删除其中的内容：
          <strong>
            {folder.lectureCount} 篇讲义、{folder.unitCount} 个练习单元
          </strong>
          将移入「未归类」，可随时再移动到其他文件夹。
        </p>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 px-5"
            onClick={onCancel}
            disabled={pending}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="min-h-11 px-5"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                删除中…
              </>
            ) : (
              "删除文件夹"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
