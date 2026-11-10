import {
  type AttemptTiming,
  type AttemptTimingPhase,
  attemptTimingPhaseOf,
} from "@tutor/contract";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * 限时测试的本机时钟（模块 2）：以服务端下发的 timing 为准——
 * - 在详情响应到达时记下与 serverNow 对应的浏览器单调时刻，随查询缓存保存；
 * - 倒计时每秒更新，答题会话只订阅阶段边界；
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
  clockAnchor?: number,
): AttemptClock | null {
  const readClock = useClockReader(timing, clockAnchor);
  const [, setTick] = useState(0);
  const phase = readClock()?.phase;
  useEffect(() => {
    if (phase === undefined || phase === "locked") return;
    const tick = () => setTick((previous) => previous + 1);
    const id = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [phase]);
  return readClock();
}

function useClockReader(
  timing: AttemptTiming | null | undefined,
  clockAnchor?: number,
) {
  const offset = useMemo(
    () =>
      timing
        ? Date.parse(timing.serverNow) - (clockAnchor ?? performance.now())
        : 0,
    [timing, clockAnchor],
  );
  return useCallback(
    () => (timing ? clockOf(timing, offset, performance.now()) : null),
    [timing, offset],
  );
}

export function useAttemptPhase(
  timing: AttemptTiming | null | undefined,
  clockAnchor?: number,
): AttemptTimingPhase | null {
  const readClock = useClockReader(timing, clockAnchor);
  const readPhase = useCallback(() => readClock()?.phase ?? null, [readClock]);
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!timing) return () => {};
      let timer: number | undefined;
      const schedule = () => {
        window.clearTimeout(timer);
        const clock = readClock();
        if (clock === null || clock.phase === "locked") return;
        timer = window.setTimeout(
          () => {
            notify();
            schedule();
          },
          Math.ceil(
            clock.phase === "running"
              ? clock.remainingMs
              : clock.graceRemainingMs,
          ),
        );
      };
      const resume = () => {
        notify();
        schedule();
      };
      schedule();
      document.addEventListener("visibilitychange", resume);
      window.addEventListener("online", resume);
      return () => {
        window.clearTimeout(timer);
        document.removeEventListener("visibilitychange", resume);
        window.removeEventListener("online", resume);
      };
    },
    [timing, readClock],
  );
  return useSyncExternalStore(subscribe, readPhase);
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
