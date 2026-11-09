import {
  type AttemptTiming,
  type AttemptTimingPhase,
  attemptTimingPhaseOf,
} from "@tutor/contract";
import { useEffect, useMemo, useState } from "react";

/**
 * 限时测试的本机时钟（模块 2）：以服务端下发的 timing 为准——
 * - offset = serverNow - 本机 Date.now()（响应到达那一刻算一次，含网络时延，
 *   秒级足够）；剩余时间 = deadlineAt - (Date.now() + offset)，不信任本机时钟；
 * - 每秒一拍，阶段按契约纯函数 attemptTimingPhaseOf 判定（与服务端同口径）；
 * - 非限时卷（timing null / undefined）返回 null，调用方零变化。
 */
export interface AttemptClock {
  phase: AttemptTimingPhase;
  /** 距截止的剩余毫秒（到时后为 0） */
  remainingMs: number;
  /** 宽限剩余毫秒（running 时 = 整个宽限；locked 为 0） */
  graceRemainingMs: number;
  deadlineAt: string;
  timeLimitSec: number;
}

export function clockOf(
  timing: AttemptTiming,
  offsetMs: number,
  now: number,
): AttemptClock {
  const serverNow = now + offsetMs;
  const deadline = Date.parse(timing.deadlineAt);
  const graceEnd = deadline + timing.graceSec * 1000;
  return {
    phase: attemptTimingPhaseOf(timing.deadlineAt, timing.graceSec, serverNow),
    remainingMs: Math.max(0, deadline - serverNow),
    graceRemainingMs: Math.max(0, graceEnd - Math.max(serverNow, deadline)),
    deadlineAt: timing.deadlineAt,
    timeLimitSec: timing.timeLimitSec,
  };
}

export function useAttemptClock(
  timing: AttemptTiming | null | undefined,
): AttemptClock | null {
  // 时钟偏移：timing 对象每次 refetch 都是新引用 → 每次响应到达重算一次
  const offsetMs = useMemo(
    () => (timing ? Date.parse(timing.serverNow) - Date.now() : 0),
    [timing],
  );
  const [now, setNow] = useState(() => Date.now());
  const active = timing !== null && timing !== undefined;
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return timing ? clockOf(timing, offsetMs, now) : null;
}

/** mm:ss（≥ 1 小时显示 h:mm:ss） */
export function formatRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 「限时 N 分钟」 / 「限时 1 小时 30 分钟」 */
export function formatTimeLimit(timeLimitSec: number): string {
  const minutes = Math.round(timeLimitSec / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分钟`;
}
