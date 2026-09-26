import {
  BookOpen,
  ClipboardList,
  Database,
  LineChart,
  Settings,
  Users,
} from "lucide-react";
import { Navigate, NavLink, Outlet } from "react-router";
import { useTeacherMe } from "@/features/auth/teacher-auth";
import { ApiError } from "@/lib/api";
import { AuthScreenError, AuthScreenLoading } from "./SetupPage";

/**
 * /t 教师端布局 + 路由守卫（T1.9）。
 * 守卫：me 查询 pending → 全屏加载；401 → 跳 /t/login；其他错误 → 错误态 + 重试。
 * 布局：左侧导航（md+）/顶部横向导航（小屏），五个分区：
 * 内容 / 学生、作业（T2.1 学生页 + T2.2 作业页）/ 数据 / 学情 / 设置。触控目标一律 ≥44px。
 */

/** 导航分区（后续任务逐个替换占位页） */
const NAV_ITEMS = [
  { to: "/t/content", label: "内容", icon: BookOpen },
  { to: "/t/students", label: "学生", icon: Users },
  { to: "/t/assignments", label: "作业", icon: ClipboardList },
  { to: "/t/data", label: "数据", icon: Database },
  { to: "/t/insights", label: "学情", icon: LineChart },
  { to: "/t/settings", label: "设置", icon: Settings },
] as const;

export function TeacherLayout() {
  const meQuery = useTeacherMe();

  if (meQuery.isPending) {
    return <AuthScreenLoading text="正在确认登录状态…" />;
  }
  if (meQuery.isError) {
    const err = meQuery.error;
    if (err instanceof ApiError && err.code === "UNAUTHORIZED") {
      // 未登录 / 会话过期：交给登录页（登录页再按 hasTeacher 分流到 setup）
      return <LoginRedirect />;
    }
    return (
      <AuthScreenError
        message={err instanceof Error ? err.message : "网络异常，请稍后重试"}
        onRetry={() => void meQuery.refetch()}
      />
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground md:flex-row">
      <nav
        aria-label="教师端导航"
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card px-3 py-2 md:w-56 md:flex-col md:items-stretch md:gap-1 md:border-r md:border-b-0 md:px-3 md:py-4"
      >
        <p className="mr-2 hidden px-2 pb-2 text-sm font-semibold md:block">
          辅导工作台
        </p>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 ${
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

      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}

/** 401 跳登录（replace：登录后回 /t，不把守卫页留在历史栈里） */
function LoginRedirect() {
  return <Navigate to="/t/login" replace />;
}

// 供 App.tsx 路由级懒加载
export default TeacherLayout;
