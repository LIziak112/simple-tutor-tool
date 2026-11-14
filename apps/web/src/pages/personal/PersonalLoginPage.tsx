import { teacherLoginNameSchema } from "@tutor/contract";
import { BookOpenCheck, Loader2, LogIn, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthScreenError, AuthScreenLoading } from "@/features/auth/AuthScreen";
import { LoginShell } from "@/features/auth/LoginShell";
import { useLoginPersonal } from "@/features/auth/personal-auth";
import { loginPathWithReturnTo, safeReturnTo } from "@/features/auth/portals";
import { useTeacherStatus } from "@/features/auth/teacher-auth";
import { ApiError } from "@/lib/api";

/**
 * /p/login 个人学习账号登录（模块 0）。
 * 分流：status 加载中 → 全屏加载；失败 → 错误态；未首启 → 跳 /t/setup（个人账号
 * 以站点已初始化为前提）。登录成功同时拿到学习 / 管理两枚会话，落点学习视角首页
 * /s/home（管理视角从顶栏切换）。
 * 错误：INVALID_CREDENTIALS（统一口径防枚举）/ ACCOUNT_KIND_MISMATCH（班级教师
 * 走错入口，给教师登录链接）/ ACCOUNT_DISABLED / LOCKED。
 * 底部按 status.personalRegistrationOpen 显示「没有账号？用邀请码注册」。
 */

/** localStorage 键：上次成功登录的个人账号登录名（预填用；登录名非机密） */
const LOGIN_NAME_STORAGE_KEY = "tutor:personal-login-name";

function readRememberedLoginName(): string {
  try {
    return window.localStorage.getItem(LOGIN_NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function PersonalLoginPage() {
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo");
  const statusQuery = useTeacherStatus();
  const loginMutation = useLoginPersonal();
  const navigate = useNavigate();

  const [loginName, setLoginName] = useState(() => readRememberedLoginName());
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  if (statusQuery.isPending) {
    return (
      <LoginShell portal="personal">
        <AuthScreenLoading text="正在检查初始状态…" />
      </LoginShell>
    );
  }
  if (statusQuery.isError) {
    return (
      <LoginShell portal="personal">
        <AuthScreenError
          message={
            statusQuery.error instanceof Error
              ? statusQuery.error.message
              : "网络异常，请稍后重试"
          }
          onRetry={() => void statusQuery.refetch()}
        />
      </LoginShell>
    );
  }
  if (!statusQuery.data.hasTeacher) {
    return (
      <Navigate to={loginPathWithReturnTo("/t/setup", returnTo)} replace />
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
        onSuccess: (_session, request) => {
          try {
            window.localStorage.setItem(
              LOGIN_NAME_STORAGE_KEY,
              request.loginName,
            );
          } catch {
            // 存不进就算了，不影响登录
          }
          navigate(safeReturnTo(returnTo, "personal"), { replace: true });
        },
      },
    );
  }

  const mismatch =
    loginMutation.error instanceof ApiError &&
    loginMutation.error.code === "ACCOUNT_KIND_MISMATCH";
  const shownError =
    formError ??
    (loginMutation.error instanceof Error ? loginMutation.error.message : null);

  return (
    <LoginShell portal="personal">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-sm sm:p-8">
        <header className="text-center">
          <span
            aria-hidden
            className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground"
          >
            <BookOpenCheck className="size-7" />
          </span>
          <h1 className="mt-4 text-xl font-semibold">个人学习登录</h1>
          <p className="mt-2 mb-6 text-sm text-muted-foreground">
            一个账号同时拥有学习视角与管理视角
          </p>
        </header>

        <form
          noValidate
          onSubmit={handleSubmit}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="personal-login-name"
              className="text-sm font-medium"
            >
              登录名
            </label>
            <Input
              id="personal-login-name"
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
            <label
              htmlFor="personal-login-password"
              className="text-sm font-medium"
            >
              密码
            </label>
            <Input
              id="personal-login-password"
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
              <span>
                {shownError}
                {mismatch && (
                  <>
                    {" "}
                    <Link
                      to={loginPathWithReturnTo("/t/login", returnTo)}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      去教师登录
                    </Link>
                  </>
                )}
              </span>
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

        {statusQuery.data.personalRegistrationOpen && (
          <p className="mt-3 text-center text-sm text-muted-foreground">
            没有账号？
            <Link
              to={loginPathWithReturnTo("/p/register", returnTo)}
              className="mx-1 font-medium text-primary underline-offset-4 hover:underline"
            >
              用邀请码注册
            </Link>
          </p>
        )}
      </div>
    </LoginShell>
  );
}

// 供 App.tsx 路由级懒加载
export default PersonalLoginPage;
