import {
  ClipboardList,
  Database,
  GraduationCap,
  Library,
  LineChart,
  Settings,
  Users,
} from "lucide-react";
import { Link, Navigate, Outlet, useLocation } from "react-router";
import { useTeacherMe } from "@/features/auth/teacher-auth";
import { ApiError } from "@/lib/api";
import { AuthScreenError, AuthScreenLoading } from "./SetupPage";

/**
 * /t 教师端布局 + 路由守卫（T1.9）。侧边栏（T2A.9 定稿，2026-09-29 去重简化）：
 * 资源库 · 课程 · 学生 · 作业 · 数据 · 学情 · 设置（数据/学情仍为占位页，T3/T4 提供）。
 * 讲义库/题库/回收站由 /t/library 页面顶部页签切换（?tab=），导入经页面
 * 「导入内容」按钮进入 /t/import——侧边栏不再单列，避免与页内导航重复；
 * 资源库入口在 /t/import 上保持高亮（导入属资源库流程）。触控目标一律 ≥44px。
 * 守卫：me 查询 pending → 全屏加载；401 → 跳 /t/login；其他错误 → 错误态 + 重试。
 * 布局：左侧导航（md+）/顶部横向导航（小屏）。
 */

/** 导航条目 */
interface NavItemSpec {
  to: string;
  label: string;
  icon: typeof Library;
  /** 额外的高亮路径前缀（资源库在 /t/import 导入流程页上保持高亮） */
  matchPrefixes?: string[];
}

/** 导航分区（资源库 · 课程 / 学生 / 作业 / 数据 / 学情 / 设置） */
const NAV_ITEMS: NavItemSpec[] = [
  {
    to: "/t/library",
    label: "资源库",
    icon: Library,
    matchPrefixes: ["/t/library", "/t/import"],
  },
  { to: "/t/courses", label: "课程", icon: GraduationCap },
  { to: "/t/students", label: "学生", icon: Users },
  { to: "/t/assignments", label: "作业", icon: ClipboardList },
  { to: "/t/data", label: "数据", icon: Database },
  { to: "/t/insights", label: "学情", icon: LineChart },
  { to: "/t/settings", label: "设置", icon: Settings },
];

/**
 * 高亮判定：路径前缀匹配（/t/courses/:id 仍高亮「课程」）；
 * 资源库额外匹配 /t/import（导入经「导入内容」按钮进入，属资源库流程）。
 * 自算而非 NavLink 的 isActive，并据此设置 aria-current="page"。
 */
function isNavActive(item: NavItemSpec, pathname: string): boolean {
  const prefixes = item.matchPrefixes ?? [item.to];
  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function NavItem({ item }: { item: NavItemSpec }) {
  const { pathname } = useLocation();
  const active = isNavActive(item, pathname);
  return (
    <Link
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
}

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
          <NavItem key={item.to} item={item} />
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
