import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { ApiError } from "@/lib/api";
import { AuthScreenError, AuthScreenLoading } from "./AuthScreen";
import { loginPathWithReturnTo, PORTALS, type PortalId } from "./portals";

export function PortalGuard<T>({
  portal,
  loginPath = PORTALS[portal].loginPath,
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
  const location = useLocation();
  if (query.isError) {
    if (
      query.error instanceof ApiError &&
      query.error.code === "UNAUTHORIZED"
    ) {
      const returnTo = `${location.pathname}${location.search}${location.hash}`;
      return (
        <Navigate to={loginPathWithReturnTo(loginPath, returnTo)} replace />
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
