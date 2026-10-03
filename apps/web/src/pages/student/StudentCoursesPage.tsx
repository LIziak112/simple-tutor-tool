import { BookOpen, ChevronRight, School } from "lucide-react";
import { Link } from "react-router";
import { useStudentCourses } from "@/features/student/student-queries";
import {
  StudentCourseCard,
  StudentEmptyState,
  StudentErrorPanel,
  StudentListSkeleton,
  StudentPageHeader,
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
      <StudentPageHeader
        icon={<School />}
        title="我的课程"
        description="点进课程看讲义、做练习。"
        actions={
          <Link
            to="/s/lectures"
            className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-primary outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <BookOpen aria-hidden className="size-4 shrink-0" />
            按讲义浏览
            <ChevronRight aria-hidden className="size-4 shrink-0" />
          </Link>
        }
      />

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
          <StudentEmptyState
            icon={<School />}
            title="还没有加入课程"
            description="请联系老师把你加入课程，课程里的讲义和练习会出现在这里。"
          />
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
