import { GraduationCap, Loader2, LogIn } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLoginStudent, useStudentMe } from "@/features/auth/student-auth";
import { useStudentTheme } from "@/features/student/use-student-theme";
import { ApiError } from "@/lib/api";

/**
 * /s/login 学生密码登录页（T2.3，§5.7 登录名+密码）。
 * 已登录访问直接跳 /s/home；失败按错误码给中文指引
 * （INVALID_CREDENTIALS 防枚举统一口径 / LOCKED 限流提示）。
 */
export default function StudentLoginPage() {
  useStudentTheme();
  const meQuery = useStudentMe();
  const loginMutation = useLoginStudent();
  const navigate = useNavigate();
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");

  // 已登录（会话仍有效）：直接进首页
  if (meQuery.isSuccess) {
    return <Navigate to="/s/home" replace />;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    loginMutation.mutate(
      { loginName: loginName.trim(), password },
      // 成功后 me 缓存已写入；replace 避免回退键回到登录页
      { onSuccess: () => navigate("/s/home", { replace: true }) },
    );
  }

  /** 按错误码翻译成可执行的中文指引 */
  const errorMessage = loginMutation.isError
    ? loginMutation.error instanceof ApiError
      ? loginMutation.error.code === "INVALID_CREDENTIALS"
        ? "登录名或密码不正确，请检查后再试"
        : loginMutation.error.code === "LOCKED"
          ? "尝试次数过多，已暂时锁定，请约 10 分钟后再试或联系老师"
          : loginMutation.error.message
      : loginMutation.error instanceof Error
        ? loginMutation.error.message
        : "登录失败，请稍后重试"
    : null;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <span
          aria-hidden
          className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground"
        >
          <GraduationCap className="size-7" />
        </span>
        <h1 className="mt-4 text-center text-xl font-semibold">学生登录</h1>
        <p className="mt-2 mb-6 text-center text-sm text-muted-foreground">
          输入老师给你的登录名和密码
        </p>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="student-login-name" className="text-sm">
              登录名
            </label>
            <Input
              id="student-login-name"
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
              placeholder="如：张三"
              required
              maxLength={32}
              autoComplete="username"
              className="min-h-11"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="student-password" className="text-sm">
              密码
            </label>
            <Input
              id="student-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              required
              maxLength={128}
              autoComplete="current-password"
              className="min-h-11"
              aria-invalid={errorMessage != null}
            />
          </div>

          {errorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}

          <Button
            type="submit"
            className="min-h-12 px-4 text-base"
            disabled={loginMutation.isPending}
          >
            {loginMutation.isPending ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                正在登录…
              </>
            ) : (
              <>
                <LogIn aria-hidden />
                登录
              </>
            )}
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          还没有账号？请联系老师开通。
        </p>
      </div>
    </main>
  );
}
