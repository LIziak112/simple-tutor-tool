import {
  ArrowLeft,
  FolderOpen,
  LayoutDashboard,
  ShieldCheck,
  UserRoundCog,
} from "lucide-react";
import { Link, Navigate, Outlet, useLocation } from "react-router";
import { useTeacherMe } from "@/features/auth/teacher-auth";
import { ApiError } from "@/lib/api";
import { AuthScreenError, AuthScreenLoading } from "../teacher/SetupPage";

/**
 * /a 管理端布局 + 路由守卫（T2B.6，D19）。
 * 独立布局——不套教师端导航；守卫：me 查询 pending → 全屏加载；401 → 跳 /t/login；
 * 非管理员（me.isAdmin=false）→ 跳 /t（管理入口只对 isAdmin 显示，直接敲 URL 同样拦）。
 * 页面：概览（/a，含注册开关行）/ 教师管理（/a/teachers）。
 * 触控目标 ≥44px（管理端也可能在 iPad 上使用，§4.8）。
 */

/** 管理端导航条目（T2B.7 增共享文件页） */
const ADMIN_NAV_ITEMS = [
  { to: "/a", label: "概览", icon: LayoutDashboard },
  { to: "/a/teachers", label: "教师管理", icon: UserRoundCog },
  { to: "/a/shared-files", label: "共享文件", icon: FolderOpen },
] as const;

function isNavActive(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function AdminLayout() {
  const meQuery = useTeacherMe();
  const { pathname } = useLocation();

  if (meQuery.isPending) {
    return <AuthScreenLoading text="正在确认管理权限…" />;
  }
  if (meQuery.isError) {
    const err = meQuery.error;
    if (err instanceof ApiError && err.code === "UNAUTHORIZED") {
      return <Navigate to="/t/login" replace />;
    }
    return (
      <AuthScreenError
        message={err instanceof Error ? err.message : "网络异常，请稍后重试"}
        onRetry={() => void meQuery.refetch()}
      />
    );
  }
  if (!meQuery.data.isAdmin) {
    // 非管理员：回教师端（入口本来就不显示，此处拦直接敲 URL 的情况）
    return <Navigate to="/t" replace />;
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground md:flex-row">
      <nav
        aria-label="管理端导航"
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card px-3 py-2 md:w-56 md:flex-col md:items-stretch md:gap-1 md:border-r md:border-b-0 md:px-3 md:py-4"
      >
        <p className="mr-2 hidden flex items-center gap-1.5 px-2 pb-2 text-sm font-semibold md:flex">
          <ShieldCheck aria-hidden className="size-4 text-primary" />
          管理端
        </p>
        {ADMIN_NAV_ITEMS.map((item) => {
          const active = isNavActive(pathname, item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 ${
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <item.icon aria-hidden className="size-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
        <Link
          to="/t"
          className="mt-auto flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 max-md:mt-0 md:mt-3"
        >
          <ArrowLeft aria-hidden className="size-4 shrink-0" />
          返回教师端
        </Link>
      </nav>

      <main className="min-w-0 flex-1">
        <header className="flex min-h-11 items-center justify-end gap-2 border-b border-border bg-card px-4 text-sm text-muted-foreground">
          <ShieldCheck aria-hidden className="size-4" />
          <span data-testid="admin-login-name">{meQuery.data.loginName}</span>
        </header>
        <Outlet />
      </main>
    </div>
  );
}

// 供 App.tsx 路由级懒加载
export default AdminLayout;
