import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import {
  type PortalId,
  usePortalRoutes,
} from "@/features/runtime/portal-runtime";
import { BRAND_NAME, BRAND_TAGLINE } from "@/lib/brand";
import { loginPathWithReturnTo } from "./return-navigation";

/** 七个认证页面共用导航壳，等待、失败和关闭注册时也保留出口。 */
export function LoginShell({
  portal,
  children,
}: {
  portal: PortalId;
  children: ReactNode;
}) {
  const PORTALS = usePortalRoutes().all;
  const [params] = useSearchParams();
  const otherPortals = (Object.keys(PORTALS) as PortalId[]).filter(
    (id) => id !== portal,
  );
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-6 py-8 text-foreground">
      <header className="text-center">
        <Link
          to="/"
          aria-label="返回首页"
          className="flex min-h-11 items-center rounded-lg px-3 text-xl font-semibold outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary"
        >
          {BRAND_NAME}
        </Link>
        <p lang="en" className="mt-1 text-xs text-muted-foreground">
          {BRAND_TAGLINE}
        </p>
      </header>
      <div className="flex w-full flex-col items-center gap-6">{children}</div>
      <nav
        aria-label="切换登录端口"
        className="flex max-w-lg flex-wrap items-center justify-center gap-x-2 text-sm text-muted-foreground"
      >
        <span>切换登录端口</span>
        {otherPortals.map((id) => (
          <Link
            key={id}
            to={loginPathWithReturnTo(
              PORTALS[id].loginPath,
              id === "admin" ? PORTALS.admin.homePath : params.get("returnTo"),
            )}
            className="flex min-h-11 items-center rounded-lg px-2 font-medium text-primary hover:bg-accent"
          >
            {PORTALS[id].label}
          </Link>
        ))}
      </nav>
    </main>
  );
}
