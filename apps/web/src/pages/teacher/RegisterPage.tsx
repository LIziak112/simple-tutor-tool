import { teacherLoginNameSchema, teacherPasswordSchema } from "@tutor/contract";
import { Loader2, TriangleAlert, UserRoundPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useRegisterTeacher,
  useTeacherStatus,
} from "@/features/auth/teacher-auth";
import { ApiError } from "@/lib/api";
import { AuthScreenError, AuthScreenLoading } from "./SetupPage";

/**
 * /t/register 教师自助注册页（T2B.6，D3 来源一）。
 * 分流（三态齐全）：
 * - status 加载中 → 全屏加载；失败 → 错误态 + 重试；
 * - 未设置教师（首启未做）→ 跳 /t/setup（注册不可用，409 TEACHER_NOT_EXISTS 同口径）；
 * - 注册开关关闭 → 显示「注册已关闭，请联系管理员」+ 返回登录；
 * - 开关开 → 两字段表单（登录名 + 密码，D2/D 密码策略前后端同一份契约校验）。
 * 成功即自动登录进入 /t（新教师名下无任何资源，各页为空态）。
 * 服务端错误分支：REGISTRATION_DISABLED（开关刚被关）/ TEACHER_LOGIN_EXISTS（重名）/
 * LOCKED（同 IP 1 小时超过 5 次）/ TEACHER_NOT_EXISTS（首启被撤销的极端态）。
 */

export function RegisterPage() {
  const statusQuery = useTeacherStatus();
  const registerMutation = useRegisterTeacher();
  const navigate = useNavigate();

  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  if (statusQuery.isPending) {
    return <AuthScreenLoading text="正在检查注册状态…" />;
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
    // 尚未创建首位教师：注册不可用，先走初始化
    return <Navigate to="/t/setup" replace />;
  }
  if (!statusQuery.data.registrationOpen) {
    return <RegistrationClosed />;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // 与服务端同一份契约规则：登录名（D2 字符集与长度）+ 密码（≥8 字符）
    const parsedName = teacherLoginNameSchema.safeParse(loginName);
    if (!parsedName.success) {
      setFormError(parsedName.error.issues[0]?.message ?? "登录名格式不正确");
      return;
    }
    const parsedPassword = teacherPasswordSchema.safeParse(password);
    if (!parsedPassword.success) {
      setFormError(parsedPassword.error.issues[0]?.message ?? "密码格式不正确");
      return;
    }
    setFormError(null);
    registerMutation.mutate(
      { loginName: parsedName.data, password },
      { onSuccess: () => navigate("/t", { replace: true }) },
    );
  }

  const serverError =
    registerMutation.error instanceof ApiError &&
    registerMutation.error.code === "TEACHER_NOT_EXISTS"
      ? null // 首启被撤销的极端态：提示用户去初始化（下方链接）
      : registerMutation.error instanceof Error
        ? registerMutation.error.message
        : null;
  const shownError = formError ?? serverError;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-6 text-foreground">
      <header className="text-center">
        <h1 className="flex items-center justify-center gap-2 text-2xl font-semibold">
          <UserRoundPlus aria-hidden className="size-6" />
          注册教师账号
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          创建自己的辅导工作台，与其他老师的资料完全独立
        </p>
      </header>

      <form
        noValidate
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm"
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="register-login-name" className="text-sm font-medium">
              登录名
            </label>
            <Input
              id="register-login-name"
              type="text"
              name="loginName"
              autoComplete="username"
              placeholder="2–32 个字符，可用中文、字母、数字"
              value={loginName}
              aria-invalid={shownError != null}
              onChange={(e) => setLoginName(e.target.value)}
              disabled={registerMutation.isPending}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="register-password" className="text-sm font-medium">
              密码
            </label>
            <Input
              id="register-password"
              type="password"
              name="password"
              autoComplete="new-password"
              placeholder="至少 8 个字符"
              value={password}
              aria-invalid={shownError != null}
              onChange={(e) => setPassword(e.target.value)}
              disabled={registerMutation.isPending}
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

          {registerMutation.error instanceof ApiError &&
            registerMutation.error.code === "TEACHER_NOT_EXISTS" && (
              <p className="text-center text-sm text-muted-foreground">
                尚未创建首位教师，请先
                <Link
                  to="/t/setup"
                  className="mx-1 text-primary underline-offset-4 hover:underline"
                >
                  完成初始化
                </Link>
              </p>
            )}

          <Button
            type="submit"
            className="min-h-11 w-full"
            disabled={registerMutation.isPending}
          >
            {registerMutation.isPending ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                正在注册…
              </>
            ) : (
              "注册并进入"
            )}
          </Button>
        </div>
      </form>

      <p className="max-w-sm text-center text-xs text-muted-foreground">
        已有账号？
        <Link
          to="/t/login"
          className="mx-1 text-primary underline-offset-4 hover:underline"
        >
          直接登录
        </Link>
      </p>
    </main>
  );
}

/** 注册关闭态（管理员经管理端关闭开关后，status.registrationOpen=false） */
function RegistrationClosed() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground">
      <TriangleAlert aria-hidden className="size-10 text-muted-foreground" />
      <h1 className="text-xl font-semibold">注册已关闭，请联系管理员</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        本站已关闭教师自助注册。如需账号，请向已登录的老师或管理员索取，
        管理员可在管理端直接创建。
      </p>
      <Button variant="outline" className="min-h-11 px-6" asChild>
        <Link to="/t/login">返回登录</Link>
      </Button>
    </main>
  );
}

// 供 App.tsx 路由级懒加载
export default RegisterPage;
