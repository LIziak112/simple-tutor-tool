import type { StudentAssignment } from "@tutor/contract";
import {
  BookOpen,
  BookX,
  CircleCheck,
  ClipboardList,
  School,
  Sparkles,
} from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { useStudentMe } from "@/features/auth/student-auth";
import {
  useStudentAssignments,
  useStudentCourses,
} from "@/features/student/student-queries";
import { useStudentWrongQuestions } from "@/features/student/student-records-queries";
import {
  AssignmentGroupLabel,
  isAssignmentTodo,
  StudentAssignmentCard,
  StudentCourseCard,
  StudentEmptyState,
  StudentErrorPanel,
  StudentListSkeleton,
  StudentSectionLink,
  StudentSectionTitle,
} from "@/features/student/student-ui";
import {
  isConquered,
  loadWrongMasteryStandard,
} from "@/features/student/wrong-mastery";

/**
 * /s/home 学生首页（T2A.5 改版 + 2026-10 IA 调整 + 2026-10 UI 打磨）：
 * 问候横幅 + 待完成作业 + 错题本概览 + 我的课程卡片。首页呈现学生要做的
 * 三件事：要做的（作业）、要复习的（错题）、在学的（课程）；「我的记录」
 * 只在顶栏导航，不在首页重复（去重复入口）。
 * - 问候横幅：姓名 + 今日待办一句话（待完成作业数 / 待复习错题数）；
 * - 「我的作业」：按「待完成 / 已完成」两组排列（待完成在前、实心按钮），
 *   卡片含标题/单元/题数/截止北京时间（48 小时内与过期高亮）/状态徽章；
 * - 「错题本」：概览卡（待复习/已攻克计数 + 去复习入口；数据为全量形态
 *   includeResolved=true 前端分流计数，攻克标准与 /s/wrong 页共用
 *   wrong-mastery.ts 同一口径——严格默认=连续做对 2 次，宽松=做对 1 次）；
 * - 「我的课程」：课程卡片（进度条），分区标题右侧「按讲义浏览」二级入口。
 * 布局：竖屏单栏（作业 → 错题本 → 课程）；横屏（lg:）作业在左，
 * 错题本与课程在右列。顶部姓名与退出在 StudentLayout。
 */

/** 错题本待复习计数（首页横幅与概览卡共用同一份查询缓存） */
function useWrongCounts() {
  // 全量形态（含已攻克）拉一次，前端分流计数——单学生错题规模有限（D11 口径）。
  // 攻克标准与 /s/wrong 页共用同一函数（wrong-mastery.ts，本设备 localStorage）
  const wrongQuery = useStudentWrongQuestions({ includeResolved: true });
  const standard = useMemo(() => loadWrongMasteryStandard(), []);
  const counts = useMemo(() => {
    const questions = wrongQuery.data?.questions;
    if (questions === undefined) return null;
    const pending = questions.filter(
      (question) => !isConquered(question, standard),
    ).length;
    return {
      total: questions.length,
      pending,
      conquered: questions.length - pending,
    };
  }, [wrongQuery.data, standard]);
  return { wrongQuery, counts };
}

/** 问候横幅：姓名 + 今日待办一句话（数据未到时只显示问候） */
function GreetingBanner({
  todoCount,
  wrongPending,
}: {
  todoCount: number | null;
  wrongPending: number | null;
}) {
  const meQuery = useStudentMe();
  const name = meQuery.data?.displayName ?? "同学";
  let summary = "看看今天要做什么吧。";
  if (todoCount !== null) {
    const parts: string[] = [];
    if (todoCount > 0) parts.push(`${todoCount} 份作业待完成`);
    if (wrongPending !== null && wrongPending > 0) {
      parts.push(`${wrongPending} 道错题待复习`);
    }
    summary =
      parts.length > 0
        ? `今天有 ${parts.join("，")}。`
        : "作业都完成了，可以去课程里看看讲义，或者复习一下错题。";
  }
  return (
    <section
      aria-label="今日概览"
      className="flex items-center gap-4 rounded-2xl bg-gradient-to-r from-primary to-sky-500 px-5 py-5 text-primary-foreground shadow-sm sm:px-6"
    >
      <span
        aria-hidden
        className="hidden size-12 shrink-0 items-center justify-center rounded-2xl bg-white/20 sm:flex"
      >
        <Sparkles className="size-6" />
      </span>
      <div className="min-w-0">
        <p className="text-lg font-semibold">{name}，你好</p>
        <p className="mt-0.5 text-sm text-white/90">{summary}</p>
      </div>
    </section>
  );
}

/** 错题本概览卡：待复习/已攻克计数 + 入口按钮（计数与入口随数据变化） */
function WrongQuestionsOverview({
  wrongQuery,
  counts,
}: ReturnType<typeof useWrongCounts>) {
  if (wrongQuery.isPending) {
    return (
      <div
        role="status"
        aria-label="正在加载错题本"
        className="h-32 animate-pulse rounded-2xl border border-border bg-muted/60"
      />
    );
  }
  if (wrongQuery.isError || counts === null) {
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

  const { total, pending, conquered } = counts;
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4 shadow-xs">
      {total === 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">还没有错题</p>
          <p className="text-sm text-muted-foreground">
            做错的题会自动收进这里，随时可以回来复习。
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* 两格大数字（读屏用下方整句） */}
          <div aria-hidden className="grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-orange-50 px-3 py-2.5 dark:bg-orange-500/10">
              <p className="text-2xl font-bold text-orange-600 dark:text-orange-300">
                {pending}
              </p>
              <p className="text-xs text-orange-700/80 dark:text-orange-300/80">
                待复习
              </p>
            </div>
            <div className="rounded-xl bg-emerald-50 px-3 py-2.5 dark:bg-emerald-500/10">
              <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-300">
                {conquered}
              </p>
              <p className="text-xs text-emerald-700/80 dark:text-emerald-300/80">
                已攻克
              </p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            待复习 {pending} 题 · 已攻克 {conquered} 题
          </p>
        </div>
      )}
      <Button
        asChild
        variant={pending > 0 ? "default" : "outline"}
        className="min-h-11"
      >
        <Link to="/s/wrong">{pending > 0 ? "去复习" : "查看错题本"}</Link>
      </Button>
    </div>
  );
}

/** 作业列表：待完成在前（实心入口），已完成在后；两组都有时加组标题 */
function AssignmentList({ assignments }: { assignments: StudentAssignment[] }) {
  const todo = assignments.filter((item) => isAssignmentTodo(item.status));
  const done = assignments.filter((item) => !isAssignmentTodo(item.status));
  const showLabels = todo.length > 0 && done.length > 0;
  return (
    <div className="flex flex-col gap-4">
      {todo.length === 0 && (
        <div className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          <CircleCheck aria-hidden className="size-5 shrink-0" />
          作业都完成了，做得好。
        </div>
      )}
      {todo.length > 0 && (
        <div className="flex flex-col gap-2">
          {showLabels && (
            <AssignmentGroupLabel>待完成 {todo.length}</AssignmentGroupLabel>
          )}
          <ul className="flex flex-col gap-3">
            {todo.map((assignment) => (
              <StudentAssignmentCard
                key={assignment.id}
                assignment={assignment}
              />
            ))}
          </ul>
        </div>
      )}
      {done.length > 0 && (
        <div className="flex flex-col gap-2">
          {showLabels && (
            <AssignmentGroupLabel>已完成 {done.length}</AssignmentGroupLabel>
          )}
          <ul className="flex flex-col gap-3">
            {done.map((assignment) => (
              <StudentAssignmentCard
                key={assignment.id}
                assignment={assignment}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function StudentHomePage() {
  const assignmentsQuery = useStudentAssignments();
  const coursesQuery = useStudentCourses();
  const wrong = useWrongCounts();

  const todoCount =
    assignmentsQuery.data?.assignments.filter((item) =>
      isAssignmentTodo(item.status),
    ).length ?? null;

  return (
    <div className="flex flex-col gap-6">
      <GreetingBanner
        todoCount={todoCount}
        wrongPending={wrong.counts?.pending ?? null}
      />

      <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-8">
        {/* 我的作业（主区，占 3/5；「我的记录」入口只在顶栏导航，不在此重复） */}
        <section aria-labelledby="home-assignments" className="lg:w-3/5">
          <StudentSectionTitle
            id="home-assignments"
            icon={<ClipboardList aria-hidden />}
            title="我的作业"
            {...(todoCount !== null && todoCount > 0
              ? { count: todoCount }
              : {})}
          />

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
              <StudentEmptyState
                icon={<ClipboardList />}
                title="现在没有待完成的作业"
                description="老师布置作业后会出现在这里，也可以先去课程里看看讲义。"
                action={
                  <StudentSectionLink to="/s/courses">
                    去课程看看
                  </StudentSectionLink>
                }
              />
            ) : (
              <AssignmentList assignments={assignmentsQuery.data.assignments} />
            ))}
        </section>

        {/* 右列（占 2/5）：错题本概览 + 我的课程 */}
        <div className="flex flex-col gap-8 lg:w-2/5">
          {/* 错题本（2026-10 IA 调整：升为首页一级分区，入口 = 概览卡按钮；导航在顶栏） */}
          <section aria-labelledby="home-wrong">
            <StudentSectionTitle
              id="home-wrong"
              icon={<BookX aria-hidden />}
              title="错题本"
            />
            <WrongQuestionsOverview {...wrong} />
          </section>

          {/* 我的课程（「按讲义浏览」二级入口；顶栏导航已无讲义项） */}
          <section aria-labelledby="home-courses">
            <StudentSectionTitle
              id="home-courses"
              icon={<School aria-hidden />}
              title="我的课程"
              action={
                <Link
                  to="/s/lectures"
                  className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-primary outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <BookOpen aria-hidden className="size-4 shrink-0" />
                  按讲义浏览
                </Link>
              }
            />

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
                <StudentEmptyState
                  compact
                  icon={<School />}
                  title="还没有加入课程"
                  description="老师把你加入课程后，这里的讲义和练习会自动出现。"
                />
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
    </div>
  );
}
