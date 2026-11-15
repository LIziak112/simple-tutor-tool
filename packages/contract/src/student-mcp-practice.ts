import { z } from "zod";
import { attemptQuestionPublicSchema } from "./attempt.ts";
import { questionRevisionIdSchema } from "./attempt-submission.ts";
import { attemptSourceSchema, attemptStatusSchema } from "./attempt-summary.ts";
import { questionTypeSchema } from "./content.ts";
import { studentAnswerSchema } from "./grading.ts";
import {
  learningContentIdSchema,
  learningContextSchema,
} from "./learning-context.ts";
import { practiceQuestionSubmitRequestSchema } from "./practice-question-submit.ts";
import { practiceWorkflowSchema } from "./practice-workflow.ts";
import { attemptAnswerProgressSchema } from "./result-counts.ts";

/** 普通公开出口：不借 AI 求助任务领取的答案授权，不携参考内容或判定。 */
export const studentMcpPracticeListInputSchema = z.strictObject({
  status: attemptStatusSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).max(100_000).optional(),
});

export const studentMcpPracticeReadInputSchema = z.strictObject({
  practiceId: z.uuid(),
});

const questionLocatorFields = ["questionId", "questionNo"] as const;

/** 两种定位都给时服务端还须核对它们指向同一冻结题，不信任显示题号。 */
export const studentMcpPracticeQuestionReadInputSchema = z
  .strictObject({
    practiceId: z.uuid(),
    questionId: learningContentIdSchema.optional(),
    questionNo: z.number().int().positive().optional(),
    includeImages: z.boolean().optional(),
  })
  .refine(
    (input) => questionLocatorFields.some((key) => input[key] !== undefined),
    "请提供题目 id 或题序",
  )
  // SDK只导出对象结构，跨字段refine条件由同一定位字段表补到公开JSON Schema。
  .meta({
    anyOf: questionLocatorFields.map((key) => ({ required: [key] })),
  });

const submissionProgressSchema = z
  .strictObject({
    submittedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
  })
  .refine(
    (progress) => progress.submittedCount <= progress.totalCount,
    "已提交题数不能超过总题数",
  );

/** 列表沿现有记录可见性；可列出不等于某题已获 AI 读取或提交授权。 */
export const studentMcpPracticeListDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  practices: z.array(
    z.strictObject({
      practiceId: z.uuid(),
      title: z.string(),
      sourceType: attemptSourceSchema,
      status: attemptStatusSchema,
      startedAt: z.string().min(1),
      submittedAt: z.string().nullable(),
      answerProgress: attemptAnswerProgressSchema.nullable(),
      submissionProgress: submissionProgressSchema.nullable(),
      practiceWorkflow: practiceWorkflowSchema.nullable(),
    }),
  ),
  total: z.number().int().nonnegative(),
});

/** 题级目录只有公开摘录和状态，不含本人答案、参考内容、判定或成绩汇总。 */
export const studentMcpPracticeDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  practiceId: z.uuid(),
  title: z.string(),
  status: attemptStatusSchema,
  sourceType: attemptSourceSchema,
  practiceWorkflow: practiceWorkflowSchema.nullable(),
  questions: z.array(
    z.strictObject({
      questionNo: z.number().int().positive(),
      questionId: learningContentIdSchema,
      questionRevisionId: questionRevisionIdSchema,
      type: questionTypeSchema,
      stemExcerpt: z.string(),
      state: z.enum(["unanswered", "answered", "submitted"]),
      /** 已逐题提交仍可能未结算；只取实际冻结行，不推导为1。 */
      settlementSeq: z.number().int().positive().nullable(),
    }),
  ),
});

/**
 * 只读准备的参数不是授权票据。学生确认后，客户端还须生成并保留
 * submissionMutationId，调用原 student_submit_practice_question；A1不改旧提交。
 * 工作流、题目、本人答案与笔记证据 CAS 继续复用既有提交契约。
 */
export const studentMcpPracticeSubmitParametersSchema =
  practiceQuestionSubmitRequestSchema
    .omit({ submissionMutationId: true })
    .extend({
      practiceId: z.uuid(),
      questionId: learningContentIdSchema,
    });

const submissionAvailabilitySchema = z.discriminatedUnion("available", [
  z.strictObject({
    available: z.literal(true),
    parameters: studentMcpPracticeSubmitParametersSchema,
  }),
  z.strictObject({
    available: z.literal(false),
    reason: z.enum([
      "QUESTION_ALREADY_SUBMITTED",
      "WORKFLOW_LEGACY",
      "WORKFLOW_PROTOCOL_MISMATCH",
      "WORKFLOW_RESTRICTED",
      "ATTEMPT_TIME_UP",
      "SUBMISSION_VERSION_UNAVAILABLE",
    ]),
  }),
]);

export const studentMcpPracticeQuestionDataSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    practiceId: z.uuid(),
    questionNo: z.number().int().positive(),
    questionCount: z.number().int().positive(),
    question: attemptQuestionPublicSchema.strict(),
    materials: z.array(
      z.strictObject({
        id: learningContentIdSchema,
        sourceVersion: z.number().int().positive(),
        title: z.string(),
        contentMd: z.string(),
      }),
    ),
    currentAnswer: studentAnswerSchema.nullable(),
    context: learningContextSchema.strict(),
    practiceWorkflow: practiceWorkflowSchema.nullable(),
    submittedAt: z.string().nullable(),
    submission: submissionAvailabilitySchema,
    imagesIncluded: z.boolean(),
    images: z.array(
      z.strictObject({
        src: z.string().min(1),
        mimeType: z.enum([
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
        ]),
        byteSize: z.number().int().positive(),
      }),
    ),
  })
  .superRefine((data, ctx) => {
    const session = data.context.session;
    if (
      session === null ||
      session.attemptId !== data.practiceId ||
      session.questionRevisionId !== data.question.questionRevisionId ||
      session.questionNo !== data.questionNo ||
      session.questionCount !== data.questionCount ||
      data.context.content.questionId !== data.question.id
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["context"],
        message: "单题公开投影与规范上下文的题目身份或题序不一致",
      });
    }
  });

export type StudentMcpPracticeListInput = z.infer<
  typeof studentMcpPracticeListInputSchema
>;
export type StudentMcpPracticeReadInput = z.infer<
  typeof studentMcpPracticeReadInputSchema
>;
export type StudentMcpPracticeQuestionReadInput = z.infer<
  typeof studentMcpPracticeQuestionReadInputSchema
>;
export type StudentMcpPracticeListData = z.infer<
  typeof studentMcpPracticeListDataSchema
>;
export type StudentMcpPracticeData = z.infer<
  typeof studentMcpPracticeDataSchema
>;
export type StudentMcpPracticeSubmitParameters = z.infer<
  typeof studentMcpPracticeSubmitParametersSchema
>;
export type StudentMcpPracticeQuestionData = z.infer<
  typeof studentMcpPracticeQuestionDataSchema
>;
