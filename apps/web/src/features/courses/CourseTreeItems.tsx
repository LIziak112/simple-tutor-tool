import type {
  CourseCatalogCommand,
  CourseDetailData,
  CourseDetailItem,
} from "@tutor/contract";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Dumbbell,
  Folder,
  Plus,
} from "lucide-react";
import { useState } from "react";
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
import { Input } from "@/components/ui/input";
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
        setSelected([]);
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
  return (
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Input
          aria-label="搜索课程目录"
          placeholder="搜索名称或文件夹路径"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-h-11 max-w-sm text-base sm:text-sm"
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
      {selected.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-muted p-2 text-sm">
          <span>已选 {selected.length} 项</span>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => open("move", selected)}
          >
            移动到…
          </Button>
          <Button
            variant="ghost"
            className="min-h-11"
            onClick={() => setSelected([])}
          >
            取消选择
          </Button>
        </div>
      )}
      {mutation.isError && (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {mutation.error.message}
        </p>
      )}
      {detail.items.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          课程还没有内容。从资源库添加，或先新建文件夹。
        </p>
      )}
      {detail.items.length > 0 && (
        <ul
          aria-label={`${detail.name} 的目录列表`}
          className="divide-y divide-border rounded-lg border border-border bg-card"
        >
          {rows
            .filter(
              (row) =>
                shown.has(row.item.id) &&
                (q || !row.ancestors.some((id) => collapsed.has(id))),
            )
            .map(({ item, depth, path }) => (
              <li
                key={item.id}
                className="flex min-h-12 flex-wrap items-center gap-1 px-2 py-1"
              >
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
                    className="size-4"
                  />
                </label>
                <div
                  className="flex min-w-0 flex-1 items-center gap-2"
                  style={{ paddingInlineStart: `${Math.min(depth, 4) * 16}px` }}
                >
                  {item.kind === "section" ? (
                    <button
                      type="button"
                      aria-label={`${collapsed.has(item.id) ? "展开" : "收起"} ${item.title}`}
                      aria-expanded={!!q || !collapsed.has(item.id)}
                      className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-2 focus-visible:outline-ring"
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
                        <ChevronRight className="size-4 shrink-0" />
                      ) : (
                        <ChevronDown className="size-4 shrink-0" />
                      )}
                      <Folder
                        aria-hidden
                        className="size-4 shrink-0 text-primary"
                      />
                      <span className="min-w-0 break-words text-sm font-medium">
                        {item.title}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
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
                      <span className="min-w-0 break-words text-sm">
                        {item.title}
                      </span>
                    </>
                  )}
                </div>
                <span className="ml-auto text-xs text-muted-foreground">
                  {item.status === "scheduled"
                    ? `定时（${formatDueTime(item.publishAt ?? "")} 发布）`
                    : item.status === "hidden"
                      ? "隐藏"
                      : item.status === "deleted"
                        ? "资源已删除"
                        : item.status === "no-questions"
                          ? "无题目"
                          : "可见"}
                </span>
                {item.kind === "section" && (
                  <Button
                    variant="ghost"
                    className="min-h-11 px-2"
                    aria-label={`向 ${item.title} 添加内容`}
                    onClick={() => onAdd(item.id)}
                  >
                    <Plus aria-hidden className="size-4" />
                  </Button>
                )}
                <select
                  aria-label={`${item.title} 的操作`}
                  value=""
                  disabled={mutation.isPending}
                  className="min-h-11 max-w-24 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                  onChange={(e) => {
                    const action = e.target.value;
                    if (action === "folder") open("createFolder", [], item.id);
                    else if (action === "add") onAdd(item.id);
                    else if (action === "up" || action === "down")
                      reorder(item, action === "up" ? -1 : 1);
                    else if (action === "visible")
                      send({
                        action: "setVisibility",
                        ids: [item.id],
                        visible: !item.visible,
                      });
                    else if (action === "publish") onPublish(item);
                    else if (
                      action === "rename" ||
                      action === "move" ||
                      action === "remove"
                    )
                      open(action, [item.id]);
                  }}
                >
                  <option value="">更多</option>
                  {item.kind === "section" && (
                    <>
                      <option value="folder">新建子文件夹</option>
                      <option value="add">添加内容</option>
                    </>
                  )}
                  <option value="rename">改名</option>
                  <option value="move">移动到…</option>
                  <option value="up">上移</option>
                  <option value="down">下移</option>
                  <option value="visible">
                    {item.visible ? "隐藏" : "显示（保留定时）"}
                  </option>
                  <option value="publish">定时发布</option>
                  <option value="remove">从课程移除…</option>
                </select>
                {depth > 4 && (
                  <span className="w-full break-words pl-10 text-xs text-muted-foreground">
                    {path}
                  </span>
                )}
              </li>
            ))}
        </ul>
      )}
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
      <p className="mt-2 text-xs text-muted-foreground">
        文件夹隐藏或尚未到发布时间时，学生也看不到其中的内容。
      </p>
      <Link
        className="mt-2 inline-flex min-h-11 items-center text-sm text-primary underline"
        to={`/t/import?courseId=${courseId}`}
      >
        导入文件到课程
      </Link>
    </div>
  );
}
