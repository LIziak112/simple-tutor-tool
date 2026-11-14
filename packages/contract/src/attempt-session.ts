import { z } from "zod";
import { attemptTimeSchema } from "./attempt-time-ledger.ts";

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
