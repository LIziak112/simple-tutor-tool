import {
  BookOpenCheck,
  ClipboardList,
  Database,
  FileDown,
  GraduationCap,
  Library,
  Menu,
  PlugZap,
  Settings,
  Share2,
  UserRound,
  Users,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { PersonalViewButton } from "@/features/auth/PersonalViewButton";
import { PortalGuard } from "@/features/auth/PortalGuard";
import { useAccountLoginPath } from "@/features/auth/personal-auth";
import { useTeacherMe } from "@/features/auth/teacher-auth";
import { useBindInkProfiles } from "@/features/ink/use-ink-profiles";
import { SettingsNavigationProvider } from "@/features/teacher-settings/settings-navigation";
import { BRAND_NAME } from "@/lib/brand";
import {
  type PortalCapability,
  portalCapabilitiesOf,
} from "@/portals/registry";

interface NavItemSpec {
  to: string;
  label: string;
  icon: typeof Library;
  matchPrefixes?: string[];
  capability?: PortalCapability;
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
      { to: "/t/students", label: "学生", icon: Users, capability: "members" },
      {
        to: "/t/assignments",
        label: "作业",
        icon: ClipboardList,
        capability: "assignments",
      },
    ],
  },
  {
    label: "分析",
    items: [
      // T-PR1：「学情分析」一级入口下沉为作答记录页顶部「统计」次级切换
      //（/t/insights 与 /t/insights/questions 路由保留）
      {
        to: "/t/data",
        label: "作答记录",
        icon: Database,
        matchPrefixes: ["/t/data", "/t/insights"],
      },
      { to: "/t/export", label: "导出中心", icon: FileDown },
    ],
  },
  {
    label: "系统",
    items: [
      {
        to: "/t/connect",
        label: "连接 AI",
        icon: PlugZap,
        capability: "teacherAiConnections",
      },
      { to: "/t/settings", label: "设置", icon: Settings },
    ],
  },
];

/** 导航按门户能力表裁剪，和页面内入口共用同一判定。 */
function navGroupsFor(accountKind: "class" | "personal") {
  const capabilities = portalCapabilitiesOf("teacher", accountKind);
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => !item.capability || capabilities[item.capability],
    ),
  })).filter((group) => group.items.length > 0);
}

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
          : "font-medium text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground"
      }`}
    >
      <item.icon aria-hidden className="size-[18px] shrink-0" />
      <span className="flex-1">{item.label}</span>
    </Link>
  );
}

function TeacherNavigation({
  groups,
  onNavigate,
}: {
  groups: typeof NAV_GROUPS;
  onNavigate?: () => void;
}) {
  return (
    <nav
      aria-label="教师端导航"
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-4 py-1"
    >
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <p className="mt-1 mb-1 px-3 text-xs font-medium text-sidebar-foreground">
            {group.label}
          </p>
          <div className="flex flex-col">
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
    </nav>
  );
}

export function TeacherLayout() {
  const legacyLocation = useLocation();
  useEffect(() => {
    document.documentElement.classList.add("teacher-theme");
    return () => document.documentElement.classList.remove("teacher-theme");
  }, []);
  const meQuery = useTeacherMe();
  const loginPath = useAccountLoginPath(meQuery.data?.accountKind, "/t/login");
  useBindInkProfiles("teacher", meQuery.data?.id);
  const { pathname } = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const previousPath = useRef(pathname);
  useEffect(() => {
    if (previousPath.current !== pathname) {
      previousPath.current = pathname;
      setNavOpen(false);
    }
  }, [pathname]);
  // 个人账号（模块 0）：裁剪导航、账号标签改「个人账号」、顶栏给「学习视角」切换
  const accountKind = meQuery.data?.accountKind ?? "class";
  const personal = accountKind === "personal";
  const navGroups = navGroupsFor(accountKind);
  const currentGroup = navGroups.find((group) =>
    group.items.some((item) => isNavActive(item, pathname)),
  );
  const currentItem = currentGroup?.items.find((item) =>
    isNavActive(item, pathname),
  );

  if (meQuery.data?.accountKind === "personal")
    return (
      <Navigate
        to={`/p/manage${legacyLocation.pathname.slice(2)}${legacyLocation.search}${legacyLocation.hash}`}
        replace
      />
    );
  return (
    <PortalGuard portal="teacher" loginPath={loginPath} query={meQuery}>
      {(me) => (
        <SettingsNavigationProvider>
          <div className="teacher-theme flex min-h-dvh bg-background text-foreground">
            <a
              href="#teacher-content"
              className="sr-only z-[60] rounded-lg bg-card p-3 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
            >
              跳到主要内容
            </a>
            <aside className="sticky top-0 hidden h-dvh w-[224px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
              <div className="px-6 pt-5 pb-3">
                <Brand compact />
              </div>
              <TeacherNavigation groups={navGroups} />
              <Link
                to="/t/settings?section=account"
                aria-label={personal ? "查看个人账号" : "查看教师账号"}
                className="flex min-h-16 items-center gap-3 border-t border-sidebar-border px-6 py-3 text-sm text-muted-foreground hover:bg-sidebar-accent"
              >
                <UserRound aria-hidden className="size-4 shrink-0" />
                <span className="min-w-0">
                  <span
                    data-testid="teacher-login-name"
                    className="block break-all font-medium text-foreground"
                  >
                    {me.loginName}
                  </span>
                  <span className="text-xs">
                    {personal ? "个人账号 · 管理视角" : "教师账号"}
                  </span>
                </span>
              </Link>
            </aside>
            <div className="min-w-0 flex-1">
              <header className="flex min-h-14 flex-wrap items-center gap-2 px-5 py-1.5 lg:px-10">
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
                        groups={navGroups}
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
                      {currentItem?.label ??
                        (personal ? "管理视角" : "教师工作台")}
                    </span>
                  </p>
                </div>
                <Link
                  to="/"
                  className="flex min-h-11 items-center rounded-lg px-3 text-sm text-muted-foreground hover:bg-accent"
                >
                  切换身份
                </Link>
                {personal && (
                  <PersonalViewButton
                    from="teacher"
                    to="/s/home"
                    aria-label="切换到学习视角"
                    className="flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-primary outline-offset-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <BookOpenCheck aria-hidden className="size-4 shrink-0" />
                    学习视角
                  </PersonalViewButton>
                )}
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
        </SettingsNavigationProvider>
      )}
    </PortalGuard>
  );
}

export default TeacherLayout;
