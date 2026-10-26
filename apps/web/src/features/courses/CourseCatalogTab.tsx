import type { CourseDetailData, CourseDetailItem } from "@tutor/contract";
import {
  BookOpen,
  Dumbbell,
  Eye,
  Hash,
  Loader2,
  Plus,
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
import {
  AddFromLibrarySheet,
  refIdKeysOf,
} from "@/features/courses/AddFromLibrarySheet";
import {
  useCourseStudentView,
  useUpdateCourseItem,
} from "@/features/courses/course-queries";
import {
  formatDueTime,
  localInputToUtcIso,
  utcIsoToLocalInput,
} from "@/lib/time";
import { CourseTreeItems } from "./CourseTreeItems";
import { catalogTreeRows } from "./catalog-tree";

export function CourseCatalogTab({
  courseId,
  detail,
}: {
  courseId: string;
  detail: CourseDetailData;
}) {
  const [addTarget, setAddTarget] = useState<string | null | undefined>(
    undefined,
  );
  const [publishItem, setPublishItem] = useState<CourseDetailItem | null>(null);
  const [previewOn, setPreviewOn] = useState(false);
  const [previewStudentId, setPreviewStudentId] = useState<string | null>(
    detail.members[0]?.studentId ?? null,
  );
  const existingKeys = useMemo(() => refIdKeysOf(detail), [detail]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button className="min-h-11" onClick={() => setAddTarget(null)}>
          <Plus aria-hidden />
          从资源库添加
        </Button>
        <Button
          variant="outline"
          className="ml-auto min-h-11"
          aria-pressed={previewOn}
          onClick={() => setPreviewOn((v) => !v)}
        >
          <Eye aria-hidden />
          学生可见预览{previewOn ? "：开" : ""}
        </Button>
      </div>
      <div
        className={
          previewOn ? "grid items-start gap-3 xl:grid-cols-2" : "min-w-0"
        }
      >
        <CourseTreeItems
          courseId={courseId}
          detail={detail}
          onAdd={setAddTarget}
          onPublish={setPublishItem}
        />
        {previewOn && (
          <StudentViewPanel
            courseId={courseId}
            members={detail.members}
            studentId={previewStudentId}
            onSelectStudent={setPreviewStudentId}
          />
        )}
      </div>
      {addTarget !== undefined && (
        <AddFromLibrarySheet
          courseId={courseId}
          detail={detail}
          initialParentId={addTarget}
          existingKeys={existingKeys}
          onClose={() => setAddTarget(undefined)}
        />
      )}
      {publishItem && (
        <PublishDialog
          courseId={courseId}
          item={publishItem}
          onClose={() => setPublishItem(null)}
        />
      )}
    </div>
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
                <div
                  key={i}
                  className="h-12 animate-pulse rounded-lg bg-muted/50"
                />
              ))}
              <p className="sr-only">正在计算学生可见目录…</p>
            </div>
          )}
          {viewQuery.isError && (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 rounded-lg bg-background p-3 text-sm text-destructive"
            >
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
              {!view.courseArchived &&
                !view.studentArchived &&
                !view.isMember && (
                  <p className="rounded-lg bg-background px-3 py-2 text-sm text-muted-foreground">
                    该学生不是课程成员，看不到课程内容。
                  </p>
                )}
              {view.items.length === 0 ? (
                <p className="rounded-lg bg-background px-3 py-6 text-center text-sm text-muted-foreground">
                  该成员此刻看不到任何条目（隐藏 / 未到发布时间 /
                  无题目都会被过滤）。
                </p>
              ) : (
                <ol className="flex flex-col gap-1">
                  {catalogTreeRows(view.items).map(({ item, depth }) => (
                    <li
                      key={item.id}
                      style={{
                        marginInlineStart: `${Math.min(depth, 4) * 12}px`,
                      }}
                      className="flex min-h-11 items-center gap-2 rounded-lg bg-background px-3 py-2 text-sm"
                    >
                      <ItemKindIcon kind={item.kind} />
                      <span className="min-w-0 flex-1 break-words">
                        {item.title}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {item.kind === "unit"
                          ? "练习"
                          : item.kind === "lecture"
                            ? "讲义"
                            : "分节"}
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

/** 供课程选题面板复用的条目状态文案。 */
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
