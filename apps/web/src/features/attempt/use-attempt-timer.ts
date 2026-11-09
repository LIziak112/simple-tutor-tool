import { useEffect, useMemo, useState } from "react";
import { useDueCountdown } from "./use-due-countdown";

/**
 * 作答计时（阶段 B 做题工作区改版，2026-11）：把「已用时长」与「距截止」两条
 * 时间线收成一个 hook，供顶栏计时块消费。
 * - 已用时长以服务端 `attempt.startedAt` 为基线（刷新/换设备不归零；客户端
 *   时钟偏差只影响展示，不参与任何判分或提交）；每秒重算一次，后台节流
 *   恢复后按 Date.now() 自校正；
 * - 距截止复用 useDueCountdown（归零回调语义不变：只有运行中归零才触发），
 *   dueAt 为 null（课程练习不限截止）时 remaining 为 null；
 * - 只做纯展示态，**不含任何自动交卷逻辑**——截止后能否继续作答由服务端判定，
 *   前端不替服务端做决定（AGENTS.md「服务端判分」防线）。
 *
 * 消费方应把本 hook 放在独立的小组件里（AttemptTimerChip）：每秒 tick 只
 * 重渲染计时块，不波及整卷题卡。
 */
export interface AttemptTimerState {
  /** 已用秒数（startedAt 不可解析时为 0） */
  elapsedSeconds: number;
  /** 已用时长文案：mm:ss，满一小时后 h:mm:ss */
  elapsedLabel: string;
  /** 距截止：null = 无截止（课程练习）；否则为倒计时文案与到期态 */
  remaining: { label: string; expired: boolean; urgent: boolean } | null;
}

/** 距截止不足 10 分钟视为紧迫（计时块换强调色，不弹窗不打断） */
const URGENT_REMAINING_MS = 10 * 60_000;

export function formatElapsed(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 倒计时紧凑文案（计时块宽度有限）：天/小时级只到分钟，分钟级带秒 */
function compactRemaining(countdown: {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}): string {
  if (countdown.days > 0) return `${countdown.days} 天 ${countdown.hours} 小时`;
  if (countdown.hours > 0)
    return `${countdown.hours} 小时 ${countdown.minutes} 分`;
  return `${countdown.minutes} 分 ${String(countdown.seconds).padStart(2, "0")} 秒`;
}

export function useAttemptTimer({
  startedAt,
  dueAt,
  onDue,
}: {
  /** 开始作答时间（UTC ISO，attempt.startedAt） */
  startedAt: string;
  /** 截止时间（UTC ISO）；null = 不限截止 */
  dueAt: string | null;
  /** 运行中到达截止时的回调（如重取详情）；可选 */
  onDue?: (() => void) | undefined;
}): AttemptTimerState {
  const startedMs = useMemo(() => {
    const parsed = Date.parse(startedAt);
    return Number.isNaN(parsed) ? null : parsed;
  }, [startedAt]);
  const elapsedOf = (nowMs: number) =>
    startedMs === null
      ? 0
      : Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  const [elapsedSeconds, setElapsedSeconds] = useState(() =>
    elapsedOf(Date.now()),
  );
  useEffect(() => {
    if (startedMs === null) {
      setElapsedSeconds(0);
      return;
    }
    const tick = () =>
      setElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - startedMs) / 1000)),
      );
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedMs]);

  const countdown = useDueCountdown(dueAt, { onExpire: onDue });
  const remaining =
    dueAt === null
      ? null
      : countdown.isExpired
        ? { label: "已截止", expired: true, urgent: false }
        : {
            label: compactRemaining(countdown),
            expired: false,
            urgent: countdown.remainingMs <= URGENT_REMAINING_MS,
          };

  return {
    elapsedSeconds,
    elapsedLabel: formatElapsed(elapsedSeconds),
    remaining,
  };
}
