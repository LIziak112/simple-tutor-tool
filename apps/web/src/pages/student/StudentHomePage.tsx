import { BookOpen, ChevronRight, ClipboardList, History } from "lucide-react";
import { Link } from "react-router";
import {
  useStudentAssignments,
  useStudentLectures,
} from "@/features/student/student-queries";
import {
  StudentAssignmentCard,
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";

/**
 * /s/home 学生首页（T2.3）：三个分区入口。
 * - 「我的作业」：作业卡片（标题/单元/题数/截止北京时间/状态徽章；答题入口 T2.6 开放）；
 * - 「讲义」：最近 3 篇摘要 + 查看全部；
 * - 「我的记录」：入口（T3.5 实现，先占位）。
 * 布局：竖屏单栏；横屏（lg:）左右双栏（作业在左、讲义与记录在右）。
 * 顶部姓名与退出在 StudentLayout（本页不再重复）。
 */

/** 首页展示的讲义摘要条数（全部见 /s/lectures） */
const HOME_LECTURE_LIMIT = 3;

export default function StudentHomePage() {
  const assignmentsQuery = useStudentAssignments();
  const lecturesQuery = useStudentLectures();

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
                老师布置作业后会出现在这里，也可以先看看讲义。
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

      {/* 讲义 + 我的记录（侧区，占 2/5） */}
      <div className="flex flex-col gap-8 lg:w-2/5">
        <section aria-labelledby="home-lectures">
          <h2
            id="home-lectures"
            className="mb-3 flex items-center gap-2 text-base font-semibold"
          >
            <BookOpen aria-hidden className="size-5 text-primary" />
            讲义
          </h2>

          {lecturesQuery.isPending && (
            <StudentListSkeleton label="正在加载讲义" rows={2} />
          )}
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
              <div className="rounded-xl border border-dashed border-border bg-card px-6 py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  老师还没有上传讲义
                </p>
              </div>
            ) : (
              <>
                <ul className="flex flex-col gap-2">
                  {lecturesQuery.data.lectures
                    .slice(0, HOME_LECTURE_LIMIT)
                    .map((lecture) => (
                      <li key={lecture.id}>
                        <Link
                          to={`/s/lectures/${lecture.id}`}
                          className="flex min-h-11 items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          <span className="min-w-0 truncate">
                            {lecture.title}
                          </span>
                          {lecture.topic && (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {lecture.topic}
                            </span>
                          )}
                        </Link>
                      </li>
                    ))}
                </ul>
                {lecturesQuery.data.lectures.length > HOME_LECTURE_LIMIT && (
                  <Link
                    to="/s/lectures"
                    className="mt-2 flex min-h-11 items-center justify-center gap-1 rounded-xl text-sm font-medium text-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    查看全部讲义
                    <ChevronRight aria-hidden className="size-4" />
                  </Link>
                )}
              </>
            ))}
        </section>

        <section aria-labelledby="home-records">
          <h2
            id="home-records"
            className="mb-3 flex items-center gap-2 text-base font-semibold"
          >
            <History aria-hidden className="size-5 text-primary" />
            我的记录
          </h2>
          <Link
            to="/s/records"
            className="flex min-h-11 items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            做题记录与错题本
            <span className="text-xs text-muted-foreground">即将开放</span>
          </Link>
        </section>
      </div>
    </div>
  );
}
