import { ArrowLeft, BookOpen, ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { useStudentLectures } from "@/features/student/student-queries";
import {
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";
import { formatRelativeTime } from "@/lib/time";

/**
 * /s/lectures 讲义列表页（T2.3）：标题 + 主题/更新时间，按课程顺序。
 * 三态齐全；条目为触控目标 ≥44px 的整行链接（进入 /s/lectures/:id 阅读页）。
 */
export default function StudentLecturesPage() {
  const lecturesQuery = useStudentLectures();

  return (
    <section aria-label="讲义列表" className="flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <Link
          to="/s/home"
          aria-label="返回首页"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Link>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <BookOpen aria-hidden className="size-5 text-primary" />
          讲义
        </h1>
      </header>

      {lecturesQuery.isPending && <StudentListSkeleton label="正在加载讲义" />}

      {lecturesQuery.isError && (
        <StudentErrorPanel
          title="讲义加载失败"
          message={
            lecturesQuery.error instanceof Error
              ? lecturesQuery.error.message
              : "网络异常，请稍后重试"
          }
          onRetry={() => void lecturesQuery.refetch()}
        />
      )}

      {lecturesQuery.data &&
        (lecturesQuery.data.lectures.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
            <BookOpen aria-hidden className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">还没有讲义</p>
            <p className="text-sm text-muted-foreground">
              老师上传讲义后会出现在这里。
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {lecturesQuery.data.lectures.map((lecture) => (
              <li key={lecture.id}>
                <Link
                  to={`/s/lectures/${lecture.id}`}
                  className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-2 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {lecture.title}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-muted-foreground">
                    {lecture.topic && <span>{lecture.topic}</span>}
                    <span>{formatRelativeTime(lecture.updatedAt)}更新</span>
                  </span>
                  <ChevronRight
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                </Link>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
