import {
  BookOpen,
  BookX,
  ChevronRight,
  ClipboardList,
  School,
} from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  useStudentAssignments,
  useStudentCourses,
} from "@/features/student/student-queries";
import { useStudentWrongQuestions } from "@/features/student/student-records-queries";
import {
  StudentAssignmentCard,
  StudentCourseCard,
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";
import {
  isConquered,
  loadWrongMasteryStandard,
} from "@/features/student/wrong-mastery";

/**
 * /s/home 学生首页（T2A.5 改版 + 2026-10 IA 调整）：待完成作业 + 错题本概览 +
 * 我的课程卡片。首页呈现学生要做的三件事：要做的（作业）、要复习的（错题）、
 * 在学的（课程）；「我的记录」只在顶栏导航，不在首页重复（去重复入口）。
 * - 「我的作业」：作业卡片（标题/单元/题数/截止北京时间/状态徽章）；
 * - 「错题本」：概览卡（待复习/已攻克计数 + 去复习入口；数据为全量形态
 *   includeResolved=true 前端分流计数，攻克标准与 /s/wrong 页共用
 *   wrong-mastery.ts 同一口径——严格默认=连续做对 2 次，宽松=做对 1 次）；
 * - 「我的课程」：课程卡片（进度条），分区标题右侧「按讲义浏览」二级入口。
 * 布局：竖屏单栏（作业 → 错题本 → 课程）；横屏（lg:）作业在左，
 * 错题本与课程在右列。顶部姓名与退出在 StudentLayout（本页不再重复）。
 */

/** 错题本概览卡：待复习/已攻克计数 + 入口按钮（计数与入口随数据变化） */
function WrongQuestionsOverview() {
  // 全量形态（含已攻克）拉一次，前端分流计数——单学生错题规模有限（D11 口径）。
  // 攻克标准与 /s/wrong 页共用同一函数（wrong-mastery.ts，本设备 localStorage）：
  // 宽松=最后一轮做对；严格（默认）=最后两轮连续做对，两处口径一致
  const wrongQuery = useStudentWrongQuestions({ includeResolved: true });
  const standard = useMemo(() => loadWrongMasteryStandard(), []);

  if (wrongQuery.isPending) {
    return (
      <div
        role="status"
        aria-label="正在加载错题本"
        className="h-24 animate-pulse rounded-xl border border-border bg-muted/50"
      />
    );
  }
  if (wrongQuery.isError) {
    return (
      <StudentErrorPanel
        title="错题本加载失败"
        message={
          wrongQuery.error instanceof Error
            ? wrongQuery.error.message
            : "网络异常，请稍后重试"
        }
        onRetry={() => void wrongQuery.refetch()}
      />
    );
  }

  const questions = wrongQuery.data.questions;
  const pendingCount = questions.filter(
    (question) => !isConquered(question, standard),
  ).length;
  const conqueredCount = questions.length - pendingCount;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      {questions.length === 0 ? (
        <>
          <p className="text-sm font-medium">还没有错题</p>
          <p className="text-sm text-muted-foreground">
            做错的题会自动收进这里，随时可以回来复习。
          </p>
        </>
      ) : (
        <p className="text-sm">
          待复习 {pendingCount} 题 · 已攻克 {conqueredCount} 题
        </p>
      )}
      <Button
        asChild
        variant={pendingCount > 0 ? "default" : "outline"}
        className="min-h-11"
      >
        <Link to="/s/wrong">{pendingCount > 0 ? "去复习" : "查看错题本"}</Link>
      </Button>
    </div>
  );
}

export default function StudentHomePage() {
  const assignmentsQuery = useStudentAssignments();
  const coursesQuery = useStudentCourses();

  return (
    <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-8">
      {/* 我的作业（主区，占 3/5；「我的记录」入口只在顶栏导航，不在此重复） */}
      <section aria-labelledby="home-assignments" className="lg:w-3/5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2
            id="home-assignments"
            className="flex items-center gap-2 text-base font-semibold"
          >
            <ClipboardList aria-hidden className="size-5 text-primary" />
            我的作业
          </h2>
        </div>

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

      {/* 右列（占 2/5）：错题本概览 + 我的课程 */}
      <div className="flex flex-col gap-8 lg:w-2/5">
        {/* 错题本（2026-10 IA 调整：升为首页一级分区，入口 = 概览卡按钮；导航在顶栏） */}
        <section aria-labelledby="home-wrong">
          <h2
            id="home-wrong"
            className="mb-3 flex items-center gap-2 text-base font-semibold"
          >
            <BookX aria-hidden className="size-5 text-primary" />
            错题本
          </h2>
          <WrongQuestionsOverview />
        </section>

        {/* 我的课程（「按讲义浏览」二级入口；顶栏导航已无讲义项） */}
        <section aria-labelledby="home-courses">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2
              id="home-courses"
              className="flex items-center gap-2 text-base font-semibold"
            >
              <School aria-hidden className="size-5 text-primary" />
              我的课程
            </h2>
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
    </div>
  );
}
