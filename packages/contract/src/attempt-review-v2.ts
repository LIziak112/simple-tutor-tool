import { z } from "zod";
import { reviewQuestionFactSchema } from "./review-facts.ts";
import { rubricReviewSchema } from "./rubric.ts";
import { selfReviewRecordSchema } from "./self-review.ts";
import { AI_BATCH_MAX_QUESTIONS } from "./student-ai.ts";
import { aiAttemptReviewQuestionSchema } from "./student-ai-attempt-review.ts";

/** 分片仍沿用原30题上限；大卷通过任务图覆盖，不提高单次载荷限制。 */
export const REVIEW_V2_SECTIONS = {
  objective: [
    { key: "overview", title: "整体表现" },
    { key: "knowledge", title: "知识点" },
    { key: "errors", title: "错因分析" },
    { key: "performance", title: "作答过程" },
    { key: "plan", title: "练习建议" },
  ],
  essay: [
    { key: "overview", title: "整体表现" },
    { key: "thesis", title: "立意" },
    { key: "structure", title: "结构" },
    { key: "argument", title: "论证" },
    { key: "language", title: "语言" },
    { key: "revisions", title: "修改建议" },
  ],
} as const;
export const reviewV2ProfileSchema = z.enum(["objective", "essay"]);
export const reviewV2ScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("attempt") }),
  z.strictObject({
    kind: z.literal("settlement"),
    seq: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal("unit"),
    unitId: z.string().trim().min(1).max(512),
  }),
  z.strictObject({
    kind: z.literal("lesson_stage"),
    throughQuestionNo: z.number().int().positive(),
  }),
]);
export const reviewV2CreateSchema = z.strictObject({
  mutationId: z.string().trim().min(1).max(160),
  purpose: z.string().trim().min(1).max(1000),
  profile: reviewV2ProfileSchema,
  scope: reviewV2ScopeSchema,
  expectedPreviewVersion: z.string().min(1).optional(),
});
export const reviewV2ReportSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    profile: reviewV2ProfileSchema,
    sections: z
      .array(
        z.strictObject({
          key: z.string().min(1),
          title: z.string().min(1).max(100),
          markdown: z.string().trim().min(1).max(16_000),
          evidenceQuestionNos: z.array(z.number().int().positive()).max(500),
        }),
      )
      .min(1)
      .max(12),
    limitations: z.array(z.string().trim().min(1).max(1000)).max(30),
  })
  .superRefine((report, ctx) => {
    const expected = REVIEW_V2_SECTIONS[report.profile];
    if (
      report.sections.length !== expected.length ||
      expected.some(
        (section, index) =>
          report.sections[index]?.key !== section.key ||
          report.sections[index]?.title !== section.title,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "报告分节必须与所选模板的清单和顺序一致",
      });
    }
  });
const questionSchema = aiAttemptReviewQuestionSchema.safeExtend({
  fact: reviewQuestionFactSchema,
  unitId: z.string().nullable(),
  settlementSeq: z.number().int().positive().nullable(),
  selfReview: selfReviewRecordSchema.nullable(),
  rubricReview: rubricReviewSchema.nullable(),
});
const base = {
  schemaVersion: z.literal(2),
  attemptId: z.uuid(),
  scope: reviewV2ScopeSchema,
  profile: reviewV2ProfileSchema,
  purpose: z.string().min(1),
  snapshotVersion: z.string().min(1),
  capturedAt: z.string().min(1),
};
export const reviewV2SnapshotSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...base,
    kind: z.literal("questions"),
    questions: z.array(questionSchema).min(1).max(AI_BATCH_MAX_QUESTIONS),
    materials: z.array(
      z.strictObject({
        id: z.string().min(1),
        title: z.string(),
        bodyMd: z.string(),
      }),
    ),
    notes: z.array(z.string()),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("summary"),
    reports: z
      .array(
        z.strictObject({
          partId: z.uuid(),
          questionNos: z
            .array(z.number().int().positive())
            .min(1)
            .max(AI_BATCH_MAX_QUESTIONS),
          report: reviewV2ReportSchema,
        }),
      )
      .min(1)
      .max(1000),
  }),
]);
export const reviewV2TaskStatusSchema = z.enum([
  "blocked",
  "created",
  "claimed",
  "replied",
  "paused",
  "cancelled",
]);
export const reviewV2TaskPublicSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["questions", "summary"]),
  status: reviewV2TaskStatusSchema,
  questionNos: z.array(z.number().int().positive()),
  generation: z.number().int().nonnegative(),
  hasResult: z.boolean(),
  createdAt: z.string(),
});
export const reviewV2RunPublicSchema = z.strictObject({
  id: z.uuid(),
  attemptId: z.uuid(),
  scope: reviewV2ScopeSchema,
  profile: reviewV2ProfileSchema,
  purpose: z.string(),
  questionCount: z.number().int().positive(),
  createdAt: z.string(),
  tasks: z.array(reviewV2TaskPublicSchema),
});
export type ReviewV2Scope = z.infer<typeof reviewV2ScopeSchema>;
export type ReviewV2Create = z.infer<typeof reviewV2CreateSchema>;
export type ReviewV2Report = z.infer<typeof reviewV2ReportSchema>;
export type ReviewV2Snapshot = z.infer<typeof reviewV2SnapshotSchema>;
export type ReviewV2Question = z.infer<typeof questionSchema>;
export type ReviewV2RunPublic = z.infer<typeof reviewV2RunPublicSchema>;
export const reviewV2PreviewSchema = z.strictObject({
  schemaVersion: z.literal(2),
  previewVersion: z.string().min(1),
  questionCount: z.number().int().positive(),
  partCount: z.number().int().positive(),
  sections: z.array(z.strictObject({ key: z.string(), title: z.string() })),
});
export const reviewV2DetailSchema = z.strictObject({
  run: reviewV2RunPublicSchema,
  reports: z.array(
    z.strictObject({
      taskId: z.uuid(),
      kind: z.enum(["questions", "summary"]),
      report: reviewV2ReportSchema,
    }),
  ),
});
export type ReviewV2Detail = z.infer<typeof reviewV2DetailSchema>;
