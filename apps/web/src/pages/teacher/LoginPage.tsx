import { Loader2, LogIn, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useLoginTeacher,
  useTeacherStatus,
} from "@/features/auth/teacher-auth";
import { ApiError } from "@/lib/api";
import { AuthScreenError, AuthScreenLoading } from "./SetupPage";

/**
 * /t/login 教师密码登录。
 * 分流：status 加载中 → 全屏加载；失败 → 错误态；未设置教师 → 跳 /t/setup。
 * 错误提示区分：密码错误（INVALID_CREDENTIALS）与临时锁定（LOCKED）。
 */
export function LoginPage() {
  const statusQuery = useTeacherStatus();
  const loginMutation = useLoginTeacher();
  const navigate = useNavigate();

  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  if (statusQuery.isPending) {
    return <AuthScreenLoading text="正在检查初始状态…" />;
  }
  if (statusQuery.isError) {
    return (
      <AuthScreenError
        message={
          statusQuery.error instanceof Error
            ? statusQuery.error.message
            : "网络异常，请稍后重试"
        }
        onRetry={() => void statusQuery.refetch()}
      />
    );
  }
  if (!statusQuery.data.hasTeacher) {
    // 尚未设置教师：先走初始化
    return <Navigate to="/t/setup" replace />;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length === 0) {
      setFormError("请输入密码");
      return;
    }
    setFormError(null);
    loginMutation.mutate(password, {
      onSuccess: () => {
        navigate("/t", { replace: true });
      },
    });
  }

  // 服务端错误按 code 转成面向老师的提示（锁定时只说明锁定，不泄露其他信息）
  function serverErrorMessage(err: unknown): string | null {
    if (err instanceof ApiError) {
      return err.message;
    }
    if (err instanceof Error) {
      return err.message;
    }
    return null;
  }
  const shownError = formError ?? serverErrorMessage(loginMutation.error);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-6 text-foreground">
      <header className="text-center">
        <h1 className="flex items-center justify-center gap-2 text-2xl font-semibold">
          <LogIn aria-hidden className="size-6" />
          教师登录
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          输入密码进入辅导工作台
        </p>
      </header>

      <form
        noValidate
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm"
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="login-password" className="text-sm font-medium">
              密码
            </label>
            <Input
              id="login-password"
              type="password"
              name="password"
              autoComplete="current-password"
              placeholder="请输入密码"
              value={password}
              aria-invalid={shownError != null}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loginMutation.isPending}
            />
          </div>

          {shownError != null && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {shownError}
            </p>
          )}

          <Button
            type="submit"
            className="min-h-11 w-full"
            disabled={loginMutation.isPending}
          >
            {loginMutation.isPending ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                正在登录…
              </>
            ) : (
              "登录"
            )}
          </Button>
        </div>
      </form>

      <p className="max-w-sm text-center text-xs text-muted-foreground">
        连续输错 5 次将临时锁定 10 分钟。
      </p>
    </main>
  );
}

// 供 App.tsx 路由级懒加载
export default LoginPage;
