import {
  personalInviteCodeSchema,
  teacherLoginNameSchema,
  teacherPasswordSchema,
} from "@tutor/contract";
import { Loader2, TriangleAlert, UserRoundPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthScreenError, AuthScreenLoading } from "@/features/auth/AuthScreen";
import { LoginShell } from "@/features/auth/LoginShell";
import { useRegisterPersonal } from "@/features/auth/personal-auth";
import { useTeacherStatus } from "@/features/auth/teacher-auth";
import { loginPathWithReturnTo, safeReturnTo } from "@/portals/registry";

/**
 * /p/register 个人学习账号自助注册（模块 0，Q7 定案 b：邀请码）。
 * 分流：status 加载中 → 全屏加载；失败 → 错误态 + 重试；未首启 → 跳 /t/setup；
 * 未开放（管理员未配置邀请码）→ 关闭态提示；开放 → 登录名 + 密码 + 邀请码
 * （+ 可选昵称）表单，前后端同一份契约校验。成功即双会话登录，落点 /s/home。
 * 服务端错误：INVITE_CODE_INVALID / PERSONAL_REGISTRATION_DISABLED（刚被关）/
 * TEACHER_LOGIN_EXISTS / LOCKED / TEACHER_NOT_EXISTS（首启被撤销的极端态）。
 */

export function PersonalRegisterPage() {
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo");
  const statusQuery = useTeacherStatus();
  const registerMutation = useRegisterPersonal();
  const navigate = useNavigate();

  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  if (statusQuery.isPending) {
    return (
      <LoginShell portal="personal">
        <AuthScreenLoading text="正在检查注册状态…" />
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
  if (!statusQuery.data.personalRegistrationOpen) {
    return <PersonalRegistrationClosed />;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    const parsedCode = personalInviteCodeSchema.safeParse(inviteCode);
    if (!parsedCode.success) {
      setFormError(parsedCode.error.issues[0]?.message ?? "请输入邀请码");
      return;
    }
    setFormError(null);
    const trimmedDisplayName = displayName.trim();
    registerMutation.mutate(
      {
        loginName: parsedName.data,
        password,
        inviteCode: parsedCode.data,
        ...(trimmedDisplayName.length > 0
          ? { displayName: trimmedDisplayName }
          : {}),
      },
      {
        onSuccess: () =>
          navigate(safeReturnTo(returnTo, "personal"), { replace: true }),
      },
    );
  }

  const shownError =
    formError ??
    (registerMutation.error instanceof Error
      ? registerMutation.error.message
      : null);
  const disabled = registerMutation.isPending;

  return (
    <LoginShell portal="personal">
      <header className="text-center">
        <h1 className="flex items-center justify-center gap-2 text-2xl font-semibold">
          <UserRoundPlus aria-hidden className="size-6" />
          注册个人学习账号
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          自己导入资料、自己练习、自己看学情；需要管理员提供的邀请码
        </p>
      </header>

      <form
        noValidate
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm"
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="personal-register-login-name"
              className="text-sm font-medium"
            >
              登录名
            </label>
            <Input
              id="personal-register-login-name"
              type="text"
              name="loginName"
              autoComplete="username"
              placeholder="2–32 个字符，可用中文、字母、数字"
              value={loginName}
              aria-invalid={shownError != null}
              onChange={(e) => setLoginName(e.target.value)}
              disabled={disabled}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="personal-register-password"
              className="text-sm font-medium"
            >
              密码
            </label>
            <Input
              id="personal-register-password"
              type="password"
              name="password"
              autoComplete="new-password"
              placeholder="至少 8 个字符"
              value={password}
              aria-invalid={shownError != null}
              onChange={(e) => setPassword(e.target.value)}
              disabled={disabled}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="personal-register-invite-code"
              className="text-sm font-medium"
            >
              邀请码
            </label>
            <Input
              id="personal-register-invite-code"
              type="text"
              name="inviteCode"
              autoComplete="one-time-code"
              placeholder="向管理员索取"
              value={inviteCode}
              aria-invalid={shownError != null}
              onChange={(e) => setInviteCode(e.target.value)}
              disabled={disabled}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="personal-register-display-name"
              className="text-sm font-medium"
            >
              昵称
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                （可选，缺省用登录名）
              </span>
            </label>
            <Input
              id="personal-register-display-name"
              type="text"
              name="displayName"
              autoComplete="nickname"
              placeholder="学习视角里显示的名字"
              maxLength={32}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={disabled}
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

          <Button type="submit" className="min-h-11 w-full" disabled={disabled}>
            {disabled ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                正在注册…
              </>
            ) : (
              "注册并开始学习"
            )}
          </Button>
        </div>
      </form>

      <p className="max-w-sm text-center text-xs text-muted-foreground">
        已有账号？
        <Link
          to={loginPathWithReturnTo("/p/login", returnTo)}
          className="mx-1 text-primary underline-offset-4 hover:underline"
        >
          直接登录
        </Link>
      </p>
    </LoginShell>
  );
}

/** 关闭态：管理员尚未配置邀请码（status.personalRegistrationOpen=false） */
function PersonalRegistrationClosed() {
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo");
  return (
    <LoginShell portal="personal">
      <TriangleAlert aria-hidden className="size-10 text-muted-foreground" />
      <h1 className="text-xl font-semibold">个人学习注册未开放</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        本站尚未开放个人学习账号注册。管理员在管理端配置邀请码后，这里即可凭邀请码注册。
      </p>
      <Button variant="outline" className="min-h-11 px-6" asChild>
        <Link to={loginPathWithReturnTo("/p/login", returnTo)}>返回登录</Link>
      </Button>
    </LoginShell>
  );
}

// 供 App.tsx 路由级懒加载
export default PersonalRegisterPage;
