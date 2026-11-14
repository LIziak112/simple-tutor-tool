import { z } from "zod";
import { attemptSettlementSchema } from "./attempt-session.ts";
export const attemptSettlementProgressSchema = z.strictObject({
  settlements: z.array(attemptSettlementSchema),
  nextQuestionId: z.string().min(1).nullable(),
  membership: z.record(z.string(), z.number().int().positive()),
});
