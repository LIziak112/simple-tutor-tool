import { ChevronLeft, TriangleAlert } from "lucide-react";
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
import { CourseAttachmentsTab } from "@/features/attachments/CourseAttachmentsTab";
import { CourseCatalogTab } from "@/features/courses/CourseCatalogTab";
import { CourseHeader } from "@/features/courses/CourseHeader";
import { CourseMembersTab } from "@/features/courses/CourseMembersTab";
import { CourseProgressTab } from "@/features/courses/CourseProgressTab";
import { CourseReviewSettings } from "@/features/courses/CourseReviewSettings";
import {
  useCourseDetail,
  useUpdateCourse,
} from "@/features/courses/course-queries";

/**
 * /t/courses/:id 课程编辑页（T2A.4）：页签 = 目录 / 成员 / 进度（占位，T2A.6 填充）。
 * 头部：课程名与简介（可编辑）、归档/恢复、删除（D4）；三态齐全。
 */

type Tab = "catalog" | "attachments" | "members" | "progress";

const TABS: { key: Tab; label: string }[] = [
  { key: "catalog", label: "目录" },
  { key: "attachments", label: "资料" },
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
        className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-3 md:px-6 md:py-4"
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
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-3 md:px-6 md:py-4">
      <CourseHeader
        courseId={detail.id}
        name={detail.name}
        description={detail.description}
        archived={detail.archived}
        onEdit={() => setEditOpen(true)}
        onAssign={() =>
          void navigate(
            `/t/assignments?courseId=${encodeURIComponent(detail.id)}&compose=1`,
          )
        }
        onDeleted={() => void navigate("/t/courses")}
      />

      <CourseReviewSettings
        key={detail.id}
        courseId={detail.id}
        examType={detail.examType}
        reviewTemplateId={detail.reviewTemplateId}
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
      {tab === "attachments" && <CourseAttachmentsTab courseId={detail.id} />}
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
              busy={updateMutation.isPending}
              type="submit"
              className="min-h-11 px-4"
              disabled={
                updateMutation.isPending || nextName.trim().length === 0
              }
            >
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// 供 App.tsx 路由级懒加载
export default CourseEditPage;
