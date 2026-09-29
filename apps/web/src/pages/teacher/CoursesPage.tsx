import type { CourseSummary } from "@tutor/contract";
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  GraduationCap,
  Loader2,
  Plus,
  TriangleAlert,
  Users,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
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
  useCreateCourse,
  useDeleteCourse,
  useTeacherCourses,
  useUpdateCourse,
} from "@/features/courses/course-queries";
import { ApiError } from "@/lib/api";
import { formatRelativeTime } from "@/lib/time";

/**
 * /t/courses 课程列表页（T2A.4）：课程卡片（名称、成员数、条目数、可见条目数）、
 * 新建、归档筛选（默认未归档，可切已归档）、归档/恢复、删除（D4：有作答或
 * 作业时服务端 409 COURSE_HAS_ATTEMPTS，弹层先说清影响）。三态齐全，触控 ≥44px。
 */

export function CoursesPage() {
  const [archived, setArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const coursesQuery = useTeacherCourses(archived);

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">课程</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            课程 = 一份有序目录（讲义与练习单元）+
            成员。学生只能看到所在课程中可见的内容。
          </p>
        </div>
        <Button className="min-h-11 px-4" onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden />
          新建课程
        </Button>
      </header>

      <div className="flex items-center justify-between gap-3">
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {coursesQuery.data
            ? `共 ${coursesQuery.data.courses.length} 门${archived ? "已归档" : ""}课程`
            : "…"}
        </p>
        <Button
          variant="outline"
          className="min-h-11"
          aria-pressed={archived}
          onClick={() => setArchived((v) => !v)}
        >
          {archived ? "只看未归档" : "查看已归档"}
        </Button>
      </div>

      {coursesQuery.isPending && <CoursesSkeleton />}

      {coursesQuery.isError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            课程加载失败
          </p>
          <p className="text-sm text-muted-foreground">
            {coursesQuery.error instanceof Error
              ? coursesQuery.error.message
              : "网络异常，请稍后重试"}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => void coursesQuery.refetch()}
          >
            重试
          </Button>
        </div>
      )}

      {coursesQuery.data &&
        (coursesQuery.data.courses.length === 0 ? (
          <CoursesEmpty
            archived={archived}
            onCreate={() => setCreateOpen(true)}
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {coursesQuery.data.courses.map((course) => (
              <CourseCard key={course.id} course={course} />
            ))}
          </ul>
        ))}

      {createOpen && (
        <CreateCourseDialog onClose={() => setCreateOpen(false)} />
      )}
    </section>
  );
}

// ---------- 加载 / 空态 ----------

function CoursesSkeleton() {
  return (
    <div
      role="status"
      aria-label="正在加载课程"
      className="grid gap-3 sm:grid-cols-2"
    >
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-44 animate-pulse rounded-xl border border-border bg-muted/50"
        />
      ))}
      <p className="sr-only">正在加载课程…</p>
    </div>
  );
}

function CoursesEmpty({
  archived,
  onCreate,
}: {
  archived: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
      <GraduationCap aria-hidden className="size-10 text-muted-foreground" />
      <p className="text-sm font-medium">
        {archived ? "还没有已归档的课程" : "还没有课程"}
      </p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {archived
          ? "归档的课程会出现在这里，可随时恢复。"
          : "新建一门课程，再从资源库添加讲义与练习，学生就能按顺序学习。"}
      </p>
      {!archived && (
        <Button className="min-h-11 px-4" onClick={onCreate}>
          <Plus aria-hidden />
          新建课程
        </Button>
      )}
    </div>
  );
}

// ---------- 课程卡片 ----------

function CourseCard({ course }: { course: CourseSummary }) {
  const navigate = useNavigate();
  const updateMutation = useUpdateCourse(course.id);
  const deleteMutation = useDeleteCourse();
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 删除/归档操作的错误提示（如 409 COURSE_HAS_ATTEMPTS） */
  const [actionError, setActionError] = useState<string | null>(null);

  const busy = updateMutation.isPending || deleteMutation.isPending;

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground">
      <button
        type="button"
        className="flex min-h-11 flex-col items-start gap-1 rounded-lg text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={() => void navigate(`/t/courses/${course.id}`)}
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold">{course.name}</span>
          {course.archived && (
            <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              已归档
            </span>
          )}
          {course.hasAttempts && (
            <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs text-primary">
              有作答或作业
            </span>
          )}
        </span>
        {course.description && (
          <span className="line-clamp-2 text-sm text-muted-foreground">
            {course.description}
          </span>
        )}
      </button>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="flex items-center gap-1">
          <Users aria-hidden className="size-4" />
          成员 {course.memberCount}
        </span>
        <span className="flex items-center gap-1">
          <BookOpen aria-hidden className="size-4" />
          条目 {course.itemCount}（可见 {course.visibleItemCount}）
        </span>
        <span className="ml-auto text-xs">
          {formatRelativeTime(course.createdAt)}创建
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={() =>
            updateMutation.mutate(
              { archived: !course.archived },
              {
                onSuccess: () => setActionError(null),
                onError: (err) =>
                  setActionError(
                    err instanceof Error ? err.message : "操作失败",
                  ),
              },
            )
          }
        >
          {course.archived ? (
            <>
              <ArchiveRestore aria-hidden />
              恢复
            </>
          ) : (
            <>
              <Archive aria-hidden />
              归档
            </>
          )}
        </Button>
        <Button
          variant="outline"
          className="min-h-11 text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
        >
          删除
        </Button>
      </div>

      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}

      {confirmDelete && (
        <DeleteCourseDialog
          course={course}
          busy={deleteMutation.isPending}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => {
            deleteMutation.mutate(course.id, {
              onSuccess: () => {
                setConfirmDelete(false);
                setActionError(null);
              },
              onError: (err) => {
                setConfirmDelete(false);
                setActionError(
                  err instanceof ApiError && err.code === "COURSE_HAS_ATTEMPTS"
                    ? "该课程已有作答记录或布置的作业，不能删除；请改用归档"
                    : err instanceof Error
                      ? err.message
                      : "删除失败，请稍后重试",
                );
              },
            });
          }}
        />
      )}
    </li>
  );
}

/** 删除课程确认弹层（§4-1 影响先说清） */
function DeleteCourseDialog({
  course,
  busy,
  onClose,
  onConfirm,
}: {
  course: CourseSummary;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除课程「{course.name}」？</DialogTitle>
          <DialogDescription>
            删除后该课程的目录编排（{course.itemCount} 个条目）与成员关系 （
            {course.memberCount} 名学生）会一并移除；资源库中的讲义与练习单元
            <strong>不受影响</strong>，已交卷的作答记录也会保留。
          </DialogDescription>
        </DialogHeader>
        {course.hasAttempts && (
          <p
            role="alert"
            className="rounded-lg bg-muted px-3 py-2 text-sm text-destructive"
          >
            该课程已有作答记录或布置的作业，删除会被拒绝——请改用「归档」（学生看不到，数据保留）。
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="min-h-11 px-4"
            disabled={busy || course.hasAttempts}
            onClick={onConfirm}
          >
            {busy ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                正在删除…
              </>
            ) : (
              "确认删除"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 新建课程 ----------

function CreateCourseDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const createMutation = useCreateCourse();
  const navigate = useNavigate();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    createMutation.mutate(
      {
        title: name.trim(),
        ...(description.trim().length > 0
          ? { description: description.trim() }
          : {}),
      },
      {
        onSuccess: (data) => {
          onClose();
          // 新建后直达编辑页，引导「从资源库添加」
          void navigate(`/t/courses/${data.id}`);
        },
      },
    );
  }

  const errorMessage = createMutation.isError
    ? createMutation.error instanceof Error
      ? createMutation.error.message
      : "创建失败，请稍后重试"
    : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建课程</DialogTitle>
          <DialogDescription>
            创建后可从资源库添加讲义与练习单元，再把学生加为成员。
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="course-name" className="text-sm">
              课程名
            </label>
            <Input
              id="course-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：初一上·有理数"
              required
              maxLength={100}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="course-description" className="text-sm">
              简介（可选）
            </label>
            <Input
              id="course-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="给学生看的一句话说明"
              maxLength={500}
            />
          </div>
          {errorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={onClose}
              disabled={createMutation.isPending}
            >
              取消
            </Button>
            <Button
              type="submit"
              className="min-h-11 px-4"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 aria-hidden className="animate-spin" />
                  正在创建…
                </>
              ) : (
                <>
                  <Plus aria-hidden />
                  创建
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// 供 App.tsx 路由级懒加载
export default CoursesPage;
