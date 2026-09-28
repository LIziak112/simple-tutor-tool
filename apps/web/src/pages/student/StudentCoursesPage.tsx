import { BookOpen, ChevronRight, School } from "lucide-react";
import { Link } from "react-router";
import { useStudentCourses } from "@/features/student/student-queries";
import {
  StudentCourseCard,
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";

/**
 * /s/courses 我的课程页（T2A.5）：课程卡片列表（名称/简介/可见计数/进度条）。
 * 顶栏导航「课程」的落地页；卡片点击进入课程目录 /s/courses/:id。
 * 三态齐全；空态引导（未加入课程时说明去向）；「按讲义浏览」为讲义列表的二级入口。
 */
export default function StudentCoursesPage() {
  const coursesQuery = useStudentCourses();

  return (
    <section aria-label="我的课程" className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <School aria-hidden className="size-5 text-primary" />
          我的课程
        </h1>
        <Link
          to="/s/lectures"
          className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-primary outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <BookOpen aria-hidden className="size-4 shrink-0" />
          按讲义浏览
          <ChevronRight aria-hidden className="size-4 shrink-0" />
        </Link>
      </header>

      {coursesQuery.isPending && <StudentListSkeleton label="正在加载课程" />}

      {coursesQuery.isError && (
        <StudentErrorPanel
          title="课程加载失败"
          message={
            coursesQuery.error instanceof Error
              ? coursesQuery.error.message
              : "网络异常，请稍后重试"
          }
          onRetry={() => void coursesQuery.refetch()}
        />
      )}

      {coursesQuery.data &&
        (coursesQuery.data.courses.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
            <School aria-hidden className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">还没有加入课程</p>
            <p className="text-sm text-muted-foreground">
              请联系老师把你加入课程，课程里的讲义和练习会出现在这里。
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {coursesQuery.data.courses.map((course) => (
              <StudentCourseCard key={course.id} course={course} />
            ))}
          </ul>
        ))}
    </section>
  );
}
