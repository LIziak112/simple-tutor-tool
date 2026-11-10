import {
  BookX,
  ClipboardList,
  History,
  Home,
  LayoutDashboard,
  Loader2,
  LogOut,
  NotebookPen,
  School,
  Settings2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useNavigate } from "react-router";
import { useBindAnnotationSession } from "@/features/annotation/use-annotation-session";
import { bindPracticePreferenceAccount } from "@/features/attempt/practice-preference-store";
import { useLogoutPersonal } from "@/features/auth/personal-auth";
import { useLogoutStudent, useStudentMe } from "@/features/auth/student-auth";
import { useBindInkProfiles } from "@/features/ink/use-ink-profiles";
import { bindKeyboardBindingsAccount } from "@/features/keyboard/keyboard-binding-store";
import { MemoQuickCapture } from "@/features/memos/MemoQuickCapture";
import { bindMemoOutboxAccount } from "@/features/memos/memo-outbox";
import { useBindNoteSession } from "@/features/notes/use-note-session";
import { StudentWorkspaceContext } from "@/features/student/student-workspace-layout";
import { useStudentTheme } from "@/features/student/use-student-theme";
import { AiQueueButton } from "@/features/student-ai/AiQueueButton";
import { bindAiDisplayAccount } from "@/features/student-ai/ai-display-preference-store";
import { ApiError } from "@/lib/api";
import { ScreenError, ScreenLoading } from "./StudentScreen";

/**
 * /s 学生端布局 + 路由守卫（T2.3；2026-10 IA 调整：导航定稿为
 * 「首页 / 我的作业 / 课程 / 错题本 / 我的记录」；2026-10 UI 打磨：学生端主题色、
 * 顶栏三段式——左侧姓名头像、中间分段式导航、右侧退出）。
 * 守卫：me 查询 pending → 全屏加载；401 → 跳 /s/login；其他错误 → 错误态 + 重试。
 * 布局：内容区居中限宽；iPad 竖屏单栏，横屏（lg:）加宽；导航项触控目标 ≥44px，
 * 窄屏导航独立一行并缩短标签，全部入口始终可达。
 * 讲义不占顶栏入口：/s/lectures 保留为二级页面（首页「按讲义浏览」进入，
 * 讲义的主要入口是课程目录）。
 * 个人账号（模块 0，accountKind=personal）：本布局即「学习视角」——导航去掉
 * 「我的作业」（没有老师派作业），顶栏多一枚「管理视角」切换（/t，教师端布局），
 * 退出同时结束学习 / 管理两枚会话；其余页面与班级学生完全一致。
 * 随笔（模块 5 第一步）：导航加「随笔」入口，布局右下角常驻浮动「随手记」
 * （任意页面可记、锚自动带上）；待补传队列按当前学生绑定。
 */

/** 学生端分区导航（首页 / 我的作业 / 课程 / 错题本 / 我的记录 / 随笔） */
const NAV_ITEMS = [
  { to: "/s/home", label: "首页", icon: Home },
  {
    to: "/s/assignments",
    label: "我的作业",
    shortLabel: "作业",
    icon: ClipboardList,
  },
  { to: "/s/courses", label: "课程", icon: School },
  { to: "/s/wrong", label: "错题本", icon: BookX },
  { to: "/s/records", label: "我的记录", shortLabel: "记录", icon: History },
  { to: "/s/memos", label: "随笔", icon: NotebookPen },
] as const;

/** 个人账号的导航：没有老师派作业，去掉「我的作业」 */
const PERSONAL_NAV_ITEMS = NAV_ITEMS.filter(
  (item) => item.to !== "/s/assignments",
);

export function StudentLayout() {
  const [workspace, setWorkspace] = useState(false);
  useStudentTheme();
  const meQuery = useStudentMe();
  useEffect(() => {
    bindAiDisplayAccount(meQuery.data?.id ?? null);
    return () => bindAiDisplayAccount(null);
  }, [meQuery.data?.id]);
  // M3-D1：做题方式偏好与 AI 显示偏好同一绑定时机（布局/快捷键按账号读取）
  useEffect(() => {
    bindPracticePreferenceAccount(meQuery.data?.id ?? null);
    return () => bindPracticePreferenceAccount(null);
  }, [meQuery.data?.id]);
  // 键位绑定偏好同口径（2026-10-28 快捷键体系：本设备键位按账号隔离读取）
  useEffect(() => {
    bindKeyboardBindingsAccount(meQuery.data?.id ?? null);
    return () => bindKeyboardBindingsAccount(null);
  }, [meQuery.data?.id]);
  useBindInkProfiles("student", meQuery.data?.id);
  // 随笔待补传队列按账号隔离（模块 5 第一步）
  useEffect(() => {
    void bindMemoOutboxAccount(meQuery.data?.id ?? null);
    return () => void bindMemoOutboxAccount(null);
  }, [meQuery.data?.id]);
  const logoutStudentMutation = useLogoutStudent();
  const logoutPersonalMutation = useLogoutPersonal();
  // 退出目标：登出清缓存后 me 先变 401、守卫先于 mutate 回调跳转，个人账号
  // 要回 /p/login 而不是 /s/login，所以目标在点击时记下、守卫读它
  const [logoutTarget, setLogoutTarget] = useState<string | null>(null);
  const navigate = useNavigate();
  // T6R.11 复审（会话接线层级）：草稿会话绑定上提到布局层——所有 /s/* 学生
  // 页面（答题/结果/历史回看）自动获得当前身份接线（bind/reset 对称：reset
  // 在 student-auth 登出处）。结果页读链路全走 Cookie 与 image-sync 队列不
  // 消费 note-session；绑定在布局层即模块级会话服务的身份职责归位
  useBindNoteSession(meQuery.data);
  // T6R.20：标注会话与草稿会话并行绑定（标注同步队列的身份接线）
  useBindAnnotationSession(meQuery.data);

  if (meQuery.isPending) {
    return <ScreenLoading text="正在确认登录状态…" />;
  }
  if (meQuery.isError) {
    const err = meQuery.error;
    if (err instanceof ApiError && err.code === "UNAUTHORIZED") {
      // 未登录 / 会话过期 / 已归档：去登录页（主动退出按账号类型回对应登录页）
      return <Navigate to={logoutTarget ?? "/s/login"} replace />;
    }
    return (
      <ScreenError
        message={err instanceof Error ? err.message : "网络异常，请稍后重试"}
        onRetry={() => void meQuery.refetch()}
      />
    );
  }

  const personal = meQuery.data.accountKind === "personal";
  // 个人账号退两侧会话、回个人登录页；班级学生只退学生会话
  const logoutMutation = personal
    ? logoutPersonalMutation
    : logoutStudentMutation;
  function handleLogout() {
    const target = personal ? "/p/login" : "/s/login";
    setLogoutTarget(target);
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        // 守卫缓存已清（logout onSuccess），这里直接回登录页
        navigate(target, { replace: true });
      },
      onError: () => setLogoutTarget(null),
    });
  }

  const navItems = personal ? PERSONAL_NAV_ITEMS : NAV_ITEMS;
  const displayName = meQuery.data.displayName;
  const identity = (
    <NavLink
      to="/s/settings"
      aria-label={`${displayName}，学生设置`}
      title="学生设置"
      className={({ isActive }) =>
        `flex min-h-11 min-w-11 shrink-0 items-center gap-2 rounded-xl px-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${isActive ? "bg-primary/10 text-primary" : "hover:bg-muted"}`
      }
    >
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
      >
        {displayName.slice(0, 1)}
      </span>
      <span className="hidden max-w-24 truncate text-sm font-semibold sm:block">
        {displayName}
      </span>
      <Settings2
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
    </NavLink>
  );
  const logout = (
    <button
      type="button"
      onClick={handleLogout}
      disabled={logoutMutation.isPending}
      aria-label="退出"
      className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
    >
      {logoutMutation.isPending ? (
        <Loader2 aria-hidden className="size-4 animate-spin" />
      ) : (
        <LogOut aria-hidden className="size-4 shrink-0" />
      )}
      <span className="hidden sm:inline">退出</span>
    </button>
  );
  // 个人账号：学习视角 ⇄ 管理视角（教师端布局）切换入口
  const manageView = personal ? (
    <NavLink
      to="/t"
      aria-label="切换到管理视角"
      title="管理视角：导入资料、整理课程、看学情"
      className="flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <LayoutDashboard aria-hidden className="size-4 shrink-0" />
      <span className="hidden sm:inline">管理视角</span>
    </NavLink>
  ) : null;

  return (
    <StudentWorkspaceContext.Provider value={setWorkspace}>
      <div className="flex min-h-dvh flex-col bg-background text-foreground">
        {/* 键盘/读屏跳过链：越过顶栏直达主内容（获得焦点前视觉隐藏） */}
        <a
          href="#student-main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-4 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-sm"
        >
          跳到主内容
        </a>
        {!workspace && (
          <header className="sticky top-0 z-10 border-b border-border/70 bg-card/90 backdrop-blur">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-2 lg:max-w-5xl lg:flex-row lg:items-center lg:gap-3">
              <div className="flex w-full items-center justify-between gap-3 lg:hidden">
                {identity}
                <div className="flex shrink-0 items-center gap-1">
                  <AiQueueButton />
                  {manageView}
                  {logout}
                </div>
              </div>
              <div className="hidden shrink-0 lg:block">{identity}</div>
              <nav aria-label="学生端导航" className="w-full min-w-0 lg:flex-1">
                <div
                  className={`grid min-w-0 gap-1 rounded-xl bg-muted p-1 ${
                    navItems.length === 5 ? "grid-cols-5" : "grid-cols-6"
                  }`}
                >
                  {navItems.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      aria-label={item.label}
                      className={({ isActive }) =>
                        `flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-1 text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 sm:px-2 ${
                          isActive
                            ? "bg-card text-primary shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`
                      }
                    >
                      <item.icon
                        aria-hidden
                        className="hidden size-4 shrink-0 sm:block"
                      />
                      <span className="text-xs sm:text-sm">
                        {"shortLabel" in item ? (
                          <>
                            <span className="sm:hidden">{item.shortLabel}</span>
                            <span className="hidden sm:inline">
                              {item.label}
                            </span>
                          </>
                        ) : (
                          item.label
                        )}
                      </span>
                    </NavLink>
                  ))}
                </div>
              </nav>
              <div className="hidden shrink-0 items-center gap-1 lg:flex">
                <AiQueueButton />
                {manageView}
                {logout}
              </div>
            </div>
          </header>
        )}

        <main
          id="student-main"
          tabIndex={-1}
          className={
            workspace
              ? "mx-auto w-full max-w-[1120px] flex-1 px-3 pb-[env(safe-area-inset-bottom)] sm:px-6"
              : "mx-auto w-full max-w-3xl flex-1 px-4 py-6 pb-[env(safe-area-inset-bottom)] lg:max-w-5xl lg:py-8"
          }
        >
          <Outlet />
        </main>
        <MemoQuickCapture />
      </div>
    </StudentWorkspaceContext.Provider>
  );
}

// 供 App.tsx 路由级懒加载
export default StudentLayout;
