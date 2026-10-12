import {
  ClipboardList,
  Database,
  FileDown,
  GraduationCap,
  Library,
  LineChart,
  Menu,
  PlugZap,
  Settings,
  Share2,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";
import { useState } from "react";
import { Link, Navigate, Outlet, useLocation } from "react-router";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useTeacherMe } from "@/features/auth/teacher-auth";
import { ApiError } from "@/lib/api";
import { BRAND_NAME } from "@/lib/brand";
import { AuthScreenError, AuthScreenLoading } from "./SetupPage";

interface NavItemSpec {
  to: string;
  label: string;
  icon: typeof Library;
  matchPrefixes?: string[];
}

/** 导航与顶栏共用分组数据，导入属于资源库，详情保留父分区高亮。 */
const NAV_GROUPS: { label: string; items: NavItemSpec[] }[] = [
  {
    label: "教学",
    items: [
      {
        to: "/t/library",
        label: "资源库",
        icon: Library,
        matchPrefixes: ["/t/library", "/t/import"],
      },
      { to: "/t/shared", label: "共享资源", icon: Share2 },
      { to: "/t/courses", label: "课程", icon: GraduationCap },
      { to: "/t/students", label: "学生", icon: Users },
      { to: "/t/assignments", label: "作业", icon: ClipboardList },
    ],
  },
  {
    label: "分析",
    items: [
      { to: "/t/insights", label: "学情分析", icon: LineChart },
      { to: "/t/data", label: "作答记录", icon: Database },
      { to: "/t/export", label: "导出中心", icon: FileDown },
    ],
  },
  {
    label: "系统",
    items: [
      { to: "/t/connect", label: "连接 AI", icon: PlugZap },
      { to: "/t/settings", label: "设置", icon: Settings },
    ],
  },
];

const ADMIN_NAV_ITEM: NavItemSpec = {
  to: "/a",
  label: "系统管理",
  icon: ShieldCheck,
};

function isNavActive(item: NavItemSpec, pathname: string): boolean {
  return (item.matchPrefixes ?? [item.to]).some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function NavItem({
  item,
  onNavigate,
}: {
  item: NavItemSpec;
  onNavigate?: () => void;
}) {
  const active = isNavActive(item, useLocation().pathname);
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary ${
        active
          ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground"
          : "font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
      }`}
    >
      <item.icon aria-hidden className="size-[18px] shrink-0" />
      <span className="flex-1">{item.label}</span>
      {active && (
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
      )}
    </Link>
  );
}

function TeacherNavigation({
  isAdmin,
  onNavigate,
}: {
  isAdmin: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav
      aria-label="教师端导航"
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-3 py-4"
    >
      {NAV_GROUPS.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <p className="mb-1 px-3 text-xs font-medium text-muted-foreground">
            {group.label}
          </p>
          <div className="flex flex-col gap-1">
            {group.items.map((item) => (
              <NavItem
                key={item.to}
                item={item}
                {...(onNavigate ? { onNavigate } : {})}
              />
            ))}
          </div>
        </section>
      ))}
      {isAdmin && (
        <div className="mt-auto border-t border-sidebar-border pt-3">
          <NavItem
            item={ADMIN_NAV_ITEM}
            {...(onNavigate ? { onNavigate } : {})}
          />
        </div>
      )}
    </nav>
  );
}

export function TeacherLayout() {
  const meQuery = useTeacherMe();
  const { pathname } = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const currentGroup = NAV_GROUPS.find((group) =>
    group.items.some((item) => isNavActive(item, pathname)),
  );
  const currentItem = currentGroup?.items.find((item) =>
    isNavActive(item, pathname),
  );

  if (meQuery.isPending) return <AuthScreenLoading text="正在确认登录状态…" />;
  if (meQuery.isError) {
    const err = meQuery.error;
    if (err instanceof ApiError && err.code === "UNAUTHORIZED")
      return <Navigate to="/t/login" replace />;
    return (
      <AuthScreenError
        message={err instanceof Error ? err.message : "网络异常，请稍后重试"}
        onRetry={() => void meQuery.refetch()}
      />
    );
  }

  return (
    <div className="teacher-theme flex min-h-dvh bg-muted/30 text-foreground">
      <a
        href="#teacher-content"
        className="sr-only z-[60] rounded-lg bg-card p-3 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        跳到主要内容
      </a>
      <aside className="sticky top-0 hidden h-dvh w-[232px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        <div className="px-6 pt-6 pb-2">
          <Brand />
        </div>
        <TeacherNavigation isAdmin={meQuery.data.isAdmin} />
        <Link
          to="/t/settings?section=account"
          aria-label="查看教师账号"
          className="flex min-h-16 items-center gap-3 border-t border-sidebar-border px-6 py-3 text-sm text-muted-foreground hover:bg-sidebar-accent"
        >
          <UserRound aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0">
            <span className="block break-all font-medium text-foreground">
              {meQuery.data.loginName}
            </span>
            <span className="text-xs">教师账号</span>
          </span>
        </Link>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex min-h-16 flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 py-2 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Sheet open={navOpen} onOpenChange={setNavOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-11 lg:hidden"
                  aria-label="打开导航"
                >
                  <Menu aria-hidden />
                </Button>
              </SheetTrigger>
              <SheetContent
                side="left"
                className="teacher-theme w-[min(20rem,100%)] max-w-full sm:max-w-80"
              >
                <SheetHeader>
                  <SheetTitle>{BRAND_NAME} 导航</SheetTitle>
                </SheetHeader>
                <TeacherNavigation
                  isAdmin={meQuery.data.isAdmin}
                  onNavigate={() => setNavOpen(false)}
                />
              </SheetContent>
            </Sheet>
            <p className="text-sm">
              <span className="hidden text-muted-foreground sm:inline">
                {currentGroup?.label ?? "教学"}
                <span aria-hidden className="px-2">
                  /
                </span>
              </span>
              <span className="font-medium">
                {currentItem?.label ?? "教师工作台"}
              </span>
            </p>
          </div>
          <Link
            to="/t/settings?section=account"
            aria-label={`账号与会话：${meQuery.data.loginName}`}
            className="flex min-h-11 min-w-0 max-w-[50%] items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary hover:bg-muted"
          >
            <UserRound aria-hidden className="size-4 shrink-0" />
            <span
              data-testid="teacher-login-name"
              className="min-w-0 break-all"
            >
              {meQuery.data.loginName}
            </span>
          </Link>
        </header>
        <main
          id="teacher-content"
          tabIndex={-1}
          className="min-w-0 outline-none"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default TeacherLayout;
