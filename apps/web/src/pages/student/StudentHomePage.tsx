import { BookOpen, ChevronRight, ClipboardList, School } from "lucide-react";
import { Link } from "react-router";
import {
  useStudentAssignments,
  useStudentCourses,
} from "@/features/student/student-queries";
import {
  StudentAssignmentCard,
  StudentCourseCard,
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";

/**
 * /s/home 学生首页（T2A.5 改版）：待完成作业 + 我的课程卡片（进度条占位）。
 * - 「我的作业」：作业卡片（标题/单元/题数/截止北京时间/状态徽章；答题入口 T2.6 开放）；
 * - 「我的课程」：课程卡片（名称/简介/可见讲义与练习计数/进度条——T2A.6 前恒 0），
 *   分区标题右侧「按讲义浏览」进入二级讲义列表页（顶栏不再有讲义入口）。
 * 布局：竖屏单栏；横屏（lg:）左右双栏（作业在左、课程在右）。
 * 顶部姓名与退出在 StudentLayout（本页不再重复）。
 */

export default function StudentHomePage() {
  const assignmentsQuery = useStudentAssignments();
  const coursesQuery = useStudentCourses();

  return (
    <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-8">
      {/* 我的作业（主区，占 3/5） */}
      <section aria-labelledby="home-assignments" className="lg:w-3/5">
        <h2
          id="home-assignments"
          className="mb-3 flex items-center gap-2 text-base font-semibold"
        >
          <ClipboardList aria-hidden className="size-5 text-primary" />
          我的作业
        </h2>

        {assignmentsQuery.isPending && (
          <StudentListSkeleton label="正在加载作业" />
        )}
        {assignmentsQuery.isError && (
          <StudentErrorPanel
            title="作业加载失败"
            message={
              assignmentsQuery.error instanceof Error
                ? assignmentsQuery.error.message
                : "网络异常，请稍后重试"
            }
            onRetry={() => void assignmentsQuery.refetch()}
          />
        )}
        {assignmentsQuery.data &&
          (assignmentsQuery.data.assignments.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card px-6 py-10 text-center">
              <p className="text-sm font-medium">现在没有待完成的作业</p>
              <p className="mt-1 text-sm text-muted-foreground">
                老师布置作业后会出现在这里，也可以先去课程里看看讲义。
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {assignmentsQuery.data.assignments.map((assignment) => (
                <StudentAssignmentCard
                  key={assignment.id}
                  assignment={assignment}
                />
              ))}
            </ul>
          ))}
      </section>

      {/* 我的课程（侧区，占 2/5；「我的记录」入口在顶栏导航） */}
      <section aria-labelledby="home-courses" className="lg:w-2/5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2
            id="home-courses"
            className="flex items-center gap-2 text-base font-semibold"
          >
            <School aria-hidden className="size-5 text-primary" />
            我的课程
          </h2>
          {/* 讲义列表的二级入口（顶栏导航已无讲义项） */}
          <Link
            to="/s/lectures"
            className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <BookOpen aria-hidden className="size-4 shrink-0" />
            按讲义浏览
            <ChevronRight aria-hidden className="size-4 shrink-0" />
          </Link>
        </div>

        {coursesQuery.isPending && (
          <StudentListSkeleton label="正在加载课程" rows={2} />
        )}
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
            <div className="rounded-xl border border-dashed border-border bg-card px-6 py-8 text-center">
              <p className="text-sm font-medium">还没有加入课程</p>
              <p className="mt-1 text-sm text-muted-foreground">
                老师把你加入课程后，这里的讲义和练习会自动出现。
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
    </div>
  );
}
