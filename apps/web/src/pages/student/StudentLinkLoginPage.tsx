import { Link, Navigate, useParams } from "react-router";
import { AuthScreenError, AuthScreenLoading } from "@/features/auth/AuthScreen";
import { LoginShell } from "@/features/auth/LoginShell";
import { useStudentLinkEntry } from "@/features/auth/use-student-link-entry";
import { useStudentTheme } from "@/features/student/use-student-theme";
import { ApiError } from "@/lib/api-response";

/**
 * /s/:token 学生专属链接登录页（T2.3，§5.7 专属链接）。
 * 挂载即调 GET /api/public/s/:token：成功（Cookie 已写 + me 缓存已更新）跳 /s/home；
 * 失败（401 LINK_INVALID 等）显示中文指引与「去密码登录」入口。
 * 自动入口拥有兑换生命周期，StrictMode 重放只发一次，切换/卸载会取消旧请求。
 */
export default function StudentLinkLoginPage() {
  useStudentTheme();
  const { token = "" } = useParams<{ token: string }>();
  const linkLogin = useStudentLinkEntry(token);

  if (linkLogin.isPending) {
    return (
      <LoginShell portal="student">
        <AuthScreenLoading text="正在通过专属链接登录…" />
      </LoginShell>
    );
  }

  if (linkLogin.isError) {
    const err = linkLogin.error;
    const isLinkInvalid =
      err instanceof ApiError &&
      (err.code === "LINK_INVALID" || err.code === "UNAUTHORIZED");
    if (isLinkInvalid) {
      return (
        <LoginShell portal="student">
          <h1 className="text-lg font-semibold">链接已失效</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            这条专属链接不存在或已被重置。请联系老师重新发送链接，
            或改用登录名和密码登录。
          </p>
          <Link
            to="/s/login"
            className="flex min-h-11 items-center rounded-lg bg-primary px-6 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            去密码登录
          </Link>
        </LoginShell>
      );
    }
    return (
      <LoginShell portal="student">
        <AuthScreenError
          message={err instanceof Error ? err.message : "网络异常，请稍后重试"}
          onRetry={linkLogin.retry}
        />
      </LoginShell>
    );
  }

  // 登录成功（Cookie 已写、me 缓存已更新）：replace 不把 token 链接留在历史栈
  return <Navigate to="/s/home" replace />;
}
