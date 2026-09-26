import { Link } from "react-router";

/** 兜底 404 页：生产环境由 server 的 SPA 回退进入前端路由 */
export function NotFoundPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
      <h1 className="text-xl font-semibold">页面不存在</h1>
      <p className="text-sm text-muted-foreground">
        地址可能已失效或输入有误。
      </p>
      <Link
        to="/"
        className="mt-2 inline-flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground"
      >
        返回首页
      </Link>
    </main>
  );
}
