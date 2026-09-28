import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  Loader2,
  Pencil,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
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
import { CourseCatalogTab } from "@/features/courses/CourseCatalogTab";
import { CourseMembersTab } from "@/features/courses/CourseMembersTab";
import { CourseProgressTab } from "@/features/courses/CourseProgressTab";
import {
  useCourseDetail,
  useDeleteCourse,
  useUpdateCourse,
} from "@/features/courses/course-queries";
import { ApiError } from "@/lib/api";

/**
 * /t/courses/:id 课程编辑页（T2A.4）：页签 = 目录 / 成员 / 进度（占位，T2A.6 填充）。
 * 头部：课程名与简介（可编辑）、归档/恢复、删除（D4）；三态齐全。
 */

type Tab = "catalog" | "members" | "progress";

const TABS: { key: Tab; label: string }[] = [
  { key: "catalog", label: "目录" },
  { key: "members", label: "成员" },
  { key: "progress", label: "进度" },
];

export function CourseEditPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const detailQuery = useCourseDetail(id);
  const [tab, setTab] = useState<Tab>("catalog");
  const [editOpen, setEditOpen] = useState(false);

  if (detailQuery.isPending) {
    return (
      <div
        role="status"
        aria-label="正在加载课程"
        className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8"
      >
        <div className="h-24 animate-pulse rounded-xl bg-muted/50" />
        <div className="h-96 animate-pulse rounded-xl bg-muted/50" />
        <p className="text-sm text-muted-foreground">正在加载课程…</p>
      </div>
    );
  }

  if (detailQuery.isError) {
    const err = detailQuery.error;
    return (
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-10 md:px-6">
        <Link
          to="/t/courses"
          className="flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft aria-hidden className="size-4" />
          返回课程列表
        </Link>
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            课程加载失败
          </p>
          <p className="text-sm text-muted-foreground">
            {err instanceof Error ? err.message : "网络异常，请稍后重试"}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => void detailQuery.refetch()}
          >
            重试
          </Button>
        </div>
      </section>
    );
  }

  const detail = detailQuery.data;

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <CourseHeader
        courseId={detail.id}
        name={detail.name}
        description={detail.description}
        archived={detail.archived}
        onEdit={() => setEditOpen(true)}
        onDeleted={() => void navigate("/t/courses")}
      />

      <div role="tablist" aria-label="课程页签" className="flex gap-2">
        {TABS.map((item) => (
          <Button
            key={item.key}
            role="tab"
            aria-selected={tab === item.key}
            variant={tab === item.key ? "secondary" : "ghost"}
            className="min-h-11"
            onClick={() => setTab(item.key)}
          >
            {item.label}
            {item.key === "members" && `（${detail.members.length}）`}
          </Button>
        ))}
      </div>

      {tab === "catalog" && (
        <CourseCatalogTab courseId={detail.id} detail={detail} />
      )}
      {tab === "members" && (
        <CourseMembersTab courseId={detail.id} detail={detail} />
      )}
      {tab === "progress" && <CourseProgressTab courseId={detail.id} />}

      {editOpen && (
        <EditCourseDialog
          courseId={detail.id}
          name={detail.name}
          description={detail.description}
          onClose={() => setEditOpen(false)}
        />
      )}
    </section>
  );
}

// ---------- 头部：名称 / 简介 / 归档 / 删除 ----------

function CourseHeader({
  courseId,
  name,
  description,
  archived,
  onEdit,
  onDeleted,
}: {
  courseId: string;
  name: string;
  description: string | null;
  archived: boolean;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const updateMutation = useUpdateCourse(courseId);
  const deleteMutation = useDeleteCourse();
  const [actionError, setActionError] = useState<string | null>(null);
  const busy = updateMutation.isPending || deleteMutation.isPending;

  return (
    <header className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/t/courses"
          className="flex min-h-11 items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft aria-hidden className="size-4" />
          课程
        </Link>
        <h1 className="text-xl font-semibold">{name}</h1>
        {archived && (
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            已归档（学生不可见）
          </span>
        )}
      </div>
      {description && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="min-h-11" onClick={onEdit}>
          <Pencil aria-hidden />
          编辑信息
        </Button>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={() =>
            updateMutation.mutate(
              { archived: !archived },
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
          {archived ? (
            <>
              <ArchiveRestore aria-hidden />
              恢复课程
            </>
          ) : (
            <>
              <Archive aria-hidden />
              归档
            </>
          )}
        </Button>
      </div>
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}
      <DeleteCourseButton
        courseId={courseId}
        name={name}
        busy={busy}
        onDeleted={onDeleted}
        onError={setActionError}
      />
    </header>
  );
}

/** 详情页的删除入口（hasAttempts 已知 → 按钮禁用并说明，D4） */
function DeleteCourseButton({
  courseId,
  name,
  busy,
  onDeleted,
  onError,
}: {
  courseId: string;
  name: string;
  busy: boolean;
  onDeleted: () => void;
  onError: (message: string) => void;
}) {
  const detailQuery = useCourseDetail(courseId);
  const deleteMutation = useDeleteCourse();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const hasAttempts = detailQuery.data?.hasAttempts ?? false;

  return (
    <>
      <Button
        variant="ghost"
        className="min-h-11 self-start px-3 text-destructive hover:text-destructive"
        disabled={busy}
        aria-disabled={hasAttempts || undefined}
        onClick={() => setConfirmOpen(true)}
      >
        删除课程
      </Button>
      {hasAttempts && (
        <p className="text-xs text-muted-foreground">
          该课程下的练习已有作答记录，删除不可用——请改用「归档」。
        </p>
      )}
      {confirmOpen && (
        <Dialog open onOpenChange={(open) => !open && setConfirmOpen(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>删除课程「{name}」？</DialogTitle>
              <DialogDescription>
                删除后目录编排与成员关系会一并移除；资源库内容与已交卷的作答记录不受影响。
                此操作不可撤销。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setConfirmOpen(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                variant="destructive"
                className="min-h-11 px-4"
                disabled={deleteMutation.isPending}
                onClick={() => {
                  deleteMutation.mutate(courseId, {
                    onSuccess: () => {
                      setConfirmOpen(false);
                      onDeleted();
                    },
                    onError: (err) => {
                      setConfirmOpen(false);
                      onError(
                        err instanceof ApiError &&
                          err.code === "COURSE_HAS_ATTEMPTS"
                          ? "该课程下的练习已有作答记录，不能删除；请改用归档"
                          : err instanceof Error
                            ? err.message
                            : "删除失败，请稍后重试",
                      );
                    },
                  });
                }}
              >
                {deleteMutation.isPending ? (
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
      )}
    </>
  );
}

/** 编辑课程名 / 简介（§4-5：无未保存关闭确认需求——表单即内容，取消不保存） */
function EditCourseDialog({
  courseId,
  name,
  description,
  onClose,
}: {
  courseId: string;
  name: string;
  description: string | null;
  onClose: () => void;
}) {
  const [nextName, setNextName] = useState(name);
  const [nextDescription, setNextDescription] = useState(description ?? "");
  const updateMutation = useUpdateCourse(courseId);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑课程信息</DialogTitle>
          <DialogDescription>课程名与简介会展示给学生。</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            updateMutation.mutate(
              {
                name: nextName.trim(),
                ...(nextDescription.trim().length > 0
                  ? { description: nextDescription.trim() }
                  : { description: null }),
              },
              { onSuccess: onClose },
            );
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-course-name" className="text-sm">
              课程名
            </label>
            <Input
              id="edit-course-name"
              value={nextName}
              onChange={(e) => setNextName(e.target.value)}
              required
              maxLength={100}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-course-description" className="text-sm">
              简介（可选，清空则删除）
            </label>
            <Input
              id="edit-course-description"
              value={nextDescription}
              onChange={(e) => setNextDescription(e.target.value)}
              maxLength={500}
            />
          </div>
          {updateMutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              {updateMutation.error instanceof Error
                ? updateMutation.error.message
                : "保存失败，请稍后重试"}
            </p>
          )}
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
              disabled={
                updateMutation.isPending || nextName.trim().length === 0
              }
            >
              {updateMutation.isPending ? (
                <>
                  <Loader2 aria-hidden className="animate-spin" />
                  正在保存…
                </>
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

// 供 App.tsx 路由级懒加载
export default CourseEditPage;
