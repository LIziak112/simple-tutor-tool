import { useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw, ServerCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchHealth } from "@/lib/api";
import { formatCnTime } from "@/lib/time";

/**
 * 首页：前后端联通自检页。用 TanStack Query 调 health 接口，
 * 加载中 / 错误（含重试）/ 成功 三态齐全（UI 约定硬性要求）。
 */
export function HomePage() {
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
  });
  const { data } = healthQuery;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-6 text-foreground">
      <header className="text-center">
        <h1 className="text-2xl font-semibold">辅导讲练工具</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          前端骨架 · 前后端联通自检
        </p>
      </header>

      <section
        aria-live="polite"
        className="w-full max-w-sm rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm"
      >
        {healthQuery.isPending ? (
          <p className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="animate-spin" />
            正在连接服务器…
          </p>
        ) : healthQuery.isError ? (
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <ServerCog aria-hidden className="size-6 text-destructive" />
            <p className="text-sm font-medium text-destructive">
              无法获取服务器时间
            </p>
            <p className="text-xs break-all text-muted-foreground">
              {healthQuery.error instanceof Error
                ? healthQuery.error.message
                : "网络异常，请稍后重试"}
            </p>
            {/* 触控目标不小于 44px（UI 约定），min-h-11 覆盖默认 h-8 */}
            <Button
              variant="outline"
              className="min-h-11 px-6"
              onClick={() => void healthQuery.refetch()}
            >
              <RefreshCw aria-hidden />
              重试
            </Button>
          </div>
        ) : data ? (
          <div className="flex flex-col items-center gap-2 py-2 text-center">
            <p className="text-xs text-muted-foreground">
              服务器时间（Asia/Shanghai）
            </p>
            <p className="text-lg font-semibold tabular-nums">
              {formatCnTime(data.time)}
            </p>
            <p className="text-xs text-muted-foreground">UTC {data.time}</p>
            <Button
              variant="outline"
              className="mt-1 min-h-11 px-6"
              disabled={healthQuery.isFetching}
              onClick={() => void healthQuery.refetch()}
            >
              <RefreshCw
                aria-hidden
                className={healthQuery.isFetching ? "animate-spin" : undefined}
              />
              刷新
            </Button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
