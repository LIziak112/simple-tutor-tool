import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  ContentTree,
  ContentTreeCourse,
  ContentTreeUnit,
} from "@tutor/contract";
import { cn } from "cn";
import {
  BookOpen,
  Check,
  ChevronRight,
  CircleAlert,
  FileStack,
  FolderPlus,
  PencilLine,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
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
  LectureEditSheet,
  QuestionEditSheet,
} from "@/features/content/ContentEditSheet";
import {
  contentTreeKey,
  useContentTree,
} from "@/features/content/content-queries";
import { DeleteConfirmDialog } from "@/features/content/DeleteConfirmDialog";
import {
  difficultyStars,
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "@/features/content/question-meta";
import {
  applyReorder,
  buildReorderPayload,
  type ReorderScope,
} from "@/features/content/reorder-logic";
import {
  DragHandle,
  SortableItem,
  SortableZone,
} from "@/features/content/sortable";
import {
  createCourseApi,
  deleteCourseApi,
  deleteLectureApi,
  deleteQuestionApi,
  reorderContentApi,
  updateCourseApi,
} from "@/lib/api";
import { formatRelativeTime } from "@/lib/time";

/**
 * /t/content 教师端内容页（T1.11 列表；T1.12 单条编辑/删除 + 拖拽排序 + 课程管理）：
 * - 按课程分组展示讲义与练习单元，单元展开显示题目摘要表；
 * - 讲义行/题目行：编辑（抽屉）+ 删除（确认弹层）；课程：新建/行内重命名/删除
 *   （有内容时删除禁用）；题目列表（单元展开内）/单元列表/讲义列表/课程列表支持
 *   dnd-kit 拖拽排序（把手 ≥44px，松手即调 reorder，乐观更新 + 失败回滚提示）；
 * - 三态齐全（加载骨架/错误重试/空态引导去导入页）；触控目标 ≥44px。
 * ImportPage 提交成功后带 location.state 跳回本页，顶部显示成功提示条。
 */

/** location.state 的已知形态（导入成功跳转携带） */
interface ContentLocationState {
  importSuccess?: string;
}

/** 成功提示条的自动收起延时（之后同步清掉 history state，刷新/后退不再重复弹出） */
const BANNER_AUTO_DISMISS_MS = 6000;

/** 待删除对象（确认弹层打开期间） */
interface DeletingTarget {
  kind: "question" | "lecture" | "course";
  id: string;
  /** 展示名：题目 id / 讲义标题 / 课程标题 */
  name: string;
}

export function ContentPage() {
  const treeQuery = useContentTree();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const state = location.state as ContentLocationState | null;
  const importSuccess = state?.importSuccess;
  const [bannerVisible, setBannerVisible] = useState(
    importSuccess !== undefined,
  );

  /** 编辑抽屉：正在编辑的题目/讲义 id（null = 关闭） */
  const [editingQuestionId, setEditingQuestionId] = useState<string | null>(
    null,
  );
  const [editingLectureId, setEditingLectureId] = useState<string | null>(null);
  /** 删除确认弹层的对象 */
  const [deleting, setDeleting] = useState<DeletingTarget | null>(null);
  /** 删除/排序失败的行内提示 */
  const [actionError, setActionError] = useState<string | null>(null);
  /** 新建课程弹层 */
  const [courseDialogOpen, setCourseDialogOpen] = useState(false);

  /** 收起提示条并清掉 history state */
  const dismissBanner = useCallback((): void => {
    setBannerVisible(false);
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, navigate]);

  // 6 秒后自动收起（手动点 × 走同一入口）
  useEffect(() => {
    if (importSuccess === undefined) return;
    const timer = setTimeout(dismissBanner, BANNER_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [importSuccess, dismissBanner]);

  const invalidateTree = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: contentTreeKey });
  }, [queryClient]);

  // ---------- 删除（题目软删 / 讲义物理删 / 空课程删） ----------

  const deleteMutation = useMutation({
    mutationFn: (target: DeletingTarget) => {
      if (target.kind === "question") return deleteQuestionApi(target.id);
      if (target.kind === "lecture") return deleteLectureApi(target.id);
      return deleteCourseApi(target.id);
    },
    onSuccess: async () => {
      setDeleting(null);
      setActionError(null);
      await invalidateTree();
    },
    onError: (err) => {
      setDeleting(null);
      setActionError(
        err instanceof Error ? err.message : "删除失败，请稍后重试",
      );
    },
  });

  // ---------- 拖拽排序：乐观更新 + 失败回滚 ----------

  const reorderMutation = useMutation({
    mutationFn: (input: { scope: ReorderScope; ids: string[] }) =>
      reorderContentApi(buildReorderPayload(input.scope.kind, input.ids)),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: contentTreeKey });
      const previous = queryClient.getQueryData<ContentTree>(contentTreeKey);
      if (previous !== undefined) {
        queryClient.setQueryData(
          contentTreeKey,
          applyReorder(previous, input.scope, input.ids),
        );
      }
      return { previous };
    },
    onError: (err, _input, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(contentTreeKey, context.previous);
      }
      setActionError(
        err instanceof Error
          ? `排序保存失败，已恢复原顺序：${err.message}`
          : "排序保存失败，已恢复原顺序，请稍后重试",
      );
    },
    onSettled: async () => {
      await invalidateTree();
    },
  });

  function handleReorder(scope: ReorderScope, orderedIds: string[]): void {
    setActionError(null);
    reorderMutation.mutate({ scope, ids: orderedIds });
  }

  const courseIds = treeQuery.data?.courses.map((course) => course.id) ?? [];

  return (
    <section className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">内容</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            已导入的讲义与练习单元，点开单元可查看题目摘要
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 px-4"
            onClick={() => setCourseDialogOpen(true)}
          >
            <FolderPlus aria-hidden />
            新建课程
          </Button>
          <Button asChild className="min-h-11 px-4">
            <Link to="/t/import">
              <Upload aria-hidden />
              导入内容
            </Link>
          </Button>
        </div>
      </header>

      {bannerVisible && importSuccess !== undefined && (
        <p
          role="status"
          className="mt-4 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-700 dark:text-emerald-300"
        >
          <span className="min-w-0 flex-1 break-all">{importSuccess}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={dismissBanner}
            className="-m-1 flex size-8 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-emerald-500/10 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X aria-hidden className="size-4" />
          </button>
        </p>
      )}

      {actionError !== null ? (
        <p
          role="alert"
          className="mt-4 flex items-start justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        >
          <span className="min-w-0 flex-1 break-all">{actionError}</span>
          <button
            type="button"
            aria-label="关闭错误提示"
            onClick={() => setActionError(null)}
            className="-m-1 flex size-8 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X aria-hidden className="size-4" />
          </button>
        </p>
      ) : null}

      <div className="mt-4">
        {treeQuery.isPending ? <TreeSkeleton /> : null}
        {treeQuery.isError ? (
          <TreeError
            message={
              treeQuery.error instanceof Error
                ? treeQuery.error.message
                : "网络异常，请稍后重试"
            }
            onRetry={() => void treeQuery.refetch()}
          />
        ) : null}
        {treeQuery.data !== undefined && treeQuery.data.courses.length === 0 ? (
          <TreeEmpty />
        ) : null}
        {treeQuery.data !== undefined && treeQuery.data.courses.length > 0 ? (
          <SortableZone
            ids={courseIds}
            ariaLabel="课程列表（拖拽把手调整顺序）"
            onReorder={(ids) => handleReorder({ kind: "course" }, ids)}
          >
            {treeQuery.data.courses.map((course) => (
              <SortableCourseSection
                key={course.id}
                course={course}
                onReorder={handleReorder}
                onEditLecture={setEditingLectureId}
                onDelete={setDeleting}
                onEditQuestion={setEditingQuestionId}
              />
            ))}
          </SortableZone>
        ) : null}
      </div>

      {/* 编辑抽屉 / 删除确认 / 新建课程（同一时刻至多一个弹层） */}
      {editingQuestionId !== null ? (
        <QuestionEditSheet
          questionId={editingQuestionId}
          onClose={() => setEditingQuestionId(null)}
        />
      ) : null}
      {editingLectureId !== null ? (
        <LectureEditSheet
          lectureId={editingLectureId}
          onClose={() => setEditingLectureId(null)}
        />
      ) : null}
      {deleting !== null ? (
        <DeleteConfirmDialog
          title={
            deleting.kind === "question"
              ? "删除题目"
              : deleting.kind === "lecture"
                ? "删除讲义"
                : "删除课程"
          }
          targetName={deleting.name}
          description={
            deleting.kind === "question"
              ? "删除后该题不再出现在列表中。题目为软删除：历史作答与统计保留，重新导入包含该题的文档即可恢复。"
              : deleting.kind === "lecture"
                ? "讲义将被永久删除（可重新导入恢复）。关联到这篇讲义的练习单元会自动解除关联，单元与题目不受影响。"
                : "删除后该课程不再出现。仅允许删除空课程（无讲义与练习单元）。"
          }
          pending={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleting)}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
      {courseDialogOpen ? (
        <NewCourseDialog onClose={() => setCourseDialogOpen(false)} />
      ) : null}
    </section>
  );
}

// ---------- 新建课程 ----------

function NewCourseDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () => createCourseApi({ title: title.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contentTreeKey });
      onClose();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "新建课程失败，请稍后重试");
    },
  });

  const canSubmit = title.trim().length > 0 && !createMutation.isPending;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderPlus aria-hidden className="size-4 text-muted-foreground" />
            新建课程
          </DialogTitle>
          <DialogDescription>
            课程是讲义与练习单元的分组（如「初一上」），可拖拽调整顺序。
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) {
              setError(null);
              createMutation.mutate();
            }
          }}
        >
          <label htmlFor="new-course-title" className="text-sm font-medium">
            课程名
          </label>
          <Input
            id="new-course-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="初一上"
            className="min-h-11"
            autoFocus
          />
          {error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 px-5"
              onClick={onClose}
              disabled={createMutation.isPending}
            >
              取消
            </Button>
            <Button
              type="submit"
              className="min-h-11 px-5"
              disabled={!canSubmit}
            >
              {createMutation.isPending ? "创建中…" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 课程分组 ----------

/** 课程分组的操作回调（编辑/删除由页面级状态承接；排序带作用域） */
interface CourseSectionActions {
  onReorder: (scope: ReorderScope, orderedIds: string[]) => void;
  onEditLecture: (id: string) => void;
  onDelete: (target: DeletingTarget) => void;
  onEditQuestion: (id: string) => void;
}

/** 可排序的课程分组：把手 + 标题（行内重命名）+ 删除（非空禁用） */
function SortableCourseSection({
  course,
  onReorder,
  onEditLecture,
  onDelete,
  onEditQuestion,
}: { course: ContentTreeCourse } & CourseSectionActions) {
  return (
    <SortableItem id={course.id}>
      {({ rowProps, handleListeners }) => (
        <section
          {...rowProps}
          className="mt-6 first:mt-0"
          aria-label={`课程：${course.title}`}
        >
          <CourseHeader
            course={course}
            handleListeners={handleListeners}
            onDelete={onDelete}
          />
          <CourseBody
            course={course}
            onReorder={onReorder}
            onEditLecture={onEditLecture}
            onDelete={onDelete}
            onEditQuestion={onEditQuestion}
          />
        </section>
      )}
    </SortableItem>
  );
}

/** 课程标题行：把手 + 标题（行内重命名）+ 删除按钮（有内容时禁用） */
function CourseHeader({
  course,
  handleListeners,
  onDelete,
}: {
  course: ContentTreeCourse;
  handleListeners: Record<string, unknown> | undefined;
  onDelete: (target: DeletingTarget) => void;
}) {
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(course.title);
  const [error, setError] = useState<string | null>(null);

  const renameMutation = useMutation({
    mutationFn: () => updateCourseApi(course.id, { title: draft.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contentTreeKey });
      setRenaming(false);
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "重命名失败，请稍后重试");
    },
  });

  const hasContent = course.lectures.length > 0 || course.units.length > 0;

  return (
    <div className="flex min-h-11 flex-wrap items-center gap-1.5">
      <DragHandle
        label={`拖拽调整课程「${course.title}」的顺序`}
        listeners={handleListeners}
      />
      {renaming ? (
        <form
          className="flex min-w-56 flex-1 flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim().length > 0 && draft.trim() !== course.title) {
              renameMutation.mutate();
            } else {
              setRenaming(false);
            }
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`课程「${course.title}」的新名称`}
            className="min-h-11 flex-1"
          />
          <Button
            type="submit"
            variant="ghost"
            className="size-11"
            aria-label="保存课程名"
            disabled={renameMutation.isPending}
          >
            <Check aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="size-11"
            aria-label="取消重命名"
            onClick={() => {
              setDraft(course.title);
              setRenaming(false);
              setError(null);
            }}
            disabled={renameMutation.isPending}
          >
            <X aria-hidden />
          </Button>
        </form>
      ) : (
        <>
          <h2 className="flex min-w-0 flex-1 items-center gap-2 text-base font-semibold">
            <BookOpen
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span className="truncate">{course.title}</span>
          </h2>
          <Button
            type="button"
            variant="ghost"
            className="size-11 shrink-0"
            aria-label={`重命名课程 ${course.title}`}
            onClick={() => {
              setDraft(course.title);
              setRenaming(true);
            }}
          >
            <PencilLine aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="size-11 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
            aria-label={`删除课程 ${course.title}`}
            title={
              hasContent
                ? "课程下还有讲义或练习单元，不能删除（先删除或移出它们）"
                : "删除空课程"
            }
            disabled={hasContent}
            onClick={() =>
              onDelete({ kind: "course", id: course.id, name: course.title })
            }
          >
            <Trash2 aria-hidden />
          </Button>
        </>
      )}
      {error !== null ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** 课程内容：讲义列表 + 练习单元列表（各自可拖拽排序） */
function CourseBody({
  course,
  onReorder,
  onEditLecture,
  onDelete,
  onEditQuestion,
}: { course: ContentTreeCourse } & CourseSectionActions) {
  const isEmpty = course.lectures.length === 0 && course.units.length === 0;

  return (
    <>
      {isEmpty ? (
        <p className="mt-2 rounded-lg bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground">
          本课程暂无讲义与练习。
        </p>
      ) : null}

      {course.lectures.length > 0 ? (
        <div className="mt-3">
          <h3 className="px-1 text-xs font-medium tracking-wide text-muted-foreground">
            讲义（{course.lectures.length}）
          </h3>
          <SortableZone
            ids={course.lectures.map((l) => l.id)}
            ariaLabel={`课程「${course.title}」的讲义列表`}
            onReorder={(ids) =>
              onReorder({ kind: "lecture", courseId: course.id }, ids)
            }
          >
            <ul className="mt-1.5 space-y-1.5">
              {course.lectures.map((lecture) => (
                <SortableLectureRow
                  key={lecture.id}
                  lecture={lecture}
                  onEdit={onEditLecture}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          </SortableZone>
        </div>
      ) : null}

      {course.units.length > 0 ? (
        <div className="mt-4">
          <h3 className="px-1 text-xs font-medium tracking-wide text-muted-foreground">
            练习单元（{course.units.length}）
          </h3>
          <SortableZone
            ids={course.units.map((u) => u.id)}
            ariaLabel={`课程「${course.title}」的练习单元列表`}
            onReorder={(ids) =>
              onReorder({ kind: "unit", courseId: course.id }, ids)
            }
          >
            <ul className="mt-1.5 space-y-1.5">
              {course.units.map((unit) => (
                <SortableUnitRow
                  key={unit.id}
                  unit={unit}
                  onReorder={onReorder}
                  onEditQuestion={onEditQuestion}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          </SortableZone>
        </div>
      ) : null}
    </>
  );
}

/** 可排序的讲义行：把手 + 标题 + 时间 + 编辑/删除 */
function SortableLectureRow({
  lecture,
  onEdit,
  onDelete,
}: {
  lecture: ContentTreeCourse["lectures"][number];
  onEdit: (id: string) => void;
  onDelete: (target: DeletingTarget) => void;
}) {
  return (
    <SortableItem id={lecture.id}>
      {({ rowProps, handleListeners }) => (
        <li
          {...rowProps}
          className="flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-card px-1.5 py-1.5"
        >
          <DragHandle
            label={`拖拽调整讲义「${lecture.title}」的顺序`}
            listeners={handleListeners}
          />
          <p className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
            {lecture.title}
          </p>
          <time
            dateTime={lecture.updatedAt}
            className="hidden shrink-0 text-xs text-muted-foreground sm:inline"
          >
            {formatRelativeTime(lecture.updatedAt)}
          </time>
          <Button
            type="button"
            variant="ghost"
            className="size-11 shrink-0"
            aria-label={`编辑讲义 ${lecture.title}`}
            onClick={() => onEdit(lecture.id)}
          >
            <PencilLine aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="size-11 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
            aria-label={`删除讲义 ${lecture.title}`}
            onClick={() =>
              onDelete({ kind: "lecture", id: lecture.id, name: lecture.title })
            }
          >
            <Trash2 aria-hidden />
          </Button>
        </li>
      )}
    </SortableItem>
  );
}

/** 可排序的练习单元行（展开显示题目摘要表） */
function SortableUnitRow({
  unit,
  onReorder,
  onEditQuestion,
  onDelete,
}: {
  unit: ContentTreeUnit;
  onReorder: CourseSectionActions["onReorder"];
  onEditQuestion: (id: string) => void;
  onDelete: (target: DeletingTarget) => void;
}) {
  return (
    <SortableItem id={unit.id}>
      {({ rowProps, handleListeners }) => (
        // 把手放在 details 之外：点把手只拖拽，不会折叠/展开单元
        <li {...rowProps} className="flex items-center gap-1">
          <DragHandle
            label={`拖拽调整单元「${unit.title}」的顺序`}
            listeners={handleListeners}
          />
          <details className="group min-w-0 flex-1 rounded-lg border border-border bg-card">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {unit.title}
              </span>
              {unit.topic !== null && (
                <span className="hidden max-w-40 truncate rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary sm:inline-block">
                  {unit.topic}
                </span>
              )}
              <span className="shrink-0 text-xs text-muted-foreground">
                {unit.questions.length} 题 ·{" "}
                {formatRelativeTime(unit.updatedAt)}
              </span>
            </summary>

            <div className="border-t border-border px-3 py-2">
              {unit.questions.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">
                  本单元暂无题目（题目可能已被删除）。
                </p>
              ) : (
                <SortableQuestionTable
                  unitId={unit.id}
                  unitTitle={unit.title}
                  questions={unit.questions}
                  onReorder={onReorder}
                  onEditQuestion={onEditQuestion}
                  onDelete={onDelete}
                />
              )}
            </div>
          </details>
        </li>
      )}
    </SortableItem>
  );
}

/** 可排序的题目摘要表：题号、题型徽章、难度、考点、version、操作 */
function SortableQuestionTable({
  unitId,
  unitTitle,
  questions,
  onReorder,
  onEditQuestion,
  onDelete,
}: {
  unitId: string;
  unitTitle: string;
  questions: ContentTreeUnit["questions"];
  onReorder: CourseSectionActions["onReorder"];
  onEditQuestion: (id: string) => void;
  onDelete: (target: DeletingTarget) => void;
}) {
  return (
    <SortableZone
      ids={questions.map((q) => q.id)}
      ariaLabel={`单元「${unitTitle}」的题目列表`}
      onReorder={(ids) => onReorder({ kind: "question", unitId }, ids)}
    >
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          单元内题目摘要（题号、题型、难度、考点、版本、操作）
        </caption>
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="w-11 py-1.5 font-medium">
              <span className="sr-only">排序把手</span>
            </th>
            <th scope="col" className="py-1.5 pr-2 font-medium">
              题号
            </th>
            <th scope="col" className="py-1.5 pr-2 font-medium">
              题型
            </th>
            <th scope="col" className="py-1.5 pr-2 font-medium">
              难度
            </th>
            <th scope="col" className="py-1.5 pr-2 font-medium">
              考点
            </th>
            <th scope="col" className="py-1.5 pr-2 font-medium">
              版本
            </th>
            <th scope="col" className="py-1.5 font-medium">
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {questions.map((question, index) => (
            <SortableQuestionRow
              key={question.id}
              question={question}
              index={index}
              onEditQuestion={onEditQuestion}
              onDelete={onDelete}
            />
          ))}
        </tbody>
      </table>
    </SortableZone>
  );
}

/** 单个可排序的题目行 */
function SortableQuestionRow({
  question,
  index,
  onEditQuestion,
  onDelete,
}: {
  question: ContentTreeUnit["questions"][number];
  index: number;
  onEditQuestion: (id: string) => void;
  onDelete: (target: DeletingTarget) => void;
}) {
  return (
    <SortableItem id={question.id}>
      {({ rowProps, handleListeners }) => (
        <tr {...rowProps} className="border-t border-border/60 align-middle">
          <td className="py-1 pl-0">
            <DragHandle
              label={`拖拽调整题目 ${question.id} 的顺序`}
              listeners={handleListeners}
            />
          </td>
          <th scope="row" className="py-2 pr-2 text-left font-normal">
            <span className="font-medium">{index + 1}</span>
            <span className="ml-1.5 text-xs break-all text-muted-foreground">
              {question.id}
            </span>
          </th>
          <td className="py-2 pr-2">
            <span
              className={cn(
                "inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
                QUESTION_TYPE_BADGE_CLASS[question.type],
              )}
            >
              {QUESTION_TYPE_LABELS[question.type]}
            </span>
          </td>
          <td
            className="py-2 pr-2 text-amber-500"
            aria-label={`难度 ${question.difficulty}/5`}
          >
            <span aria-hidden>{difficultyStars(question.difficulty)}</span>
          </td>
          <td className="py-2 pr-2">
            {question.knowledge.length === 0 ? (
              <span className="text-xs text-muted-foreground">—</span>
            ) : (
              <span className="flex flex-wrap gap-1">
                {question.knowledge.map((name) => (
                  <span
                    key={name}
                    className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                  >
                    {name}
                  </span>
                ))}
              </span>
            )}
          </td>
          <td className="py-2 pr-2 text-xs text-muted-foreground">
            v{question.version}
          </td>
          <td className="py-1 text-right whitespace-nowrap">
            <Button
              type="button"
              variant="ghost"
              className="size-11"
              aria-label={`编辑题目 ${question.id}`}
              onClick={() => onEditQuestion(question.id)}
            >
              <PencilLine aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="size-11 text-destructive hover:bg-destructive/10 hover:text-destructive"
              aria-label={`删除题目 ${question.id}`}
              onClick={() =>
                onDelete({
                  kind: "question",
                  id: question.id,
                  name: question.id,
                })
              }
            >
              <Trash2 aria-hidden />
            </Button>
          </td>
        </tr>
      )}
    </SortableItem>
  );
}

// ---------- 三态 ----------

/** 加载态：课程分组的骨架屏 */
function TreeSkeleton() {
  return (
    <div aria-live="polite" className="space-y-4">
      {[0, 1].map((i) => (
        <div key={i} className="animate-pulse space-y-3">
          <div className="h-6 w-40 rounded-md bg-muted" />
          <div className="h-11 rounded-lg bg-muted" />
          <div className="h-11 rounded-lg bg-muted" />
        </div>
      ))}
      <p className="text-center text-sm text-muted-foreground">正在加载内容…</p>
    </div>
  );
}

/** 错误态：原因 + 重试 */
function TreeError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-12 text-center"
    >
      <CircleAlert aria-hidden className="size-8 text-destructive" />
      <p className="text-sm font-medium text-destructive">内容加载失败</p>
      <p className="max-w-sm text-xs break-all text-muted-foreground">
        {message}
      </p>
      <Button variant="outline" className="min-h-11 px-6" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

/** 空态：解释 + 去导入页的动作入口 */
function TreeEmpty() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <FileStack aria-hidden className="size-10 text-muted-foreground" />
      <p className="text-sm font-medium">还没有导入任何内容</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        把练习或讲义的 Markdown 文档导入进来，就能布置作业、跟踪学情。
      </p>
      <Button asChild className="mt-2 min-h-11 px-5">
        <Link to="/t/import">
          <Plus aria-hidden />
          去导入第一份文档
        </Link>
      </Button>
    </div>
  );
}

// 供 App.tsx 路由级懒加载
export default ContentPage;
