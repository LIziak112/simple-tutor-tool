import { z } from "zod";
import { responseTimeSchema } from "./attempt-time-ledger.ts";
import { questionTypeSchema } from "./content.ts";
import { rubricReviewSchema } from "./rubric.ts";
import { gradingPolicySchema } from "./self-review.ts";

export const reviewGroupDimensionSchema = z.enum([
  "unit",
  "settlement",
  "type",
  "material",
  "knowledge",
]);
export type ReviewGroupDimension = z.infer<typeof reviewGroupDimensionSchema>;
/** 只记录服务端已授权事实；null 表示没有可靠数据，不推测旧记录。 */
export const reviewQuestionFactSchema = z.object({
  questionId: z.string().min(1),
  questionRevisionId: z.string().nullable(),
  unit: z.object({ id: z.string(), title: z.string() }),
  settlementSeq: z.number().int().positive().nullable(),
  type: questionTypeSchema,
  knowledge: z.array(z.string()),
  materialIds: z.array(z.string()),
  retrainable: z.boolean(),
  answered: z.boolean(),
  verdict: z.boolean().nullable(),
  judgmentSource: z.enum(["teacher", "self", "auto"]).nullable(),
  gradingPolicy: gradingPolicySchema.nullable(),
  rubricReview: rubricReviewSchema.nullable(),
  activeSec: z.number().nonnegative().nullable(),
  time: responseTimeSchema.optional(),
  changeCount: z.number().int().nonnegative().nullable(),
  hintsUsed: z.number().int().nonnegative().nullable(),
  studentFlag: z.literal("unsure").nullable(),
  hasHandwriting: z.boolean().nullable(),
  hasScratch: z.boolean().nullable(),
  memoSequences: z.array(z.number().int().positive()).nullable(),
});
export type ReviewQuestionFact = z.infer<typeof reviewQuestionFactSchema>;

/** 服务端结果投影新增的可空证据字段，旧接口缺省合法。 */
export const reviewEvidenceMetadataSchema = z.object({
  settlementSeq: z.number().int().positive().nullable().optional(),
  activeSec: z.number().nonnegative().nullable().optional(),
  changeCount: z.number().int().nonnegative().optional(),
  hintsUsed: z.number().int().nonnegative().optional(),
  hasHandwriting: z.boolean().nullable().optional(),
  hasScratch: z.boolean().nullable().optional(),
  materialIds: z.array(z.string()).optional(),
  memoSequences: z.array(z.number().int().positive()).nullable().optional(),
});
