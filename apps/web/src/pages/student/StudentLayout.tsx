import {
  BookX,
  ClipboardList,
  History,
  Home,
  Loader2,
  LogOut,
  School,
  Settings2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useNavigate } from "react-router";
import { useBindAnnotationSession } from "@/features/annotation/use-annotation-session";
import { bindPracticePreferenceAccount } from "@/features/attempt/practice-preference-store";
import { useLogoutStudent, useStudentMe } from "@/features/auth/student-auth";
import { useBindInkProfiles } from "@/features/ink/use-ink-profiles";
import { bindKeyboardBindingsAccount } from "@/features/keyboard/keyboard-binding-store";
import { useBindNoteSession } from "@/features/notes/use-note-session";
import {
  StudentWorkspaceContext,
  type StudentWorkspaceVariant,
} from "@/features/student/student-workspace-layout";
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
 * 窄屏导航改为底部拇指区标签栏（2026-11 壳层重构），五个入口始终可达。
 * 讲义不占顶栏入口：/s/lectures 保留为二级页面（首页「按讲义浏览」进入，
 * 讲义的主要入口是课程目录）。
 */

/** 学生端分区导航（首页 / 我的作业 / 课程 / 错题本 / 我的记录；错题本 2026-10 起为一级功能） */
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
] as const;

export function StudentLayout() {
  const [workspace, setWorkspace] = useState<StudentWorkspaceVariant>(false);
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
  const logoutMutation = useLogoutStudent();
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
          /* 2026-11 壳层重构：顶栏收成单行（身份 / 导航 / 操作）。窄屏把同一个
             <nav> 改成固定在底部的拇指区标签栏，顶栏只留一行 56px；lg 起导航回到
             顶栏中段。只渲染一份导航，读屏与测试都只看到一组链接。
             顶栏不用 backdrop-filter：它会成为 fixed 子元素的包含块，把底栏钉在顶栏里。 */
          <header className="sticky top-0 z-20 border-b border-border/70 bg-card/95 supports-[backdrop-filter]:bg-card/90">
            <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-3 px-4 lg:h-16 lg:max-w-5xl">
              <div className="min-w-0 shrink-0">{identity}</div>
              <nav
                aria-label="学生端导航"
                className="fixed inset-x-0 bottom-0 z-30 border-t border-border/70 bg-card/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_-8px_rgb(0_0_0/0.12)] backdrop-blur lg:static lg:z-auto lg:flex-1 lg:border-0 lg:bg-transparent lg:pb-0 lg:shadow-none lg:backdrop-blur-none"
              >
                <div className="mx-auto grid max-w-3xl grid-cols-5 gap-1 px-2 pt-1 lg:mx-0 lg:max-w-none lg:rounded-xl lg:bg-muted lg:p-1">
                  {NAV_ITEMS.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      aria-label={item.label}
                      className={({ isActive }) =>
                        `group relative flex min-h-14 min-w-11 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-xs font-medium whitespace-nowrap outline-none transition-[color,background-color,transform] duration-150 active:scale-[0.96] focus-visible:ring-3 focus-visible:ring-ring/50 lg:min-h-10 lg:flex-row lg:gap-1.5 lg:px-2 lg:text-sm ${
                          isActive
                            ? "text-primary lg:bg-card lg:shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <span
                            aria-hidden
                            className={`flex h-7 w-12 items-center justify-center rounded-full transition-colors lg:h-auto lg:w-auto ${
                              isActive ? "bg-primary/12 lg:bg-transparent" : ""
                            }`}
                          >
                            <item.icon className="size-5 shrink-0 lg:size-4" />
                          </span>
                          <span>
                            {"shortLabel" in item ? (
                              <>
                                <span className="lg:hidden">
                                  {item.shortLabel}
                                </span>
                                <span className="hidden lg:inline">
                                  {item.label}
                                </span>
                              </>
                            ) : (
                              item.label
                            )}
                          </span>
                        </>
                      )}
                    </NavLink>
                  ))}
                </div>
              </nav>
              <div className="ml-auto flex shrink-0 items-center gap-1 lg:ml-0">
                <AiQueueButton />
                {logout}
              </div>
            </div>
          </header>
        )}

        <main
          id="student-main"
          tabIndex={-1}
          className={
            workspace === "wide"
              ? "mx-auto w-full max-w-[1120px] flex-1 px-3 pb-[env(safe-area-inset-bottom)] sm:px-6 xl:max-w-[1280px]"
              : workspace
                ? "mx-auto w-full max-w-[1120px] flex-1 px-3 pb-[env(safe-area-inset-bottom)] sm:px-6"
                : "mx-auto w-full max-w-3xl flex-1 px-4 pt-6 pb-[calc(5.5rem+env(safe-area-inset-bottom))] lg:max-w-5xl lg:py-8"
          }
        >
          <Outlet />
        </main>
      </div>
    </StudentWorkspaceContext.Provider>
  );
}

// 供 App.tsx 路由级懒加载
export default StudentLayout;
