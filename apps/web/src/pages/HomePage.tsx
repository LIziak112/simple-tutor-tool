import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  GraduationCap,
  Loader2,
  type LucideIcon,
  Presentation,
  RefreshCw,
  ServerCog,
} from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { useStudentMe } from "@/features/auth/student-auth";
import { useTeacherMe } from "@/features/auth/teacher-auth";
import { fetchHealth } from "@/lib/api";
import { formatCnTime } from "@/lib/time";

/**
 * 身份入口卡（首页登录面板）：整卡为一个 Link（触控目标远超 44px），
 * 已登录时由调用方换标题/说明/动作，落点也换成对应端内页。
 */
function RoleEntryCard({
  to,
  icon: Icon,
  title,
  description,
  actionLabel,
}: {
  to: string;
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel: string;
}) {
  return (
    <Link
      to={to}
      className="group flex min-h-44 flex-col gap-3 rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-sm transition-colors hover:border-primary/50 hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <span
        aria-hidden
        className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary"
      >
        <Icon className="size-6" />
      </span>
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      <span className="mt-auto inline-flex items-center gap-1 pt-2 text-sm font-medium text-primary">
        {actionLabel}
        <ArrowRight
          aria-hidden
          className="size-4 transition-transform group-hover:translate-x-0.5"
        />
      </span>
    </Link>
  );
}

/**
 * 首页：登录入口面板（学生/教师两张身份卡）+ 底部系统状态卡。
 * - 两端会话独立，useStudentMe / useTeacherMe 未登录时 401（isError），
 *   探测未落定或未登录一律显示登录入口；已登录则换文案直接进对应端；
 * - 系统状态卡保留 T1.x 的前后端联通自检（部署排障用），加载中 /
 *   错误（含重试）/ 成功 三态齐全（UI 约定硬性要求）。
 */
export function HomePage() {
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
  });
  const { data } = healthQuery;
  const studentMe = useStudentMe();
  const teacherMe = useTeacherMe();
  const student = studentMe.data;
  const teacher = teacherMe.data;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-background px-6 py-12 text-foreground">
      <header className="text-center">
        <h1 className="text-2xl font-semibold">辅导讲练工具</h1>
        <p className="mt-1 text-sm text-muted-foreground">请选择你的身份进入</p>
      </header>

      <section
        aria-label="登录入口"
        className="grid w-full max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2"
      >
        <RoleEntryCard
          to={student ? "/s/home" : "/s/login"}
          icon={GraduationCap}
          title={student ? "学生端" : "学生登录"}
          description={
            student
              ? `已登录：${student.displayName}`
              : "用老师给的登录名和密码登录，或打开老师发的专属链接"
          }
          actionLabel={student ? "继续学习" : "去登录"}
        />
        <RoleEntryCard
          to={teacher ? "/t" : "/t/login"}
          icon={Presentation}
          title={teacher ? "教师端" : "教师登录"}
          description={
            teacher
              ? `已登录：${teacher.loginName}`
              : "进入辅导工作台，管理课程、讲义、作业与学情"
          }
          actionLabel={teacher ? "进入工作台" : "去登录"}
        />
      </section>

      <section
        aria-label="系统状态"
        aria-live="polite"
        className="w-full max-w-2xl rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm"
      >
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground">
          系统状态
        </h2>
        {healthQuery.isPending ? (
          <p className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="animate-spin" />
            正在连接服务器…
          </p>
        ) : healthQuery.isError ? (
          <div className="flex flex-col items-start gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-2 text-sm text-destructive">
              <ServerCog aria-hidden className="size-5 shrink-0" />
              <span>
                无法获取服务器时间：
                {healthQuery.error instanceof Error
                  ? healthQuery.error.message
                  : "网络异常，请稍后重试"}
              </span>
            </p>
            {/* 触控目标不小于 44px（UI 约定），min-h-11 覆盖默认 h-8 */}
            <Button
              variant="outline"
              className="min-h-11 shrink-0 px-5"
              onClick={() => void healthQuery.refetch()}
            >
              <RefreshCw aria-hidden />
              重试
            </Button>
          </div>
        ) : data ? (
          <div className="flex items-center justify-between gap-3 py-2">
            <p className="text-sm text-muted-foreground">
              服务器时间：
              <span className="font-medium tabular-nums text-foreground">
                {formatCnTime(data.time)}
              </span>
            </p>
            <Button
              variant="outline"
              className="min-h-11 shrink-0 px-4"
              disabled={healthQuery.isFetching}
              onClick={() => void healthQuery.refetch()}
            >
              <RefreshCw
                aria-hidden
                className={healthQuery.isFetching ? "animate-spin" : undefined}
              />
              刷新
            </Button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
