import { Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * 学生端全屏兜底组件（T2.3）：登录链接页 / 守卫等待期共用，
 * 与教师端 SetupPage 的 AuthScreen* 同构（学生端分区自持一份，避免跨区依赖）。
 */

/** 全屏加载（spinner + 说明文字，不白屏） */
export function ScreenLoading({ text }: { text: string }) {
  return (
    <main
      aria-live="polite"
      className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background text-foreground"
    >
      <Loader2
        aria-hidden
        className="size-6 animate-spin text-muted-foreground"
      />
      <p className="text-sm text-muted-foreground">{text}</p>
    </main>
  );
}

/** 全屏错误态（原因 + 重试按钮） */
export function ScreenError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
      <TriangleAlert aria-hidden className="size-8 text-destructive" />
      <p className="text-sm font-medium text-destructive">出了点问题</p>
      <p className="max-w-sm text-xs break-all text-muted-foreground">
        {message}
      </p>
      <Button variant="outline" className="min-h-11 px-6" onClick={onRetry}>
        重试
      </Button>
    </main>
  );
}
