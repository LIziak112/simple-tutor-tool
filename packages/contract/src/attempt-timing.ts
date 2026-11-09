import { z } from "zod";

/**
 * 限时测试（个人学习迭代模块 2，2026-11）：学习者开卷时**自选时长**的通用
 * 「限时」——不限定模考、不新建实体，挂在既有 attempt 上：
 * - 建卷请求可带 timeLimitMinutes（课程单元练习 / 作业开卷通用；错题重练与
 *   讲练不适用）；DSL `practice.timeLimitMinutes` 只是单元推荐的缺省值；
 * - 服务端按建卷时刻算出 deadlineAt 持久化，时钟以服务端为准：换设备 / 后台 /
 *   重连后同一剩余时间；
 * - 到时不自动交卷：进入宽限（graceSec，缺省 10 分钟）——只能追平待同步稿、
 *   确认交卷，不能再改答案；宽限过后答案写入一律 409 ATTEMPT_TIME_UP，仍可
 *   交卷（按服务端已有答案判分）。截止前离线稿的认定以此为准（第 3 版计划
 *   「限时开工前」决策：先锁继续作答并保稿，宽限 10 分钟内纳入）。
 * 本文件只依赖 zod，attempt.ts 与 practice-workflow.ts 都可引用（不成环）。
 */

/** 自选时长上限 10 小时（分钟整数）；下限 1 分钟 */
export const ATTEMPT_TIME_LIMIT_MINUTES_MAX = 600;
export const attemptTimeLimitMinutesSchema = z
  .number()
  .int()
  .min(1)
  .max(ATTEMPT_TIME_LIMIT_MINUTES_MAX);

/** 到时后的宽限秒数：待同步稿追平 + 确认交卷的窗口（服务端常量，随 timing 下发） */
export const ATTEMPT_TIME_UP_GRACE_SEC = 10 * 60;

/**
 * 服务端口径的限时阶段：
 * - running：未到时，正常作答；
 * - grace：已到时、宽限内——答案写入仍接受（追平离线稿），前端锁编辑并提示
 *   「到时，待确认交卷」；
 * - locked：宽限已过——答案写入 409 ATTEMPT_TIME_UP，只能交卷。
 */
export const attemptTimingPhaseSchema = z.enum(["running", "grace", "locked"]);
export type AttemptTimingPhase = z.infer<typeof attemptTimingPhaseSchema>;

/**
 * 草稿视图随卷下发的限时信息（非限时卷为 null）。serverNow 供前端算本机与
 * 服务端的时钟偏移——倒计时以 deadlineAt - (Date.now() + offset) 计，不信任
 * 本机时钟。
 */
export const attemptTimingSchema = z
  .object({
    /** 时长（秒） */
    timeLimitSec: z.number().int().positive(),
    /** 截止时刻：UTC ISO = startedAt + timeLimitSec */
    deadlineAt: z.string().min(1),
    /** 服务端当前时刻：UTC ISO（本响应生成时） */
    serverNow: z.string().min(1),
    /** 宽限秒数（ATTEMPT_TIME_UP_GRACE_SEC） */
    graceSec: z.number().int().nonnegative(),
    phase: attemptTimingPhaseSchema,
  })
  .strict();
export type AttemptTiming = z.infer<typeof attemptTimingSchema>;

/** 纯函数：按截止 / 宽限 / 当前时刻判阶段（服务端与前端共用同一口径） */
export function attemptTimingPhaseOf(
  deadlineAt: string,
  graceSec: number,
  now: number,
): AttemptTimingPhase {
  const deadline = Date.parse(deadlineAt);
  if (now < deadline) return "running";
  return now < deadline + graceSec * 1000 ? "grace" : "locked";
}
