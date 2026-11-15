import { z } from "zod";
import { studentAnswerSchema } from "./grading.ts";
import { learningContentIdSchema } from "./learning-context.ts";
import {
  practiceQuestionFeedbackSchema,
  practiceQuestionSubmitRequestSchema,
  studentMcpPracticeQuestionSubmitSchema,
} from "./practice-question-submit.ts";

const v2 = practiceQuestionSubmitRequestSchema
  .omit({ submissionMutationId: true })
  .extend({
    responseVersion: z.literal(2),
    practiceId: z.uuid(),
    questionId: learningContentIdSchema.optional(),
    questionNo: z.number().int().positive().optional(),
    submissionMutationId: z.uuid().optional(),
    answer: studentAnswerSchema.optional(),
  });
const branches = [
  studentMcpPracticeQuestionSubmitSchema,
  v2.required({ questionId: true }),
  v2.omit({ questionId: true }).required({ questionNo: true }),
] as const;
const accepted = z.union(branches);
const jsonBranches = branches.map((branch) => {
  const { $schema: _, ...schema } = z.toJSONSchema(branch, {
    io: "input",
    target: "draft-7",
  });
  return schema;
});
// 两个 v2 定位分支互斥；同时带 id/no 的请求由 id 分支接收并在首次写入时核对。
export const studentMcpSubmitInputSchema = v2
  .extend({ responseVersion: z.literal(2).optional() })
  .superRefine((input, ctx) => {
    if (!accepted.safeParse(input).success)
      ctx.addIssue({
        code: "custom",
        message: "请按旧版或 v2 提交契约提供定位、版本、证据和幂等键",
      });
  })
  .meta({ oneOf: jsonBranches });

export const studentMcpSubmitReceiptSchema = z.strictObject({
  success: z.literal(true),
  responseVersion: z.literal(2),
  practiceId: z.uuid(),
  questionId: learningContentIdSchema,
  questionRevisionId: z.string().min(1),
  questionNo: z.number().int().positive(),
  submittedAt: z.string().min(1),
  submissionMutationId: z.uuid(),
  settlementSeq: z.number().int().positive().nullable(),
  progress: z.strictObject({
    submittedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().positive(),
  }),
  feedback: practiceQuestionFeedbackSchema,
  nextQuestion: z
    .strictObject({
      questionId: learningContentIdSchema,
      questionNo: z.number().int().positive(),
    })
    .nullable(),
});
export type StudentMcpSubmitInput = z.infer<typeof studentMcpSubmitInputSchema>;
export type StudentMcpSubmitReceipt = z.infer<
  typeof studentMcpSubmitReceiptSchema
>;

/** 仅供服务端受理路径使用；不扩展客户端学习事件输入。 */
export const practiceSubmissionOriginSchema = z.discriminatedUnion("channel", [
  z.strictObject({ channel: z.literal("web") }),
  z.strictObject({
    channel: z.literal("mcp"),
    connectionId: z.string().min(1).nullable(),
  }),
]);
export type PracticeSubmissionOrigin = z.infer<
  typeof practiceSubmissionOriginSchema
>;
