import { useEffect, useMemo, useRef, useState } from "react";

/**
 * 截止倒计时分解数据
 */
export interface DueCountdown {
  /** 剩余天数 */
  days: number;
  /** 剩余小时（0-23） */
  hours: number;
  /** 剩余分钟（0-59） */
  minutes: number;
  /** 剩余秒数（0-59） */
  seconds: number;
  /** 剩余总毫秒数 */
  remainingMs: number;
  /** 是否已到达或超过截止时间（包含 null） */
  isExpired: boolean;
  /** 格式化显示文本（如 "2天 3小时 4分 5秒"，过期为 "已截止"） */
  formatted: string;
}

/**
 * 计算剩余时间的纯函数
 */
function calculateCountdown(
  targetMs: number | null,
  nowMs: number,
): DueCountdown {
  if (targetMs === null || Number.isNaN(targetMs)) {
    return {
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      remainingMs: 0,
      isExpired: true,
      formatted: "已截止",
    };
  }

  const diff = targetMs - nowMs;
  if (diff <= 0) {
    return {
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      remainingMs: 0,
      isExpired: true,
      formatted: "已截止",
    };
  }

  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0 || days > 0) parts.push(`${hours}小时`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}分`);
  parts.push(`${seconds}秒`);

  return {
    days,
    hours,
    minutes,
    seconds,
    remainingMs: diff,
    isExpired: false,
    formatted: parts.join(" "),
  };
}

/**
 * 截止倒计时 Hook
 * - 每秒动态递减；
 * - 倒计时归零时触发 onExpire（仅触发一次）；
 * - 优雅处理 dueAt === null 或已过期。
 */
export function useDueCountdown(
  dueAt: string | null,
  options?: {
    onExpire?: (() => void) | undefined;
  },
): DueCountdown {
  const targetMs = useMemo(() => {
    if (!dueAt) return null;
    const parsed = Date.parse(dueAt);
    return Number.isNaN(parsed) ? null : parsed;
  }, [dueAt]);

  const [countdown, setCountdown] = useState<DueCountdown>(() =>
    calculateCountdown(targetMs, Date.now()),
  );

  const onExpireRef = useRef(options?.onExpire);
  onExpireRef.current = options?.onExpire;

  // 记录是否已经触发过到期回调；如果 targetMs 改变则重置
  const hasTriggeredRef = useRef(false);
  const lastTargetMsRef = useRef(targetMs);
  if (lastTargetMsRef.current !== targetMs) {
    lastTargetMsRef.current = targetMs;
    // 如果之前就是已过期（比如一进页面就已经过期），初始不触发；
    // 只有在运行中倒计时归零时触发。
    const initial = calculateCountdown(targetMs, Date.now());
    hasTriggeredRef.current = initial.isExpired;
  }

  // 首次渲染若已过期，标记已触发防误报
  useEffect(() => {
    if (targetMs === null || Date.now() >= targetMs) {
      hasTriggeredRef.current = true;
    }
  }, [targetMs]);

  useEffect(() => {
    if (targetMs === null) {
      setCountdown(calculateCountdown(null, Date.now()));
      return;
    }

    const initial = calculateCountdown(targetMs, Date.now());
    setCountdown(initial);

    if (initial.isExpired) {
      return;
    }

    const timer = setInterval(() => {
      const next = calculateCountdown(targetMs, Date.now());
      setCountdown(next);

      if (next.isExpired) {
        clearInterval(timer);
        if (!hasTriggeredRef.current) {
          hasTriggeredRef.current = true;
          onExpireRef.current?.();
        }
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [targetMs]);

  return countdown;
}
