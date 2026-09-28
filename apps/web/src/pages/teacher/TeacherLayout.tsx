import {
  BookOpen,
  ClipboardList,
  Database,
  FileStack,
  GraduationCap,
  LineChart,
  Settings,
  Upload,
  Users,
} from "lucide-react";
import { Link, Navigate, Outlet, useLocation } from "react-router";
import { useTeacherMe } from "@/features/auth/teacher-auth";
import { ApiError } from "@/lib/api";
import { AuthScreenError, AuthScreenLoading } from "./SetupPage";

/**
 * /t 教师端布局 + 路由守卫（T1.9）。T2A.9 侧边栏定稿：
 * 资源库（讲义库 / 题库 / 导入）· 课程 · 学生 · 作业 · 数据 · 学情 · 设置
 * （数据/学情仍为占位页，T3/T4 阶段提供）。讲义库/题库共用 /t/library，
 * 以 ?tab= 定位页签；导入直达 /t/import。触控目标一律 ≥44px。
 * 守卫：me 查询 pending → 全屏加载；401 → 跳 /t/login；其他错误 → 错误态 + 重试。
 * 布局：左侧导航（md+）/顶部横向导航（小屏），资源库分组标题仅 md+ 显示。
 */

/** 导航条目（T2A.9 定稿；资源库组内条目 nested=true，md+ 侧栏缩进） */
interface NavItemSpec {
  to: string;
  label: string;
  icon: typeof BookOpen;
  /** 讲义库/题库共用 /t/library，按 ?tab= 区分高亮（缺省视为 units 口径） */
  matchTab?: "lectures" | "units";
  nested?: boolean;
}

/** 资源库组（讲义库 / 题库 / 导入） */
const LIBRARY_ITEMS: NavItemSpec[] = [
  {
    to: "/t/library",
    label: "讲义库",
    icon: BookOpen,
    matchTab: "lectures",
    nested: true,
  },
  {
    to: "/t/library",
    label: "题库",
    icon: FileStack,
    matchTab: "units",
    nested: true,
  },
  { to: "/t/import", label: "导入", icon: Upload, nested: true },
];

/** 其余平铺分区（课程 / 学生 / 作业 / 数据 / 学情 / 设置） */
const NAV_ITEMS: NavItemSpec[] = [
  { to: "/t/courses", label: "课程", icon: GraduationCap },
  { to: "/t/students", label: "学生", icon: Users },
  { to: "/t/assignments", label: "作业", icon: ClipboardList },
  { to: "/t/data", label: "数据", icon: Database },
  { to: "/t/insights", label: "学情", icon: LineChart },
  { to: "/t/settings", label: "设置", icon: Settings },
];

/**
 * 高亮判定：路径前缀匹配（/t/courses/:id 仍高亮「课程」）；
 * 讲义库/题库再按 ?tab= 细分（无参数 = 默认页签「题库」），
 * 回收站页签时两者都不高亮。自算而非 NavLink 的 isActive，
 * 并据此设置 aria-current="page"（同一地址两入口不得同时标记）。
 */
function isNavActive(
  item: NavItemSpec,
  pathname: string,
  search: string,
): boolean {
  const pathActive = pathname === item.to || pathname.startsWith(`${item.to}/`);
  if (!pathActive) return false;
  if (item.matchTab === undefined) return true;
  const tab = new URLSearchParams(search).get("tab") ?? "units";
  return tab === item.matchTab;
}

function NavItem({ item }: { item: NavItemSpec }) {
  const { pathname, search } = useLocation();
  const active = isNavActive(item, pathname, search);
  // units 是默认页签：题库入口不带参数即可直达（URL 更干净）
  const target =
    item.matchTab === undefined || item.matchTab === "units"
      ? item.to
      : `${item.to}?tab=${item.matchTab}`;
  return (
    <Link
      to={target}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 ${
        item.nested ? "md:pl-7" : ""
      } ${
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
        {/* 资源库分组标题：不可点的栏目标签（小屏横向导航隐藏，三个子项自带语义） */}
        <p className="hidden px-2 pb-1 pt-3 text-xs font-medium tracking-wide text-muted-foreground md:block">
          资源库
        </p>
        {LIBRARY_ITEMS.map((item) => (
          <NavItem key={item.label} item={item} />
        ))}
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
