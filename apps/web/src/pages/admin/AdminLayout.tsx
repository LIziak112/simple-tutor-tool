import {
  ArrowLeft,
  FolderOpen,
  LayoutDashboard,
  Menu,
  ShieldCheck,
  UserRoundCog,
} from "lucide-react";
import { useEffect, useState } from "react";
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
import { AuthScreenError, AuthScreenLoading } from "../teacher/SetupPage";

/** 管理端复用教师视觉主题，导航与权限守卫保持独立。 */
const ADMIN_NAV_ITEMS = [
  { to: "/a", label: "概览", icon: LayoutDashboard },
  { to: "/a/teachers", label: "教师管理", icon: UserRoundCog },
  { to: "/a/shared-files", label: "共享文件", icon: FolderOpen },
] as const;

function isNavActive(pathname: string, to: string): boolean {
  return pathname === to || (to !== "/a" && pathname.startsWith(`${to}/`));
}

function AdminNavigation({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  return (
    <nav
      aria-label="管理端导航"
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-4 py-1"
    >
      <section aria-label="系统">
        <p className="mt-1 mb-1 px-3 text-xs font-medium text-sidebar-foreground">
          系统
        </p>
        <div className="flex flex-col">
          {ADMIN_NAV_ITEMS.map((item) => {
            const active = isNavActive(pathname, item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary ${active ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground" : "font-medium text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground"}`}
              >
                <item.icon aria-hidden className="size-[18px] shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </div>
      </section>
      <Link
        to="/t"
        onClick={onNavigate}
        className="mt-2 flex min-h-11 items-center gap-3 rounded-lg border-t border-sidebar-border px-3 py-2 text-sm font-medium text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground"
      >
        <ArrowLeft aria-hidden className="size-[18px] shrink-0" />
        返回教师端
      </Link>
    </nav>
  );
}

export function AdminLayout() {
  useEffect(() => {
    document.documentElement.classList.add("teacher-theme");
    return () => document.documentElement.classList.remove("teacher-theme");
  }, []);
  const meQuery = useTeacherMe();
  const { pathname } = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const currentItem = ADMIN_NAV_ITEMS.find((item) =>
    isNavActive(pathname, item.to),
  );

  if (meQuery.isPending) return <AuthScreenLoading text="正在确认管理权限…" />;
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
  if (!meQuery.data.isAdmin) return <Navigate to="/t" replace />;

  return (
    <div className="teacher-theme flex min-h-dvh bg-background text-foreground">
      <a
        href="#admin-content"
        className="sr-only z-[60] rounded-lg bg-card p-3 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        跳到主要内容
      </a>
      <aside className="sticky top-0 hidden h-dvh w-[224px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        <div className="px-6 pt-5 pb-3">
          <Brand compact compactLabel="系统管理工作台" />
        </div>
        <AdminNavigation />
        <Link
          to="/t/settings?section=account"
          aria-label="查看管理员账号"
          className="flex min-h-16 items-center gap-3 border-t border-sidebar-border px-6 py-3 text-sm text-muted-foreground hover:bg-sidebar-accent"
        >
          <ShieldCheck aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0">
            <span
              data-testid="admin-login-name"
              className="block break-all font-medium text-foreground"
            >
              {meQuery.data.loginName}
            </span>
            <span className="text-xs">管理员账号</span>
          </span>
        </Link>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex min-h-14 flex-wrap items-center gap-3 px-5 py-1.5 lg:px-10">
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
                <SheetTitle>{BRAND_NAME} 系统管理</SheetTitle>
              </SheetHeader>
              <AdminNavigation onNavigate={() => setNavOpen(false)} />
              <Link
                to="/t/settings?section=account"
                onClick={() => setNavOpen(false)}
                className="mx-4 mb-4 flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm text-sidebar-foreground hover:bg-sidebar-accent"
              >
                <ShieldCheck aria-hidden className="size-4 shrink-0" />
                <span className="min-w-0 break-all">
                  {meQuery.data.loginName} · 管理员账号
                </span>
              </Link>
            </SheetContent>
          </Sheet>
          <p className="text-sm">
            <span className="hidden text-muted-foreground sm:inline">
              系统管理
              <span aria-hidden className="px-2">
                /
              </span>
            </span>
            <span className="font-medium">
              {currentItem?.label ?? "管理工作台"}
            </span>
          </p>
        </header>
        <main id="admin-content" tabIndex={-1} className="min-w-0 outline-none">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default AdminLayout;
