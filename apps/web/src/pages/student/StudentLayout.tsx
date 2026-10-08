import { BookX, History, Home, Loader2, LogOut, School } from "lucide-react";
import { Navigate, NavLink, Outlet, useNavigate } from "react-router";
import { useBindAnnotationSession } from "@/features/annotation/use-annotation-session";
import { useLogoutStudent, useStudentMe } from "@/features/auth/student-auth";
import { useBindNoteSession } from "@/features/notes/use-note-session";
import { useStudentTheme } from "@/features/student/use-student-theme";
import { ApiError } from "@/lib/api";
import { ScreenError, ScreenLoading } from "./StudentScreen";

/**
 * /s 学生端布局 + 路由守卫（T2.3；2026-10 IA 调整：导航定稿为
 * 「首页 / 课程 / 错题本 / 我的记录」；2026-10 UI 打磨：学生端主题色、
 * 顶栏三段式——左侧姓名头像、中间分段式导航、右侧退出）。
 * 守卫：me 查询 pending → 全屏加载；401 → 跳 /s/login；其他错误 → 错误态 + 重试。
 * 布局：内容区居中限宽；iPad 竖屏单栏，横屏（lg:）加宽；导航项触控目标 ≥44px，
 * 竖屏（< sm）导航只显示图标 + 文字缩小，保证四项一行放得下。
 * 讲义不占顶栏入口：/s/lectures 保留为二级页面（首页「按讲义浏览」进入，
 * 讲义的主要入口是课程目录）。
 */

/** 学生端分区导航（首页 / 课程 / 错题本 / 我的记录；错题本 2026-10 起为一级功能） */
const NAV_ITEMS = [
  { to: "/s/home", label: "首页", icon: Home },
  { to: "/s/courses", label: "课程", icon: School },
  { to: "/s/wrong", label: "错题本", icon: BookX },
  { to: "/s/records", label: "我的记录", icon: History },
] as const;

export function StudentLayout() {
  useStudentTheme();
  const meQuery = useStudentMe();
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

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border/70 bg-card/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-2 lg:max-w-5xl">
          {/* 姓名：头像圆标（姓名首字）+ 名字（窄屏只留头像） */}
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
            >
              {displayName.slice(0, 1)}
            </span>
            <p className="hidden max-w-32 truncate text-sm font-semibold sm:block">
              {displayName}
            </p>
          </div>
          <nav
            aria-label="学生端导航"
            className="flex min-w-0 flex-1 items-center justify-center"
          >
            <div className="flex items-center gap-1 rounded-xl bg-muted p-1">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 sm:px-4 ${
                      isActive
                        ? "bg-card text-primary shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`
                  }
                >
                  <item.icon aria-hidden className="size-4 shrink-0" />
                  {item.label}
                </NavLink>
              ))}
            </div>
          </nav>
          <button
            type="button"
            onClick={handleLogout}
            disabled={logoutMutation.isPending}
            className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
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
