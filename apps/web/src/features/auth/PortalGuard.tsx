import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import {
  type PortalId,
  usePortalRoutes,
} from "@/features/runtime/portal-runtime";
import { ApiError } from "@/lib/api-response";
import { AuthScreenError, AuthScreenLoading } from "./AuthScreen";
import { loginPathWithReturnTo } from "./return-navigation";

export function PortalGuard<T>({
  portal,
  loginPath,
  query,
  children,
}: {
  portal: PortalId;
  loginPath?: string;
  query: {
    isPending: boolean;
    isError: boolean;
    data: T | undefined;
    error: unknown;
    refetch: () => unknown;
  };
  children: (data: T) => ReactNode;
}) {
  const routes = usePortalRoutes();
  const destination = loginPath ?? routes.portal(portal).loginPath;
  const location = useLocation();
  if (query.isError) {
    if (
      query.error instanceof ApiError &&
      query.error.code === "UNAUTHORIZED"
    ) {
      const returnTo = `${location.pathname}${location.search}${location.hash}`;
      return (
        <Navigate to={loginPathWithReturnTo(destination, returnTo)} replace />
      );
    }
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
        <AuthScreenError
          message={
            query.error instanceof Error
              ? query.error.message
              : "网络异常，请稍后重试"
          }
          onRetry={() => void query.refetch()}
        />
      </main>
    );
  }
  if (query.isPending || query.data === undefined)
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
        <AuthScreenLoading text="正在确认登录状态…" />
      </main>
    );
  return children(query.data);
}
