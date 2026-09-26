import { useQueryClient } from "@tanstack/react-query";
import { Loader2, LogOut, TriangleAlert } from "lucide-react";
import { Navigate, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  teacherMeKey,
  useLogoutTeacher,
  useTeacherMe,
} from "@/features/auth/teacher-auth";
import { formatCnTime } from "@/lib/time";

/**
 * /t/settings 设置页（T1.9 只放「退出登录」；改密码、API Token 等后续任务补）。
 */
export function SettingsPage() {
  const meQuery = useTeacherMe();
  const logoutMutation = useLogoutTeacher();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // 布局守卫已确保登录；这里兜底：会话刚失效（如另一处登出）时跳登录
  if (meQuery.isError || !meQuery.data) {
    return <Navigate to="/t/login" replace />;
  }

  function handleLogout() {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        // me 缓存已在 mutation 里清掉；这里再回到登录页
        void queryClient.invalidateQueries({ queryKey: teacherMeKey });
        navigate("/t/login", { replace: true });
      },
    });
  }

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="text-xl font-semibold">设置</h1>
        <p className="mt-1 text-sm text-muted-foreground">教师账号与会话</p>
      </header>

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 text-card-foreground">
        <h2 className="text-sm font-semibold">账号</h2>
        <p className="text-sm text-muted-foreground">
          教师账号创建于 {formatCnTime(meQuery.data.createdAt)}
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 text-card-foreground">
        <h2 className="text-sm font-semibold">会话</h2>
        <p className="text-sm text-muted-foreground">
          退出后需要重新输入密码；连续输错 5 次将临时锁定 10 分钟。
        </p>
        {logoutMutation.isError && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            {logoutMutation.error instanceof Error
              ? logoutMutation.error.message
              : "退出失败，请稍后重试"}
          </p>
        )}
        <div>
          <Button
            variant="outline"
            className="min-h-11 px-6 text-destructive"
            disabled={logoutMutation.isPending}
            onClick={handleLogout}
          >
            {logoutMutation.isPending ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                正在退出…
              </>
            ) : (
              <>
                <LogOut aria-hidden />
                退出登录
              </>
            )}
          </Button>
        </div>
      </div>
    </section>
  );
}

// 供 App.tsx 路由级懒加载
export default SettingsPage;
