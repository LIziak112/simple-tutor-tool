import { useEffect } from "react";
import { Link, Navigate, useParams } from "react-router";
import { useStudentLinkLogin } from "@/features/auth/student-auth";
import { ApiError } from "@/lib/api";
import { ScreenError, ScreenLoading } from "./StudentScreen";

/**
 * /s/:token 学生专属链接登录页（T2.3，§5.7 专属链接）。
 * 挂载即调 GET /api/public/s/:token：成功（Cookie 已写 + me 缓存已更新）跳 /s/home；
 * 失败（401 LINK_INVALID 等）显示中文指引与「去密码登录」入口。
 * StrictMode 双挂载会触发两次 mutate——登录幂等（重复登录只是多写一行会话）。
 */
export default function StudentLinkLoginPage() {
  const { token = "" } = useParams<{ token: string }>();
  const linkLogin = useStudentLinkLogin();
  // mutate 引用在 TanStack Query 中稳定（可安全进依赖；对象本身每次渲染都是新引用）
  const { mutate: loginByLink } = linkLogin;

  useEffect(() => {
    if (token.length > 0) {
      loginByLink(token);
    }
  }, [token, loginByLink]);

  // 尚未提交（isIdle，挂载第一帧）与提交后等待中都显示加载——
  // 避免把「还没开始」误判成「已成功」而提前跳转
  if (linkLogin.isPending || linkLogin.isIdle) {
    return <ScreenLoading text="正在通过专属链接登录…" />;
  }

  if (linkLogin.isError) {
    const err = linkLogin.error;
    const isLinkInvalid =
      err instanceof ApiError &&
      (err.code === "LINK_INVALID" || err.code === "UNAUTHORIZED");
    if (isLinkInvalid) {
      return (
        <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground">
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
        </main>
      );
    }
    return (
      <ScreenError
        message={err instanceof Error ? err.message : "网络异常，请稍后重试"}
        onRetry={() => linkLogin.mutate(token)}
      />
    );
  }

  // 登录成功（Cookie 已写、me 缓存已更新）：replace 不把 token 链接留在历史栈
  return <Navigate to="/s/home" replace />;
}
