import { arrayMove } from "@dnd-kit/sortable";
import type { CourseDetailData, CourseDetailItem } from "@tutor/contract";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  CalendarClock,
  Dumbbell,
  Eye,
  EyeOff,
  Hash,
  Loader2,
  Plus,
  Trash2,
  UserRound,
} from "lucide-react";
import { useMemo, useState } from "react";
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
import { DragHandle, SortableItem, SortableZone } from "@/features/content/sortable";
import {
  AddFromLibrarySheet,
  refIdKeysOf,
} from "@/features/courses/AddFromLibrarySheet";
import {
  useAddCourseItems,
  useCourseStudentView,
  useDeleteCourseItem,
  useReorderCourseItems,
  useUpdateCourseItem,
} from "@/features/courses/course-queries";
import { formatDueTime, localInputToUtcIso, utcIsoToLocalInput } from "@/lib/time";

/**
 * 课程目录页签（T2A.4）：拖拽排序 + 上移/下移兜底（§4-9）、条目状态标签（§4-4）、
 * 每条可见开关与定时发布、插入分节标题、「从资源库添加」抽屉、「学生可见预览」
 * 开关（§4-10，只读渲染 D5 过滤后的成员可见目录）。
 */

/** 状态标签文案（§4-4：可见 / 隐藏 / 定时（M月D日 HH:mm 发布）/ 已删除 / 无题目） */
export function courseItemStatusLabel(item: CourseDetailItem): string {
  switch (item.status) {
    case "visible":
      return "可见";
    case "hidden":
      return "隐藏";
    case "scheduled":
      return `定时（${formatDueTime(item.publishAt ?? "")} 发布）`;
    case "deleted":
      return "已删除";
    case "no-questions":
      return "无题目";
  }
}

/** 状态标签配色（一目了然，§4-4） */
function statusClass(item: CourseDetailItem): string {
  switch (item.status) {
    case "visible":
      return "bg-primary/10 text-primary";
    case "hidden":
      return "bg-muted text-muted-foreground";
    case "scheduled":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
    case "deleted":
    case "no-questions":
      return "bg-destructive/10 text-destructive";
  }
}

export function CourseCatalogTab({
  courseId,
  detail,
}: {
  courseId: string;
  detail: CourseDetailData;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [sectionOpen, setSectionOpen] = useState(false);
  const [previewOn, setPreviewOn] = useState(false);
  /** 学生可见预览选中的成员 */
  const [previewStudentId, setPreviewStudentId] = useState<string | null>(
    detail.members[0]?.studentId ?? null,
  );

  const existingKeys = useMemo(() => refIdKeysOf(detail), [detail]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button className="min-h-11 px-4" onClick={() => setAddOpen(true)}>
          <Plus aria-hidden />
          从资源库添加
        </Button>
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() => setSectionOpen(true)}
        >
          <Hash aria-hidden />
          插入分节标题
        </Button>
        <Button
          variant={previewOn ? "secondary" : "outline"}
          className="ml-auto min-h-11"
          aria-pressed={previewOn}
          onClick={() => setPreviewOn((v) => !v)}
        >
          <Eye aria-hidden />
          学生可见预览{previewOn ? "：开" : ""}
        </Button>
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-2">
        <CourseItemsList courseId={courseId} detail={detail} />
        {previewOn && (
          <StudentViewPanel
            courseId={courseId}
            members={detail.members}
            studentId={previewStudentId}
            onSelectStudent={setPreviewStudentId}
          />
        )}
      </div>

      {addOpen && (
        <AddFromLibrarySheet
          courseId={courseId}
          existingKeys={existingKeys}
          onClose={() => setAddOpen(false)}
        />
      )}
      {sectionOpen && (
        <AddSectionDialog
          courseId={courseId}
          onClose={() => setSectionOpen(false)}
        />
      )}
    </div>
  );
}

// ---------- 目录列表（拖拽 + 上移/下移兜底） ----------

function CourseItemsList({
  courseId,
  detail,
}: {
  courseId: string;
  detail: CourseDetailData;
}) {
  const reorderMutation = useReorderCourseItems(courseId);
  const deleteMutation = useDeleteCourseItem(courseId);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [publishItemId, setPublishItemId] = useState<string | null>(null);

  const items = detail.items;
  const ids = items.map((item) => item.id);

  function commitOrder(nextItems: readonly CourseDetailItem[]): void {
    reorderMutation.mutate({ ids: nextItems.map((item) => item.id) });
  }

  function move(id: string, offset: -1 | 1): void {
    const index = items.findIndex((item) => item.id === id);
    const target = index + offset;
    if (index === -1 || target < 0 || target >= items.length) return;
    commitOrder(arrayMove(items, index, target));
  }

  const deleteTarget = items.find((item) => item.id === confirmDeleteId) ?? null;

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center lg:col-span-2">
        <BookOpen aria-hidden className="size-10 text-muted-foreground" />
        <p className="text-sm font-medium">课程还没有内容</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          从资源库选择讲义与练习单元加入目录，学生按这里的顺序学习。
        </p>
      </div>
    );
  }

  return (
    <>
      {reorderMutation.isError && (
        <p role="alert" className="text-sm text-destructive lg:col-span-2">
          {reorderMutation.error instanceof Error
            ? reorderMutation.error.message
            : "排序失败，请稍后重试"}
        </p>
      )}
      <SortableZone
        ids={ids}
        ariaLabel={`${detail.name} 的目录列表`}
        onReorder={(orderedIds) => {
          const byId = new Map(items.map((item) => [item.id, item]));
          commitOrder(orderedIds.map((id) => byId.get(id) as CourseDetailItem));
        }}
      >
        <ul className="flex flex-col gap-2">
          {items.map((item, index) => (
            <SortableItem key={item.id} id={item.id}>
              {({ rowProps, handleListeners }) => (
                <li
                  {...rowProps}
                  className={`flex flex-col gap-2 rounded-xl border border-border bg-card p-3 ${
                    item.status === "deleted" ? "opacity-60" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <DragHandle
                      label={`拖拽调整 ${item.title} 的顺序`}
                      listeners={handleListeners}
                    />
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <ItemKindIcon kind={item.kind} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {item.title}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          <span
                            className={`mr-1.5 inline-block rounded px-1.5 py-0.5 text-xs ${statusClass(item)}`}
                          >
                            {courseItemStatusLabel(item)}
                          </span>
                          {item.kind === "unit" &&
                            item.questionCount !== null &&
                            `${item.questionCount} 题`}
                          {item.kind === "lecture" && "讲义"}
                          {item.kind === "section" && "分节标题"}
                        </span>
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        className="size-11"
                        aria-label={`上移 ${item.title}`}
                        disabled={index === 0 || reorderMutation.isPending}
                        onClick={() => move(item.id, -1)}
                      >
                        <ArrowUp aria-hidden className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        className="size-11"
                        aria-label={`下移 ${item.title}`}
                        disabled={
                          index === items.length - 1 || reorderMutation.isPending
                        }
                        onClick={() => move(item.id, 1)}
                      >
                        <ArrowDown aria-hidden className="size-4" />
                      </Button>
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pl-1">
                    <VisibleToggle courseId={courseId} item={item} />
                    <Button
                      variant="outline"
                      className="min-h-11"
                      onClick={() => setPublishItemId(item.id)}
                    >
                      <CalendarClock aria-hidden />
                      {item.publishAt !== null ? "修改定时" : "定时发布"}
                    </Button>
                    {item.kind === "section" && (
                      <RenameSectionButton courseId={courseId} item={item} />
                    )}
                    <Button
                      variant="ghost"
                      className="ml-auto min-h-11 px-3 text-destructive hover:text-destructive"
                      disabled={deleteMutation.isPending}
                      onClick={() => setConfirmDeleteId(item.id)}
                    >
                      <Trash2 aria-hidden />
                      移除
                    </Button>
                  </div>
                </li>
              )}
            </SortableItem>
          ))}
        </ul>
      </SortableZone>

      {deleteTarget && (
        <Dialog open onOpenChange={(open) => !open && setConfirmDeleteId(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>从课程移除「{deleteTarget.title}」？</DialogTitle>
              <DialogDescription>
                只是从这门课程的目录中移除；资源库中的内容不受影响，其他课程与作业照常使用。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setConfirmDeleteId(null)}
              >
                取消
              </Button>
              <Button
                type="button"
                variant="destructive"
                className="min-h-11 px-4"
                onClick={() => {
                  deleteMutation.mutate(deleteTarget.id);
                  setConfirmDeleteId(null);
                }}
              >
                确认移除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {publishItemId !== null && (
        <PublishDialog
          courseId={courseId}
          item={items.find((entry) => entry.id === publishItemId) ?? null}
          onClose={() => setPublishItemId(null)}
        />
      )}
    </>
  );
}

function ItemKindIcon({ kind }: { kind: CourseDetailItem["kind"] }) {
  if (kind === "lecture") {
    return (
      <BookOpen aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    );
  }
  if (kind === "unit") {
    return (
      <Dumbbell aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    );
  }
  return <Hash aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
}

/** 可见开关（D5 条件 3；aria-pressed 按钮，≥44px） */
function VisibleToggle({
  courseId,
  item,
}: {
  courseId: string;
  item: CourseDetailItem;
}) {
  const updateMutation = useUpdateCourseItem(courseId);
  return (
    <Button
      variant={item.visible ? "secondary" : "outline"}
      className="min-h-11"
      aria-pressed={item.visible}
      disabled={updateMutation.isPending}
      onClick={() =>
        updateMutation.mutate({
          id: item.id,
          request: { visible: !item.visible },
        })
      }
    >
      {item.visible ? (
        <>
          <Eye aria-hidden />
          学生可见
        </>
      ) : (
        <>
          <EyeOff aria-hidden />
          已隐藏
        </>
      )}
    </Button>
  );
}

/**
 * 定时发布弹层（§4-8：datetime-local + 「x 天后」相对提示；北京时间显示）。
 * 已设置定时的条目可改时间或清除定时（显式 null = 恢复不定时）。
 */
function PublishDialog({
  courseId,
  item,
  onClose,
}: {
  courseId: string;
  item: CourseDetailItem | null;
  onClose: () => void;
}) {
  // 弹层按 publishItemId 挂载，item 在生命周期内不变，useState 初值即正确
  const [value, setValue] = useState(
    item !== null && item.publishAt !== null
      ? utcIsoToLocalInput(item.publishAt)
      : "",
  );
  const updateMutation = useUpdateCourseItem(courseId);

  /** 「x 天后」相对提示（§4-8；天数向上取整，当天显示「今天」） */
  const relativeHint =
    value.length > 0 && item !== null
      ? (() => {
          const utc = localInputToUtcIso(value);
          const days = Math.ceil(
            (Date.parse(utc) - Date.now()) / (24 * 60 * 60 * 1000),
          );
          if (Number.isNaN(days)) return null;
          if (days < 0) return "该时间已过，保存后立即对学生可见";
          if (days === 0) return "今天发布（北京时间）";
          return `${days} 天后发布（北京时间 ${formatDueTime(utc)}）`;
        })()
      : null;

  function submit(publishAt: string | null): void {
    if (item === null) return;
    updateMutation.mutate(
      { id: item.id, request: { publishAt } },
      { onSuccess: onClose },
    );
  }

  if (item === null) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>定时发布「{item.title}」</DialogTitle>
          <DialogDescription>
            到点后条目自动对学生可见（北京时间）。隐藏中的条目到点也不会自动可见——
            请同时打开「学生可见」开关。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <label htmlFor="publish-at" className="text-sm">
            发布时间（北京时间）
          </label>
          <Input
            id="publish-at"
            type="datetime-local"
            className="min-h-11"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {relativeHint && (
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {relativeHint}
            </p>
          )}
          {updateMutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              {updateMutation.error instanceof Error
                ? updateMutation.error.message
                : "保存失败，请稍后重试"}
            </p>
          )}
        </div>
        <DialogFooter>
          {item.publishAt !== null && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={updateMutation.isPending}
              onClick={() => submit(null)}
            >
              清除定时
            </Button>
          )}
          <Button
            type="button"
            className="min-h-11 px-4"
            disabled={updateMutation.isPending || value.length === 0}
            onClick={() => submit(localInputToUtcIso(value))}
          >
            {updateMutation.isPending ? (
              <Loader2 aria-hidden className="animate-spin" />
            ) : (
              "保存"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 分节改名按钮 + 弹层 */
function RenameSectionButton({
  courseId,
  item,
}: {
  courseId: string;
  item: CourseDetailItem;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        className="min-h-11"
        onClick={() => setOpen(true)}
      >
        改名
      </Button>
      {open && (
        <RenameSectionDialog
          courseId={courseId}
          item={item}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function RenameSectionDialog({
  courseId,
  item,
  onClose,
}: {
  courseId: string;
  item: CourseDetailItem;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const updateMutation = useUpdateCourseItem(courseId);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>修改分节标题</DialogTitle>
          <DialogDescription>分节标题是目录里的纯文字小标题。</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            updateMutation.mutate(
              { id: item.id, request: { title: title.trim() } },
              { onSuccess: onClose },
            );
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="section-rename" className="text-sm">
              标题
            </label>
            <Input
              id="section-rename"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={100}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={onClose}
              disabled={updateMutation.isPending}
            >
              取消
            </Button>
            <Button
              type="submit"
              className="min-h-11 px-4"
              disabled={updateMutation.isPending || title.trim().length === 0}
            >
              {updateMutation.isPending ? (
                <Loader2 aria-hidden className="animate-spin" />
              ) : (
                "保存"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 插入分节标题（追加到目录末尾；「添加后对学生可见」开关默认开，D6） */
function AddSectionDialog({
  courseId,
  onClose,
}: {
  courseId: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [visible, setVisible] = useState(true);
  const addMutation = useAddCourseItems(courseId);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>插入分节标题</DialogTitle>
          <DialogDescription>
            分节只用于目录分组（如「第一周」），不关联资源，追加到目录末尾后可拖到任意位置。
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            addMutation.mutate(
              { items: [{ kind: "section", title: title.trim() }], visible },
              { onSuccess: onClose },
            );
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="section-title" className="text-sm">
              标题
            </label>
            <Input
              id="section-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="如：第一周·有理数"
              required
              maxLength={100}
            />
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-5 accent-[var(--color-primary)]"
              checked={visible}
              onChange={(e) => setVisible(e.target.checked)}
            />
            添加后对学生可见
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={onClose}
              disabled={addMutation.isPending}
            >
              取消
            </Button>
            <Button
              type="submit"
              className="min-h-11 px-4"
              disabled={addMutation.isPending || title.trim().length === 0}
            >
              {addMutation.isPending ? (
                <>
                  <Loader2 aria-hidden className="animate-spin" />
                  正在添加…
                </>
              ) : (
                <>
                  <Plus aria-hidden />
                  添加
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 学生可见预览（§4-10） ----------

function StudentViewPanel({
  courseId,
  members,
  studentId,
  onSelectStudent,
}: {
  courseId: string;
  members: CourseDetailData["members"];
  studentId: string | null;
  onSelectStudent: (id: string | null) => void;
}) {
  const viewQuery = useCourseStudentView(courseId, studentId);
  const view = viewQuery.data;

  return (
    <aside
      aria-label="学生可见预览"
      className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Eye aria-hidden className="size-4 text-primary" />
        <p className="text-sm font-medium">学生可见预览</p>
        <span className="text-xs text-muted-foreground">
          只读视图：该成员此刻实际能看到的目录（按可见规则实时计算）
        </span>
      </div>

      {members.length === 0 ? (
        <p className="rounded-lg bg-background px-3 py-6 text-center text-sm text-muted-foreground">
          课程还没有成员，先到「成员」页签添加学生，才能预览学生视角。
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="preview-student" className="text-sm">
              以谁的视角预览
            </label>
            <select
              id="preview-student"
              className="min-h-11 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              value={studentId ?? ""}
              onChange={(e) => onSelectStudent(e.target.value || null)}
            >
              {members.map((member) => (
                <option key={member.studentId} value={member.studentId}>
                  {member.displayName}
                  {member.archived ? "（已归档）" : ""}
                </option>
              ))}
            </select>
          </div>

          {viewQuery.isPending && (
            <div role="status" className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/50" />
              ))}
              <p className="sr-only">正在计算学生可见目录…</p>
            </div>
          )}
          {viewQuery.isError && (
            <div role="alert" className="flex flex-col items-start gap-2 rounded-lg bg-background p-3 text-sm text-destructive">
              <p>
                {viewQuery.error instanceof Error
                  ? viewQuery.error.message
                  : "加载失败，请稍后重试"}
              </p>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => void viewQuery.refetch()}
              >
                重试
              </Button>
            </div>
          )}
          {view && (
            <>
              {view.courseArchived && (
                <p className="rounded-lg bg-background px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                  课程已归档：所有学生当前都看不到这门课程。
                </p>
              )}
              {view.studentArchived && (
                <p className="rounded-lg bg-background px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                  该学生已归档，看不到任何课程内容。
                </p>
              )}
              {!view.courseArchived && !view.studentArchived && !view.isMember && (
                <p className="rounded-lg bg-background px-3 py-2 text-sm text-muted-foreground">
                  该学生不是课程成员，看不到课程内容。
                </p>
              )}
              {view.items.length === 0 ? (
                <p className="rounded-lg bg-background px-3 py-6 text-center text-sm text-muted-foreground">
                  该成员此刻看不到任何条目（隐藏 / 未到发布时间 / 无题目都会被过滤）。
                </p>
              ) : (
                <ol className="flex flex-col gap-1">
                  {view.items.map((item) => (
                    <li
                      key={item.id}
                      className="flex min-h-11 items-center gap-2 rounded-lg bg-background px-3 py-2 text-sm"
                    >
                      <ItemKindIcon kind={item.kind} />
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {item.kind === "unit" ? "练习" : item.kind === "lecture" ? "讲义" : "分节"}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <UserRound aria-hidden className="size-3.5" />
                {view.studentName} · 共 {view.items.length} 条可见
              </p>
            </>
          )}
        </>
      )}
    </aside>
  );
}
