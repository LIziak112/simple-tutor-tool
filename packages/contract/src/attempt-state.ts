import { z } from "zod";
import { practiceFeedbackModeSchema } from "./practice-workflow.ts";
import { gradingPolicySchema } from "./self-review.ts";

const storedAssignmentDueAtSchema = z.iso.datetime({ offset: true });

/** 兼容已落库的显式偏移时间，对外使用 UTC。损坏或无时区的值无可用截止。 */
export function canonicalAssignmentDueAt(value: string | null): string | null {
  if (!storedAssignmentDueAtSchema.safeParse(value).success || value === null)
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** 老卷无冻结时间、按当前题库懒冻结和建卷时冻结是独立来源。 */
export const attemptQuestionFreezeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("legacy"), frozenAt: z.null() }),
  z.object({
    kind: z.literal("legacy_unverified"),
    frozenAt: z.string().min(1),
  }),
  z.object({ kind: z.literal("frozen"), frozenAt: z.string().min(1) }),
]);

export const storedAttemptProtocolSchema = z.discriminatedUnion("version", [
  z.object({
    version: z.null(),
    feedbackMode: z.null(),
    revision: z.literal(0),
  }),
  z.object({
    version: z.literal(1),
    feedbackMode: practiceFeedbackModeSchema,
    revision: z.number().int().nonnegative(),
  }),
]);

/** NULL 策略仅对应升级前的行；教师、自评、自动判定仍分列。 */
export const frozenGradingPolicySchema = gradingPolicySchema.nullable();
