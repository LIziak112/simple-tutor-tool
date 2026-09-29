import { teacherLoginNameSchema, teacherPasswordSchema } from "@tutor/contract";
import { Loader2, LockKeyhole, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useSetupTeacher,
  useTeacherStatus,
} from "@/features/auth/teacher-auth";
import { ApiError } from "@/lib/api";

/**
 * /t/setup 首次启动创建教师账号（T2B.2 起表单 = 登录名 + 密码，D4；
 * 创建的必是第一位教师，即管理员）。
 * 分流（三态齐全）：
 * - status 加载中 → 全屏加载；
 * - status 失败 → 错误态 + 重试；
 * - 已设置教师 → 直接跳 /t/login（本页只在首启可用）。
 * 提交前用共享契约的登录名与密码策略做同款校验（与服务端同一份规则）；
 * 登录名默认建议 teacher（与存量迁移一致），可改。
 */
export function SetupPage() {
  const statusQuery = useTeacherStatus();
  const setupMutation = useSetupTeacher();
  const navigate = useNavigate();

  const [loginName, setLoginName] = useState("teacher");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
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
  if (statusQuery.data.hasTeacher) {
    // 已设置过教师：setup 入口失效，去登录
    return <Navigate to="/t/login" replace />;
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
    if (password !== confirmPassword) {
      setFormError("两次输入的密码不一致");
      return;
    }
    setFormError(null);
    setupMutation.mutate(
      { loginName: parsedName.data, password },
      {
        onSuccess: () => {
          // 设置成功即自动登录，进入教师端
          navigate("/t", { replace: true });
        },
      },
    );
  }

  const serverError =
    setupMutation.error instanceof ApiError
      ? setupMutation.error.message
      : setupMutation.error instanceof Error
        ? setupMutation.error.message
        : null;
  // 表单本地校验错误优先展示；否则展示服务端错误（如已被其他设备设置）
  const shownError = formError ?? serverError;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-6 text-foreground">
      <header className="text-center">
        <h1 className="flex items-center justify-center gap-2 text-2xl font-semibold">
          <LockKeyhole aria-hidden className="size-6" />
          初始化教师账号
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          首次使用，请设置教师账号的登录名与密码
        </p>
      </header>

      <form
        noValidate
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm"
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="setup-login-name" className="text-sm font-medium">
              登录名
            </label>
            <Input
              id="setup-login-name"
              type="text"
              name="loginName"
              autoComplete="username"
              placeholder="默认 teacher，可修改"
              value={loginName}
              aria-invalid={shownError != null}
              onChange={(e) => setLoginName(e.target.value)}
              disabled={setupMutation.isPending}
            />
            <p className="text-xs text-muted-foreground">
              2–32
              个字符，可用中文、字母、数字、下划线或连字符；创建后即首位管理员。
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="setup-password" className="text-sm font-medium">
              密码
            </label>
            <Input
              id="setup-password"
              type="password"
              name="password"
              autoComplete="new-password"
              placeholder="至少 8 个字符"
              value={password}
              aria-invalid={shownError != null}
              onChange={(e) => setPassword(e.target.value)}
              disabled={setupMutation.isPending}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="setup-confirm" className="text-sm font-medium">
              确认密码
            </label>
            <Input
              id="setup-confirm"
              type="password"
              name="confirm-password"
              autoComplete="new-password"
              placeholder="再输入一次"
              value={confirmPassword}
              aria-invalid={shownError != null}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={setupMutation.isPending}
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
            disabled={setupMutation.isPending}
          >
            {setupMutation.isPending ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                正在创建…
              </>
            ) : (
              "创建账号并进入"
            )}
          </Button>

          {setupMutation.error instanceof ApiError &&
            setupMutation.error.code === "TEACHER_EXISTS" && (
              <p className="text-center text-sm text-muted-foreground">
                教师已设置，可
                <Link
                  to="/t/login"
                  className="mx-1 text-primary underline-offset-4 hover:underline"
                >
                  直接登录
                </Link>
              </p>
            )}
        </div>
      </form>

      <p className="max-w-sm text-center text-xs text-muted-foreground">
        密码以 scrypt 哈希存放在本机数据库，请妥善保管；忘记密码需按文档重置。
      </p>
    </main>
  );
}

/** 认证页通用的全屏加载态 */
export function AuthScreenLoading({ text }: { text: string }) {
  return (
    <main
      aria-live="polite"
      className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background text-foreground"
    >
      <Loader2
        aria-hidden
        className="size-6 animate-spin text-muted-foreground"
      />
      <p className="text-sm text-muted-foreground">{text}</p>
    </main>
  );
}

/** 认证页通用的错误态（原因 + 重试） */
export function AuthScreenError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
      <TriangleAlert aria-hidden className="size-8 text-destructive" />
      <p className="text-sm font-medium text-destructive">无法完成请求</p>
      <p className="max-w-sm text-xs break-all text-muted-foreground">
        {message}
      </p>
      <Button variant="outline" className="min-h-11 px-6" onClick={onRetry}>
        重试
      </Button>
    </main>
  );
}

// 供 App.tsx 路由级懒加载
export default SetupPage;
