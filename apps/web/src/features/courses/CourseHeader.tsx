import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  ClipboardPen,
  Loader2,
  Pencil,
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
import { portalCapabilitiesOf } from "@/features/auth/portals";
import { useTeacherMe } from "@/features/auth/teacher-auth";
import { ApiError } from "@/lib/api";
import {
  useCourseDetail,
  useDeleteCourse,
  useUpdateCourse,
} from "./course-queries";

// ---------- 头部：名称 / 简介 / 归档 / 删除 ----------

export function CourseHeader({
  courseId,
  name,
  description,
  archived,
  onEdit,
  onAssign,
  onDeleted,
}: {
  courseId: string;
  name: string;
  description: string | null;
  archived: boolean;
  onEdit: () => void;
  /** 布置作业：跳转作业页并预选本课程（T2A.7 课程页入口） */
  onAssign: () => void;
  onDeleted: () => void;
}) {
  const me = useTeacherMe();
  const capabilities = portalCapabilitiesOf(
    "teacher",
    me.data?.accountKind ?? "personal",
  );
  const updateMutation = useUpdateCourse(courseId);
  const deleteMutation = useDeleteCourse();
  const [actionError, setActionError] = useState<string | null>(null);
  const busy = updateMutation.isPending || deleteMutation.isPending;

  return (
    <header className="grid grid-cols-1 items-start gap-3 rounded-xl border border-border bg-card p-4 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Link
          to="/t/courses"
          className="flex min-h-11 items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft aria-hidden className="size-4" />
          课程
        </Link>
        <h1 className="min-w-0 break-words text-xl font-semibold">{name}</h1>
        {archived && (
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            已归档（学生不可见）
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="min-h-11" onClick={onEdit}>
          <Pencil aria-hidden />
          编辑信息
        </Button>
        {capabilities.assignments && (
          <Button variant="outline" className="min-h-11" onClick={onAssign}>
            <ClipboardPen aria-hidden />
            布置作业
          </Button>
        )}
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
      {description && (
        <p className="break-words text-sm text-muted-foreground lg:col-span-2">
          {description}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-1 lg:col-span-2">
        <DeleteCourseButton
          courseId={courseId}
          name={name}
          busy={busy}
          onDeleted={onDeleted}
          onError={setActionError}
        />
      </div>
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}
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
          该课程已有作答记录或布置的作业，删除不可用——请改用「归档」。
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
                          ? "该课程已有作答记录或布置的作业，不能删除；请改用归档"
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
