import { History, Home, Loader2, LogOut, School } from "lucide-react";
import { Navigate, NavLink, Outlet, useNavigate } from "react-router";
import { useLogoutStudent, useStudentMe } from "@/features/auth/student-auth";
import { ApiError } from "@/lib/api";
import { ScreenError, ScreenLoading } from "./StudentScreen";

/**
 * /s 学生端布局 + 路由守卫（T2.3；T2A.5 导航定稿为「首页 / 课程 / 我的记录」）。
 * 守卫：me 查询 pending → 全屏加载；401 → 跳 /s/login；其他错误 → 错误态 + 重试。
 * 布局：顶部简洁导航（姓名 + 三个分区 + 退出），内容区居中限宽；
 * iPad 竖屏单栏，横屏（lg:）加宽；导航项触控目标 ≥44px。
 * 讲义不再占顶栏入口：/s/lectures 保留为二级页面（首页「按讲义浏览」进入，
 * T2A.5 信息架构），讲义的主要入口是课程目录。
 */

/** 学生端分区导航（首页 / 课程 / 我的记录；「我的记录」T3.5 实现为占位页） */
const NAV_ITEMS = [
  { to: "/s/home", label: "首页", icon: Home },
  { to: "/s/courses", label: "课程", icon: School },
  { to: "/s/records", label: "我的记录", icon: History },
] as const;

export function StudentLayout() {
  const meQuery = useStudentMe();
  const logoutMutation = useLogoutStudent();
  const navigate = useNavigate();

  if (meQuery.isPending) {
    return <ScreenLoading text="正在确认登录状态…" />;
  }
  if (meQuery.isError) {
    const err = meQuery.error;
    if (err instanceof ApiError && err.code === "UNAUTHORIZED") {
      // 未登录 / 会话过期 / 已归档：去登录页
      return <Navigate to="/s/login" replace />;
    }
    return (
      <ScreenError
        message={err instanceof Error ? err.message : "网络异常，请稍后重试"}
        onRetry={() => void meQuery.refetch()}
      />
    );
  }

  function handleLogout() {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        // 守卫缓存已清（useLogoutStudent onSuccess），这里直接回登录页
        navigate("/s/login", { replace: true });
      },
    });
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-2 lg:max-w-5xl">
          <p className="min-w-0 truncate text-sm font-semibold">
            {meQuery.data.displayName}
          </p>
          <nav
            aria-label="学生端导航"
            className="flex min-w-0 flex-1 items-center justify-center gap-1"
          >
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 ${
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`
                }
              >
                <item.icon aria-hidden className="size-4 shrink-0" />
                {item.label}
              </NavLink>
            ))}
          </nav>
          <button
            type="button"
            onClick={handleLogout}
            disabled={logoutMutation.isPending}
            className="flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
          >
            {logoutMutation.isPending ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <LogOut aria-hidden className="size-4 shrink-0" />
            )}
            退出
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 lg:max-w-5xl lg:py-8">
        <Outlet />
      </main>
    </div>
  );
}

// 供 App.tsx 路由级懒加载
export default StudentLayout;
