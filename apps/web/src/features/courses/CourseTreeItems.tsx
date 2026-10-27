import type {
  CourseCatalogCommand,
  CourseDetailData,
  CourseDetailItem,
} from "@tutor/contract";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Dumbbell,
  FileUp,
  Folder,
  MoreHorizontal,
  Plus,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";
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
import { formatDueTime } from "@/lib/time";
import { catalogTreeRows } from "./catalog-tree";
import { useManageCourseCatalog } from "./course-queries";

type Editor = {
  action: "createFolder" | "rename" | "move" | "remove";
  ids: string[];
  parentId: string | null;
  title: string;
};
export function CourseTreeItems({
  courseId,
  detail,
  onAdd,
  onPublish,
}: {
  courseId: string;
  detail: CourseDetailData;
  onAdd: (parentId: string | null) => void;
  onPublish: (item: CourseDetailItem) => void;
}) {
  const mutation = useManageCourseCatalog(courseId);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [selected, setSelected] = useState<string[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [keepChildren, setKeepChildren] = useState(true);
  const [query, setQuery] = useState("");
  const rows = catalogTreeRows(detail.items);
  const childCounts = new Map<string, number>();
  for (const item of detail.items)
    if (item.parentId)
      childCounts.set(item.parentId, (childCounts.get(item.parentId) ?? 0) + 1);
  const q = query.trim().toLocaleLowerCase();
  const shown = new Set(
    rows
      .filter((row) => !q || row.path.toLocaleLowerCase().includes(q))
      .flatMap((row) => [row.item.id, ...row.ancestors]),
  );
  function open(
    action: Editor["action"],
    ids: string[],
    parentId: string | null = null,
  ) {
    mutation.reset();
    const title = detail.items.find((item) => item.id === ids[0])?.title ?? "";
    setEditor({ action, ids, parentId, title });
    setName(action === "rename" ? title : "");
    setTarget("");
    setKeepChildren(true);
  }
  function send(command: CourseCatalogCommand) {
    mutation.mutate(command, {
      onSuccess: () => {
        setEditor(null);
        if (command.action !== "reorder") setSelected([]);
      },
    });
  }
  function reorder(item: CourseDetailItem, offset: number) {
    const ids = detail.items
      .filter((row) => (row.parentId ?? null) === (item.parentId ?? null))
      .map((row) => row.id);
    const index = ids.indexOf(item.id);
    const next = index + offset;
    if (next < 0 || next >= ids.length) return;
    const moved = ids.splice(index, 1)[0];
    if (moved) ids.splice(next, 0, moved);
    send({ action: "reorder", ids, parentId: item.parentId ?? null });
  }
  const selectedItems = detail.items.filter((item) =>
    selected.includes(item.id),
  );
  const single = selectedItems.length === 1 ? selectedItems[0] : undefined;
  const siblings = single
    ? detail.items.filter(
        (item) => (item.parentId ?? null) === (single.parentId ?? null),
      )
    : [];
  const singleIndex = single
    ? siblings.findIndex((item) => item.id === single.id)
    : -1;
  function renderGroup(parentId: string | null = null): ReactNode {
    const group = rows.filter(
      (row) => (row.ancestors.at(-1) ?? null) === parentId,
    );
    const visible = group.filter((row) => shown.has(row.item.id));
    if (!visible.length) return null;
    return (
      <SortableZone
        ids={group.map((row) => row.item.id)}
        ariaLabel={
          parentId
            ? `文件夹 ${detail.items.find((item) => item.id === parentId)?.title} 的内容`
            : `${detail.name} 的目录列表`
        }
        onReorder={(ids) => {
          if (!q && !mutation.isPending)
            send({ action: "reorder", ids, parentId });
        }}
      >
        <ul className="flex flex-col gap-2">
          {visible.map(({ item, depth, path }) => (
            <SortableItem key={item.id} id={item.id}>
              {({ rowProps, handleListeners }) => (
                <li ref={rowProps.ref} style={rowProps.style}>
                  <div
                    className={`flex min-h-14 items-center gap-1 rounded-lg border px-2 py-1 ${selected.includes(item.id) ? "border-primary/40 bg-primary/5" : "border-border bg-card"}`}
                  >
                    {!q && !mutation.isPending && (
                      <DragHandle
                        label={`拖拽调整 ${item.title} 的同级顺序`}
                        listeners={handleListeners}
                      />
                    )}
                    <label className="flex size-11 shrink-0 items-center justify-center">
                      <input
                        type="checkbox"
                        aria-label={`选择 ${item.title}`}
                        checked={selected.includes(item.id)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, item.id]
                              : selected.filter((id) => id !== item.id),
                          )
                        }
                        className="size-4 accent-primary"
                      />
                    </label>
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      {item.kind === "section" ? (
                        <button
                          type="button"
                          aria-label={`${collapsed.has(item.id) ? "展开" : "收起"} ${item.title}`}
                          aria-expanded={!!q || !collapsed.has(item.id)}
                          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded text-start focus-visible:outline-2 focus-visible:outline-ring"
                          onClick={() =>
                            setCollapsed((prev) => {
                              const next = new Set(prev);
                              if (next.has(item.id)) next.delete(item.id);
                              else next.add(item.id);
                              return next;
                            })
                          }
                        >
                          {collapsed.has(item.id) && !q ? (
                            <ChevronRight
                              aria-hidden
                              className="size-4 shrink-0"
                            />
                          ) : (
                            <ChevronDown
                              aria-hidden
                              className="size-4 shrink-0"
                            />
                          )}
                          <Folder
                            aria-hidden
                            className="size-4 shrink-0 text-primary"
                          />
                          <span className="min-w-0 break-words text-sm font-medium">
                            {item.title}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {childCounts.get(item.id) ?? 0} 项
                          </span>
                        </button>
                      ) : (
                        <>
                          <span aria-hidden>
                            {item.kind === "lecture" ? (
                              <BookOpen className="size-4" />
                            ) : (
                              <Dumbbell className="size-4" />
                            )}
                          </span>
                          <span className="min-w-0 break-words py-2 text-sm font-medium">
                            {item.title}
                          </span>
                        </>
                      )}
                    </div>
                    {item.status !== "visible" && (
                      <span className="max-w-32 break-words text-xs text-muted-foreground">
                        {item.status === "scheduled"
                          ? `定时（${formatDueTime(item.publishAt ?? "")} 发布）`
                          : item.status === "hidden"
                            ? "已隐藏"
                            : item.status === "deleted"
                              ? "资源已删除"
                              : "无题目"}
                      </span>
                    )}
                  </div>
                  {depth > 3 && (
                    <p className="break-words px-3 py-1 text-xs text-muted-foreground">
                      {path}
                    </p>
                  )}
                  {item.kind === "section" &&
                    (q || !collapsed.has(item.id)) && (
                      <div
                        className="mt-2"
                        style={{ paddingInlineStart: depth < 3 ? 16 : 0 }}
                      >
                        {renderGroup(item.id)}
                      </div>
                    )}
                </li>
              )}
            </SortableItem>
          ))}
        </ul>
      </SortableZone>
    );
  }
  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          aria-label="搜索课程目录"
          placeholder="搜索名称或文件夹路径"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-h-11 min-w-0 flex-1 basis-56 text-base sm:text-sm"
        />
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() => open("createFolder", [])}
        >
          <Plus aria-hidden />
          新建文件夹
        </Button>
        <Button
          variant="ghost"
          className="min-h-11"
          onClick={() =>
            setCollapsed(
              collapsed.size
                ? new Set()
                : new Set(
                    detail.items
                      .filter((i) => i.kind === "section")
                      .map((i) => i.id),
                  ),
            )
          }
        >
          {collapsed.size ? "全部展开" : "全部折叠"}
        </Button>
      </div>
      {selectedItems.length > 0 && (
        <fieldset
          aria-label="已选条目操作"
          className="mb-3 flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
        >
          <span role="status" className="text-sm font-medium tabular-nums">
            已选 {selectedItems.length} 项
          </span>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={mutation.isPending}
            onClick={() => open("move", selected)}
          >
            移动到…
          </Button>
          {single && (
            <>
              <Button
                variant="ghost"
                className="min-h-11"
                disabled={mutation.isPending || singleIndex <= 0}
                onClick={() => reorder(single, -1)}
              >
                <ArrowUp aria-hidden />
                上移
              </Button>
              <Button
                variant="ghost"
                className="min-h-11"
                disabled={
                  mutation.isPending || singleIndex >= siblings.length - 1
                }
                onClick={() => reorder(single, 1)}
              >
                <ArrowDown aria-hidden />
                下移
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            className="min-h-11"
            disabled={mutation.isPending}
            onClick={() =>
              send({
                action: "setVisibility",
                ids: selected,
                visible: !selectedItems.every((item) => item.visible),
              })
            }
          >
            {selectedItems.every((item) => item.visible) ? "隐藏" : "显示"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={mutation.isPending}
              >
                <MoreHorizontal aria-hidden />
                更多操作
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="motion-reduce:animate-none"
            >
              {single && (
                <DropdownMenuItem onSelect={() => open("rename", [single.id])}>
                  改名
                </DropdownMenuItem>
              )}
              {single?.kind === "section" && (
                <>
                  <DropdownMenuItem
                    onSelect={() => open("createFolder", [], single.id)}
                  >
                    新建子文件夹
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onAdd(single.id)}>
                    添加内容到文件夹
                  </DropdownMenuItem>
                </>
              )}
              {single && (
                <DropdownMenuItem onSelect={() => onPublish(single)}>
                  定时发布
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => open("remove", selected)}
              >
                从课程移除…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            aria-label="取消选择"
            className="ms-auto min-h-11"
            onClick={() => setSelected([])}
          >
            <X aria-hidden />
            取消选择
          </Button>
        </fieldset>
      )}
      {mutation.isError && (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {mutation.error.message}。请重试，或刷新目录后再操作。
        </p>
      )}
      {detail.items.length === 0 && (
        <p className="rounded-xl border border-dashed py-8 text-center text-sm text-muted-foreground">
          课程还没有内容。从资源库添加，或先新建文件夹。
        </p>
      )}
      {renderGroup()}
      {q && shown.size === 0 && (
        <p role="status" className="py-6 text-sm">
          没有匹配内容。
          <Button
            variant="ghost"
            className="min-h-11"
            onClick={() => setQuery("")}
          >
            清除搜索
          </Button>
        </p>
      )}
      {editor && (
        <Dialog
          open
          onOpenChange={(open) =>
            !open && !mutation.isPending && setEditor(null)
          }
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editor.action === "createFolder"
                  ? "新建文件夹"
                  : editor.action === "rename"
                    ? "修改目录名称"
                    : editor.action === "move"
                      ? "移动到文件夹"
                      : "从课程移除"}
              </DialogTitle>
              <DialogDescription>
                {editor.action === "remove"
                  ? `已选 ${editor.ids.length} 项。${keepChildren ? "子内容移到上一级。" : "文件夹及其中所有内容将移出课程。"}资源库原件和作答记录保留。`
                  : "课程内名称不重名；目录名称不会修改资源库原件。"}
              </DialogDescription>
            </DialogHeader>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (editor.action === "createFolder")
                  send({
                    action: "createFolder",
                    title: name.trim(),
                    parentId: editor.parentId,
                  });
                else if (editor.action === "rename" && editor.ids[0])
                  send({
                    action: "rename",
                    id: editor.ids[0],
                    title: name.trim(),
                  });
                else if (editor.action === "move")
                  send({
                    action: "move",
                    ids: editor.ids,
                    parentId: target || null,
                  });
                else if (editor.action === "remove")
                  send({ action: "remove", ids: editor.ids, keepChildren });
              }}
            >
              {(editor.action === "createFolder" ||
                editor.action === "rename") && (
                <label htmlFor="catalog-editor-name" className="text-sm">
                  名称
                  <Input
                    id="catalog-editor-name"
                    autoFocus
                    required
                    maxLength={100}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="mt-1 text-base"
                  />
                </label>
              )}
              {editor.action === "move" && (
                <label className="text-sm">
                  目标位置
                  <select
                    className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-base"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    <option value="">根目录（未分组）</option>
                    {rows
                      .filter(
                        (row) =>
                          row.item.kind === "section" &&
                          !editor.ids.includes(row.item.id) &&
                          !row.ancestors.some((id) => editor.ids.includes(id)),
                      )
                      .map((row) => (
                        <option key={row.item.id} value={row.item.id}>
                          {row.path}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {editor.action === "remove" &&
                editor.ids.some(
                  (id) =>
                    detail.items.find((item) => item.id === id)?.kind ===
                    "section",
                ) && (
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={keepChildren}
                      onChange={(e) => setKeepChildren(e.target.checked)}
                    />
                    仅解散文件夹，内容移到上一级
                  </label>
                )}
              {mutation.isError && (
                <p role="alert" className="text-sm text-destructive">
                  {mutation.error.message}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={mutation.isPending}
                  onClick={() => setEditor(null)}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  className="min-h-11"
                  variant={
                    editor.action === "remove" ? "destructive" : "default"
                  }
                  disabled={mutation.isPending}
                >
                  {mutation.isPending
                    ? "正在保存…"
                    : editor.action === "remove"
                      ? "确认移除"
                      : "保存"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          文件夹隐藏或尚未到发布时间时，学生也看不到其中的内容。
        </p>
        <Button asChild variant="outline" className="min-h-11">
          <Link to={`/t/import?courseId=${courseId}`}>
            <FileUp aria-hidden />
            导入文件到课程
          </Link>
        </Button>
      </div>
    </div>
  );
}
