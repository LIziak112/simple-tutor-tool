import { Button } from "@/components/ui/button";

export interface ErrorRetryProps {
  readonly message: string;
  readonly onRetry: () => void;
  readonly retryLabel?: string;
  readonly title?: string;
  readonly className?: string;
}

/**
 * 共享加载失败重试块（触控目标 ≥44px，提供无障碍 alert 语义）
 */
export function ErrorRetry({
  message,
  onRetry,
  retryLabel = "重试",
  title,
  className,
}: ErrorRetryProps) {
  return (
    <div
      role="alert"
      className={className ?? "flex flex-col items-start gap-2"}
    >
      {title && <p className="text-sm font-medium text-destructive">{title}</p>}
      <p
        className={
          title ? "text-sm text-muted-foreground" : "text-sm text-destructive"
        }
      >
        {message}
      </p>
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        onClick={onRetry}
      >
        {retryLabel}
      </Button>
    </div>
  );
}
