import { Hourglass, Timer } from "lucide-react";
import { useAttemptTimer } from "./use-attempt-timer";

/**
 * 顶栏计时块（阶段 B 做题工作区改版，2026-11）：已用时长 + 距截止。
 * 独立组件承载 useAttemptTimer 的每秒 tick——重渲染只落在本块，整卷题卡不动。
 * 纯展示：不含自动交卷、不改变作答能力；截止后文案「已截止」如实呈现，
 * 能否继续作答仍由服务端判定。
 */
export function AttemptTimerChip({
  startedAt,
  dueAt,
  onDue,
  className,
}: {
  startedAt: string;
  dueAt: string | null;
  onDue?: (() => void) | undefined;
  className?: string | undefined;
}) {
  const timer = useAttemptTimer({ startedAt, dueAt, onDue });
  return (
    <span
      data-slot="attempt-timer"
      className={`inline-flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground ${className ?? ""}`}
    >
      <span className="inline-flex items-center gap-1" title="已用时长">
        <Timer aria-hidden className="size-3.5" />
        已用 {timer.elapsedLabel}
      </span>
      {timer.remaining !== null && (
        <span
          role={timer.remaining.urgent ? "status" : undefined}
          aria-live={timer.remaining.urgent ? "polite" : undefined}
          className={`inline-flex items-center gap-1 ${
            timer.remaining.expired
              ? "text-destructive"
              : timer.remaining.urgent
                ? "font-medium text-amber-600 dark:text-amber-400"
                : ""
          }`}
          title="距截止"
        >
          <Hourglass aria-hidden className="size-3.5" />
          {timer.remaining.expired
            ? "已截止"
            : `距截止 ${timer.remaining.label}`}
        </span>
      )}
    </span>
  );
}
