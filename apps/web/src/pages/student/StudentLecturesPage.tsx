import { ArrowLeft, BookOpen, ChevronRight, School } from "lucide-react";
import { Link } from "react-router";
import { useStudentLectures } from "@/features/student/student-queries";
import {
  StudentEmptyState,
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";
import { formatRelativeTime } from "@/lib/time";

/**
 * /s/lectures 讲义列表页（T2.3；T2A.5 按课程分组 + D5 过滤）。
 * 顶栏导航已无讲义入口：本页经首页/课程页的「按讲义浏览」进入（二级页面）。
 * 数据用分组视图（courses）：只列出有可见讲义的课程组，组内按目录条目顺序；
 * 点击进入阅读页（缺省课程上下文——服务端取第一个可见该讲义的课程）。
 * 三态齐全；条目为触控目标 ≥44px 的整行链接。
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
        (lecturesQuery.data.courses.length === 0 ? (
          <StudentEmptyState
            icon={<BookOpen />}
            title="还没有可看的讲义"
            description="老师把你加入课程并发布讲义后，这里会按课程分组展示。"
          />
        ) : (
          lecturesQuery.data.courses.map((group) => (
            <section
              key={group.courseId}
              aria-label={`课程 ${group.courseName} 的讲义`}
              className="flex flex-col gap-2"
            >
              <h2 className="flex items-center gap-2 pt-2 text-sm font-semibold text-muted-foreground">
                <School aria-hidden className="size-4 shrink-0" />
                {group.courseName}
              </h2>
              <ul className="flex flex-col gap-2">
                {group.lectures.map((lecture) => (
                  <li key={lecture.id}>
                    <Link
                      to={`/s/lectures/${lecture.id}?courseId=${group.courseId}`}
                      className="flex min-h-14 items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-2 shadow-xs outline-none transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-3 focus-visible:ring-ring/50"
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
            </section>
          ))
        ))}
    </section>
  );
}
