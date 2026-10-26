import type { StudentCourseItem } from "@tutor/contract";
import {
  ArrowLeft,
  BookOpen,
  CircleCheck,
  LoaderCircle,
  School,
} from "lucide-react";
import { Link, useParams } from "react-router";
import { formatResultCounts } from "@/features/attempt/result-counts";
import { StudentCourseCatalog } from "@/features/student/StudentCourseCatalog";
import { useStudentCourse } from "@/features/student/student-queries";
import {
  StudentEmptyState,
  StudentErrorPanel,
  StudentListSkeleton,
  StudentSectionLink,
} from "@/features/student/student-ui";
import { ApiError } from "@/lib/api";

/**
 * /s/courses/:id 课程目录页（T2A.5；T2A.6 单元项接入作答）：
 * 分节标题（仅文字）、讲义项（进入阅读页，带 courseId 上下文）、单元项
 * （进入单元落地页——开始/继续/再做一次与历次记录，D10）。
 * 单元项状态（D10）：未做 / 进行中 / 已完成（最近做对 X / N 题 · 共 n 次）/ 有待批。
 * 越权（D22）：非成员/课程已归档 → 403 COURSE_ACCESS_DENIED，展示中文引导
 * （可能已被移出）；课程不存在 → 404（服务端不暴露存在性，前端统一「打不开了」）。
 */

/** 单元项状态徽章（attempt 摘要 → 展示文案；优先级：待批 > 进行中 > 已完成 > 未做） */
function UnitStatusBadge({ item }: { item: StudentCourseItem }) {
  const attempt = item.attempt;
  if (attempt === null || attempt.count === 0) {
    return (
      <span className="w-fit shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
        未做
      </span>
    );
  }
  if (attempt.pendingCount > 0) {
    return (
      <span className="w-fit shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
        有待批
      </span>
    );
  }
  if (attempt.hasDraft) {
    return (
      <span className="flex w-fit shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
        <LoaderCircle aria-hidden className="size-3.5" />
        进行中
      </span>
    );
  }
  return (
    <span className="flex w-fit shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
      <CircleCheck aria-hidden className="size-3.5" />
      已完成（最近 {formatResultCounts(attempt.latestResultCounts)} · 共{" "}
      {attempt.count} 次）
    </span>
  );
}
export default function StudentCourseDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const courseQuery = useStudentCourse(id);

  const accessDenied =
    courseQuery.error instanceof ApiError &&
    courseQuery.error.code === "COURSE_ACCESS_DENIED";

  return (
    <section aria-label="课程目录" className="flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <Link
          to="/s/courses"
          aria-label="返回我的课程"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Link>
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 break-words text-lg font-semibold">
            <School aria-hidden className="size-5 shrink-0 text-primary" />
            {courseQuery.data?.name ?? "课程"}
          </h1>
          {courseQuery.data?.description && (
            <p className="break-words text-xs text-muted-foreground">
              {courseQuery.data.description}
            </p>
          )}
        </div>
      </header>

      {courseQuery.isPending && (
        <StudentListSkeleton label="正在加载课程目录" />
      )}

      {courseQuery.isError &&
        (accessDenied ? (
          <div
            role="alert"
            className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
          >
            <p className="text-sm font-medium">暂时看不到这门课</p>
            <p className="text-sm text-muted-foreground">
              你可能已被移出这门课，或课程已结束归档。有疑问请联系老师。
            </p>
            <Link
              to="/s/courses"
              className="flex min-h-11 items-center rounded-lg border border-border px-4 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              返回我的课程
            </Link>
          </div>
        ) : (
          <StudentErrorPanel
            title="课程目录加载失败"
            message={
              courseQuery.error instanceof Error
                ? courseQuery.error.message
                : "网络异常，请稍后重试"
            }
            onRetry={() => void courseQuery.refetch()}
          />
        ))}

      {courseQuery.data &&
        (courseQuery.data.items.length === 0 ? (
          <StudentEmptyState
            icon={<BookOpen />}
            title="老师还没有发布内容"
            description="课程内容发布后会自动出现在这里。"
            action={
              <StudentSectionLink to="/s/courses">
                返回我的课程
              </StudentSectionLink>
            }
          />
        ) : (
          <StudentCourseCatalog
            key={courseQuery.data.id}
            course={courseQuery.data}
            renderStatus={(item) => <UnitStatusBadge item={item} />}
          />
        ))}
    </section>
  );
}
