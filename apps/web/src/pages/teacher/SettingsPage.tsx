import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  DatabaseBackup,
  Loader2,
  LogOut,
  PenLine,
  PlugZap,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import {
  teacherMeKey,
  useLogoutTeacher,
  useTeacherMe,
} from "@/features/auth/teacher-auth";
import { BackupSection } from "@/features/teacher-backup/BackupSection";
import { CapabilityProfileSection } from "@/features/teacher-settings/CapabilityProfileSection";
import { formatCnTime } from "@/lib/time";
import { AuthScreenLoading } from "./SetupPage";

const SECTIONS = [
  { id: "teaching", label: "学生作答方式", icon: PenLine },
  { id: "backup", label: "备份与恢复", icon: DatabaseBackup },
  { id: "account", label: "账号与会话", icon: UserRound },
] as const;

/** 分类写入 URL；配置区持续挂载，切换时保留未保存的编辑状态。 */
export function SettingsPage() {
  const meQuery = useTeacherMe();
  const logoutMutation = useLogoutTeacher();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedSection = searchParams.get("section");
  const activeSection =
    SECTIONS.find((section) => section.id === requestedSection)?.id ??
    "teaching";

  if (meQuery.isPending) return <AuthScreenLoading text="正在加载设置…" />;
  if (meQuery.isError || !meQuery.data)
    return <Navigate to="/t/login" replace />;

  function handleLogout() {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: teacherMeKey });
        navigate("/t/login", { replace: true });
      },
    });
  }

  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-6 lg:px-8 lg:py-8">
      <header className="mb-7">
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          工作台配置
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">设置</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          管理学生作答方式、数据备份与账号。
        </p>
      </header>
      <div className="grid min-w-0 gap-6 lg:grid-cols-[180px_minmax(0,1fr)]">
        <div>
          <nav
            aria-label="设置分类"
            className="flex flex-wrap gap-1 lg:flex-col"
          >
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <Link
                key={id}
                to={`/t/settings?section=${id}`}
                aria-current={activeSection === id ? "page" : undefined}
                className={`flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary ${activeSection === id ? "bg-card font-semibold text-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
              >
                <Icon aria-hidden className="size-4 shrink-0" />
                {label}
              </Link>
            ))}
          </nav>
          <Link
            to="/t/connect"
            className="mt-4 flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary hover:bg-muted"
          >
            <PlugZap aria-hidden className="size-4 shrink-0" />
            管理 AI 连接
            <ArrowUpRight aria-hidden className="ml-auto size-3.5 shrink-0" />
          </Link>
        </div>
        <div className="min-w-0">
          <div hidden={activeSection !== "teaching"}>
            <CapabilityProfileSection />
          </div>
          <div hidden={activeSection !== "backup"}>
            <BackupSection />
          </div>
          <div hidden={activeSection !== "account"} className="space-y-5">
            <div className="rounded-xl border border-border bg-card p-5">
              <h2 className="text-base font-semibold">教师账号</h2>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">登录名</dt>
                  <dd className="break-all font-medium">
                    {meQuery.data.loginName}
                  </dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">创建时间</dt>
                  <dd>{formatCnTime(meQuery.data.createdAt)}</dd>
                </div>
              </dl>
            </div>
            <div className="rounded-xl border border-border bg-card p-5">
              <h2 className="text-base font-semibold">登录会话</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                退出后需要重新输入密码；连续输错 5 次将临时锁定 10 分钟。
              </p>
              {logoutMutation.isError && (
                <p
                  role="alert"
                  className="mt-3 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  <TriangleAlert
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0"
                  />
                  {logoutMutation.error instanceof Error
                    ? logoutMutation.error.message
                    : "退出失败，请稍后重试"}
                </p>
              )}
              <Button
                variant="outline"
                className="mt-4 min-h-11 px-5"
                disabled={logoutMutation.isPending}
                onClick={handleLogout}
              >
                {logoutMutation.isPending ? (
                  <>
                    <Loader2 aria-hidden className="motion-safe:animate-spin" />
                    正在退出…
                  </>
                ) : (
                  <>
                    <LogOut aria-hidden />
                    退出登录
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default SettingsPage;
