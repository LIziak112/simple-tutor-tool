import { Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/** 登录页和各门户守卫共用的等待、失败状态。 */
export function AuthScreenLoading({ text }: { text: string }) {
  return (
    <div
      aria-live="polite"
      className="flex flex-col items-center justify-center gap-3 py-12 text-center"
    >
      <Loader2
        aria-hidden
        className="size-6 animate-spin text-muted-foreground"
      />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

export function AuthScreenError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center"
    >
      <TriangleAlert aria-hidden className="size-8 text-destructive" />
      <p className="text-sm font-medium text-destructive">无法完成请求</p>
      <p className="max-w-sm text-xs break-all text-muted-foreground">
        {message}
      </p>
      <Button variant="outline" className="min-h-11 px-6" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}
