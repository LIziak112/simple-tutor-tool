import {
  ATTEMPT_TIME_UP_GRACE_SEC,
  type AttemptTiming,
  attemptTimingPhaseOf,
} from "@tutor/contract";
import type { Attempt } from "../db/schema";
import { HttpError } from "../lib/http-error";

/**
 * 限时测试（个人学习迭代模块 2，2026-11）服务端时钟——唯一实现：
 * - 建卷：学习者自选 timeLimitMinutes → 行上持久化 timeLimitSec 与 deadlineAt
 *   （= startedAt + 时长），时钟以服务端为准，换设备 / 后台 / 重连同一剩余时间；
 * - 读：草稿视图下发 timing（截止 / 服务端时刻 / 宽限 / 阶段），前端据此倒计时
 *   与锁编辑，不信任本机时钟；
 * - 写闸门：到时后宽限 ATTEMPT_TIME_UP_GRACE_SEC 内答案写入仍接受（离线稿追平），
 *   宽限过后 409 ATTEMPT_TIME_UP；交卷不走本闸门（到时不自动交卷，由本人确认，
 *   宽限后仍可交卷、按服务端已有答案判分）。
 * 非限时卷（两列 NULL）全部零变化。
 */

type TimedColumns = Pick<Attempt, "timeLimitSec" | "deadlineAt">;

/** 建卷选项 → 行列值：未选时长 → 两列 NULL（历史行为） */
export function timedColumnsOf(
  startedAt: string,
  timeLimitMinutes: number | undefined,
): TimedColumns {
  if (timeLimitMinutes === undefined) {
    return { timeLimitSec: null, deadlineAt: null };
  }
  const timeLimitSec = timeLimitMinutes * 60;
  return {
    timeLimitSec,
    deadlineAt: new Date(
      Date.parse(startedAt) + timeLimitSec * 1000,
    ).toISOString(),
  };
}

/** 草稿视图的 timing 投影：非限时卷 null */
export function attemptTimingOf(
  attempt: TimedColumns,
  now: Date | string = new Date(),
): AttemptTiming | null {
  if (attempt.timeLimitSec === null || attempt.deadlineAt === null) {
    return null;
  }
  const nowDate = new Date(now);
  return {
    timeLimitSec: attempt.timeLimitSec,
    deadlineAt: attempt.deadlineAt,
    serverNow: nowDate.toISOString(),
    graceSec: ATTEMPT_TIME_UP_GRACE_SEC,
    phase: attemptTimingPhaseOf(
      attempt.deadlineAt,
      ATTEMPT_TIME_UP_GRACE_SEC,
      nowDate.getTime(),
    ),
  };
}

/**
 * 答案写入闸门（saveDraftAnswer / 逐题提交共用）：限时卷宽限已过 → 409
 * ATTEMPT_TIME_UP。非限时卷与宽限内直接放行。
 */
export function assertAttemptNotTimedOut(
  attempt: TimedColumns,
  now: Date | string = new Date(),
): void {
  if (attempt.deadlineAt === null) return;
  const phase = attemptTimingPhaseOf(
    attempt.deadlineAt,
    ATTEMPT_TIME_UP_GRACE_SEC,
    new Date(now).getTime(),
  );
  if (phase === "locked") {
    throw new HttpError(
      409,
      "ATTEMPT_TIME_UP",
      "限时已到且宽限期已过，不能再修改答案；请确认交卷",
    );
  }
}
