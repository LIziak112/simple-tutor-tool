import { teacherLoginNameSchema } from "@tutor/contract";
import { GraduationCap, Loader2, LogIn, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useLoginTeacher,
  useTeacherStatus,
} from "@/features/auth/teacher-auth";
import { ApiError } from "@/lib/api";
import { BRAND_NAME, BRAND_TAGLINE } from "@/lib/brand";
import { AuthScreenError, AuthScreenLoading } from "./SetupPage";

/**
 * /t/login 教师登录（T2B.2 起为「登录名 + 密码」双字段，D6）。
 * 分流：status 加载中 → 全屏加载；失败 → 错误态；未设置教师 → 跳 /t/setup。
 * 登录名在成功登录后记入 localStorage 供下次预填（明文即可——登录名非机密，
 * 出现在共享文件名里本来就公开）。
 * 错误提示区分：登录名或密码错误（INVALID_CREDENTIALS，统一口径防枚举）、
 * 账号停用（ACCOUNT_DISABLED，明示原因）、临时锁定（LOCKED）。
 * T2B.6：底部按 status.registrationOpen 显示「没有账号？注册」入口（开关关时不显示）。
 */

/** localStorage 键：上次成功登录的教师登录名（预填用） */
const LOGIN_NAME_STORAGE_KEY = "tutor:teacher-login-name";

/** 读记住的登录名（隐私模式等 localStorage 不可用时静默回退为空） */
function readRememberedLoginName(): string {
  try {
    return window.localStorage.getItem(LOGIN_NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function LoginPage() {
  const statusQuery = useTeacherStatus();
  const loginMutation = useLoginTeacher();
  const navigate = useNavigate();

  const [loginName, setLoginName] = useState(() => readRememberedLoginName());
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
    // 与服务端同一份契约规则（D2 字符集与长度）
    const parsedName = teacherLoginNameSchema.safeParse(loginName);
    if (!parsedName.success) {
      setFormError(parsedName.error.issues[0]?.message ?? "登录名格式不正确");
      return;
    }
    if (password.length === 0) {
      setFormError("请输入密码");
      return;
    }
    setFormError(null);
    loginMutation.mutate(
      { loginName: parsedName.data, password },
      {
        onSuccess: (_teacher, request) => {
          // 记住登录名供下次预填（仅成功时记，避免把敲错的存下来）
          try {
            window.localStorage.setItem(
              LOGIN_NAME_STORAGE_KEY,
              request.loginName,
            );
          } catch {
            // 存不进就算了，不影响登录
          }
          navigate("/t", { replace: true });
        },
      },
    );
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
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-6 py-8 text-foreground">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-sm sm:p-8">
        <header className="text-center">
          <span
            aria-hidden
            className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground"
          >
            <GraduationCap className="size-7" />
          </span>
          <h1 className="mt-4 text-xl font-semibold">教师登录</h1>
          <p className="mt-2 mb-6 text-sm text-muted-foreground">
            输入登录名与密码进入辅导工作台
          </p>
        </header>

        <form
          noValidate
          onSubmit={handleSubmit}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="login-name" className="text-sm font-medium">
              登录名
            </label>
            <Input
              id="login-name"
              type="text"
              name="loginName"
              autoComplete="username"
              placeholder="请输入登录名"
              value={loginName}
              aria-invalid={shownError != null}
              onChange={(e) => setLoginName(e.target.value)}
              disabled={loginMutation.isPending}
              className="min-h-11"
            />
          </div>

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
              className="min-h-11"
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
            className="min-h-12 w-full px-4 text-base"
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
          连续输错 5 次将临时锁定 10 分钟。
        </p>

        {statusQuery.data.registrationOpen && (
          <p className="mt-3 text-center text-sm text-muted-foreground">
            没有账号？
            <Link
              to="/t/register"
              className="mx-1 font-medium text-primary underline-offset-4 hover:underline"
            >
              注册
            </Link>
          </p>
        )}
        <footer className="mt-6 text-center text-xs text-muted-foreground">
          <p className="font-semibold">{BRAND_NAME}</p>
          <p lang="en" className="mt-1 leading-relaxed">
            {BRAND_TAGLINE}
          </p>
        </footer>
      </div>
    </main>
  );
}

// 供 App.tsx 路由级懒加载
export default LoginPage;
