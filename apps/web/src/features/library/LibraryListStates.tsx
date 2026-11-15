import { CircleAlert, FileStack, Plus } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { usePortalRoutes } from "@/features/runtime/portal-runtime";
export function ListSkeleton({ label }: { label: string }) {
  return (
    <div aria-live="polite" className="mt-3 space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-14 animate-pulse rounded-lg bg-muted" />
      ))}
      <p className="text-center text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
export function ListError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="mt-3 flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-12 text-center"
    >
      <CircleAlert aria-hidden className="size-8 text-destructive" />
      <p className="text-sm font-medium text-destructive">加载失败</p>
      <p className="max-w-sm text-xs break-all text-muted-foreground">
        {message}
      </p>
      <Button variant="outline" className="min-h-11 px-6" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}
export function LibraryEmpty() {
  const routes = usePortalRoutes();

  return (
    <div className="mt-3 flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <FileStack aria-hidden className="size-10 text-muted-foreground" />
      <p className="text-sm font-medium">这里还没有内容</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        把练习或讲义的 Markdown 文档导入资源库，就能布置作业、组织课程。
      </p>
      <Button asChild className="mt-2 min-h-11 px-5">
        <Link to={routes.management("import")}>
          <Plus aria-hidden />
          去导入第一份文档
        </Link>
      </Button>
    </div>
  );
}
