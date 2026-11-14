import { z } from "zod";
import type { AttemptStatus } from "./attempt-summary.ts";
import { attemptTimeSchema } from "./attempt-time-ledger.ts";

export const attemptPhaseSchema = z.enum([
  "opened",
  "active",
  "finished",
  "abandoned",
]);
export type AttemptPhase = z.infer<typeof attemptPhaseSchema>;
/** 新服务端始终下发；旧缓存与旧SDK载荷允许缺省。 */
export const attemptSessionFields = {
  activatedAt: z.iso.datetime().nullable().optional(),
  phase: attemptPhaseSchema.optional(),
  frozenAt: z.iso.datetime().nullable().optional(),
};

type AttemptPhaseInput = {
  status: AttemptStatus;
  activatedAt?: string | null | undefined;
  abandonedAt?: string | null | undefined;
};

/** status 保持原有三值；作废优先于完成，未激活的草稿只作暂存。 */
export function attemptPhaseOf(attempt: AttemptPhaseInput): AttemptPhase {
  if (attempt.abandonedAt != null) return "abandoned";
  if (attempt.status !== "draft") return "finished";
  return attempt.activatedAt === null ? "opened" : "active";
}

/** 列表、统计和作业状态共用；MCP 定位当前会话不经过本谓词。 */
export function isRecordableAttempt(attempt: AttemptPhaseInput): boolean {
  const phase = attemptPhaseOf(attempt);
  return phase === "active" || phase === "finished";
}

/** null 仅匹配未冻结的历史版本，绝不是任意版本。 */
export const attemptActivateRequestSchema = z
  .object({
    expectedFrozenAt: z.iso.datetime().nullable(),
  })
  .strict();
export type AttemptActivateRequest = z.infer<
  typeof attemptActivateRequestSchema
>;

export const attemptActivateDataSchema = z
  .object({
    attemptId: z.uuid(),
    activatedAt: z.iso.datetime(),
    phase: z.enum(["active", "finished"]),
    frozenAt: z.iso.datetime().nullable(),
  })
  .strict();
export type AttemptActivateData = z.infer<typeof attemptActivateDataSchema>;

/** 本机稿恢复预检：只读原冻结卷，必须先于 start 的版本重冻。 */
export const attemptOpenedQuerySchema = z.discriminatedUnion("sourceType", [
  z
    .object({
      sourceType: z.literal("course"),
      courseId: z.uuid(),
      unitId: z.string().min(1),
    })
    .strict(),
  z
    .object({ sourceType: z.literal("assignment"), assignmentId: z.uuid() })
    .strict(),
  z
    .object({
      sourceType: z.literal("lesson"),
      lectureId: z.string().min(1),
      courseId: z.uuid().optional(),
    })
    .strict(),
]);
export type AttemptOpenedQuery = z.infer<typeof attemptOpenedQuerySchema>;

/** 结算只冻结成员与用时；判定仍从行内当前教师批改、自评及自动结果读取。 */
const settlementFields = z
  .object({
    time: attemptTimeSchema.optional(),
    seq: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    // final 可为零题终结标记；partial 必须含至少一行。
    questionCount: z.number().int().nonnegative(),
    activeSec: z.number().int().nonnegative().nullable(),
  })
  .strict();

// 分支约束同时进入 JSON Schema，避免运行时 refine 与生成契约口径不同。
export const attemptSettlementSchema = z.discriminatedUnion("kind", [
  settlementFields.extend({
    kind: z.literal("partial"),
    questionCount: z.number().int().positive(),
  }),
  settlementFields.extend({ kind: z.literal("final") }),
]);

export type AttemptSettlement = z.infer<typeof attemptSettlementSchema>;
