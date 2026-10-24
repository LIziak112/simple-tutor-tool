import { z } from "zod";
import type { Question } from "./content.ts";

/** 新建作答使用对照自评；存量冻结行保留原自动判定规则。 */
export const reviewPolicySchema = z.enum(["legacy", "self_review"]);
export type ReviewPolicy = z.infer<typeof reviewPolicySchema>;

/** 必须有教师提供的参考答案；只有题干、提示或解析不能开启自评和逐题提交。 */
export function hasReferenceAnswer(
  question: Pick<Question, "answers" | "solutionMd">,
): boolean {
  const answers = question.answers;
  const available =
    answers?.kind === "final"
      ? Boolean(answers.answer.trim())
      : answers?.kind === "fill"
        ? answers.blanks.some((blank) =>
            blank.some((text) => Boolean(text.trim())),
          )
        : answers !== undefined;
  return available;
}

export function isSelfReviewQuestion(
  question: Pick<Question, "type">,
): boolean {
  return ["fill", "solve", "apply", "find-error"].includes(question.type);
}

export const selfReviewStateSchema = z
  .object({
    mark: z.boolean().nullable(),
    revision: z.number().int().min(0),
    reviewedAt: z.string().nullable(),
    source: z
      .enum(["teacher", "self", "automatic"])
      .nullable()
      .describe("判定来源；学生自评不能作为独立完成或客观能力的证明"),
    canReview: z.boolean(),
    awaitingSelfReview: z.boolean(),
  })
  .strict();
export type SelfReviewState = z.infer<typeof selfReviewStateSchema>;

export const selfReviewRequestSchema = z
  .object({
    mark: z.boolean().nullable(),
    baseRevision: z.number().int().min(0),
    mutationId: z.uuid(),
  })
  .strict();
export type SelfReviewRequest = z.infer<typeof selfReviewRequestSchema>;

export const selfReviewDataSchema = z
  .object({
    review: selfReviewStateSchema,
    finalCorrect: z.boolean().nullable(),
  })
  .strict();
export type SelfReviewData = z.infer<typeof selfReviewDataSchema>;
