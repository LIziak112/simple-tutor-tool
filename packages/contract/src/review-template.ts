import { z } from "zod";
import { type QuestionType, questionTypeSchema } from "./content.ts";
import { reviewGroupDimensionSchema } from "./review-facts.ts";
export const REVIEW_EXAM_TYPES = [
  "行测",
  "申论",
  "作文",
  "阅读理解",
  "资料分析",
] as const;
export const reviewAgentProfileSchema = z.enum(["objective", "essay"]);
export const reviewTemplateIdSchema = z.enum([
  "objective",
  "exam",
  "material",
  "longform",
]);
export const reviewSectionKindSchema = z.enum([
  "summary",
  "group_stats",
  "questions",
  "rubric_matrix",
  "material_reading",
  "answer_comparison",
  "time_distribution",
  "agent_report",
  "memo_excerpt",
]);
export type ReviewSectionKind = z.infer<typeof reviewSectionKindSchema>;
export const reviewSectionSchema = z.strictObject({
  id: z.string().min(1).max(80),
  kind: reviewSectionKindSchema,
  visible: z.boolean().default(true),
  options: z
    .strictObject({ dimension: reviewGroupDimensionSchema.optional() })
    .default({}),
});
export const reviewTemplateSchema = z
  .strictObject({
    id: z.string().min(1).max(80),
    version: z.literal(1),
    title: z.string().min(1).max(80),
    appliesTo: z.strictObject({
      examTypes: z.array(z.string()).optional(),
      composition: z.enum(["objective", "subjective", "mixed"]).optional(),
      hasMaterials: z.boolean().optional(),
      questionTypes: z.array(questionTypeSchema).optional(),
    }),
    sections: z.array(reviewSectionSchema).min(1).max(20),
    agentReport: z
      .strictObject({ profile: reviewAgentProfileSchema })
      .optional(),
  })
  .refine(
    (t) =>
      new Set(t.sections.map((s) => s.id)).size === t.sections.length &&
      new Set(t.sections.map((s) => s.kind)).size === t.sections.length,
    "分区标识不能重复",
  );
export type ReviewTemplate = z.infer<typeof reviewTemplateSchema>;
export const reviewPresentationSchema = z.object({
  examType: z.string().nullable(),
  templateId: z.string().nullable(),
  unitTemplateIds: z.array(z.string()),
});
export type ReviewPresentation = z.infer<typeof reviewPresentationSchema>;
const section = (
  kind: ReviewSectionKind,
  dimension?: z.infer<typeof reviewGroupDimensionSchema>,
) => ({
  id: kind,
  kind,
  visible: true,
  options: dimension === undefined ? {} : { dimension },
});
/** 内置配置只维护一份；自定义一级只改变本页显隐和顺序，不存账号模板。 */
export const REVIEW_TEMPLATE_PRESETS: readonly ReviewTemplate[] = [
  {
    id: "objective",
    version: 1,
    title: "客观题默认",
    appliesTo: { composition: "objective" },
    sections: [
      section("summary"),
      section("group_stats"),
      section("questions"),
      section("agent_report"),
    ],
    agentReport: { profile: "objective" },
  },
  {
    id: "exam",
    version: 1,
    title: "行测套卷",
    appliesTo: { examTypes: ["行测"] },
    sections: [
      section("summary"),
      section("group_stats", "unit"),
      section("time_distribution"),
      section("questions"),
      section("agent_report"),
    ],
    agentReport: { profile: "objective" },
  },
  {
    id: "material",
    version: 1,
    title: "材料阅读",
    appliesTo: { examTypes: ["阅读理解", "资料分析"], hasMaterials: true },
    sections: [
      section("summary"),
      section("material_reading"),
      section("group_stats", "material"),
      section("questions"),
      section("agent_report"),
    ],
    agentReport: { profile: "objective" },
  },
  {
    id: "longform",
    version: 1,
    title: "长文作答",
    appliesTo: { composition: "subjective", examTypes: ["申论", "作文"] },
    sections: [
      section("summary"),
      section("material_reading"),
      section("answer_comparison"),
      section("rubric_matrix"),
      section("agent_report"),
      section("memo_excerpt"),
      { ...section("questions"), visible: false },
    ],
    agentReport: { profile: "essay" },
  },
];
const defaultTemplate = () => REVIEW_TEMPLATE_PRESETS[0] as ReviewTemplate;
export function validateReviewTemplate(config: unknown): {
  template: ReviewTemplate;
  warning: string | null;
} {
  const parsed = reviewTemplateSchema.safeParse(config);
  return parsed.success
    ? { template: parsed.data, warning: null }
    : {
        template: defaultTemplate(),
        warning: "模板配置无效，已使用客观题默认模板。可重新选择模板。",
      };
}
/** 单元显式配置 > 课程显式配置 > 考试标签 > 内容构成；冲突不擅自选一个。 */
export function resolveReviewTemplate(input: {
  questionTypes: readonly QuestionType[];
  hasMaterials: boolean;
  unitTemplateIds?: readonly string[] | undefined;
  templateId?: string | null | undefined;
  examType?: string | null | undefined;
}): { template: ReviewTemplate; warning: string | null } {
  const ids = [...new Set(input.unitTemplateIds ?? [])];
  if (ids.length > 1)
    return {
      template: defaultTemplate(),
      warning: "各单元指定了不同模板，已使用客观题默认模板。可在本页重新选择。",
    };
  const explicit = ids[0] ?? input.templateId;
  if (explicit) {
    const preset = REVIEW_TEMPLATE_PRESETS.find((t) => t.id === explicit);
    return preset
      ? { template: preset, warning: null }
      : {
          template: defaultTemplate(),
          warning: "指定的模板不可用，已使用客观题默认模板。可重新选择模板。",
        };
  }
  const byExam = REVIEW_TEMPLATE_PRESETS.find(
    (t) => input.examType && t.appliesTo.examTypes?.includes(input.examType),
  );
  if (byExam) return { template: byExam, warning: null };
  const subjective = new Set<QuestionType>([
    "response",
    "solve",
    "apply",
    "find-error",
  ]);
  const composition =
    input.questionTypes.length > 0 &&
    input.questionTypes.every((t) => subjective.has(t))
      ? "subjective"
      : input.questionTypes.some((t) => subjective.has(t))
        ? "mixed"
        : "objective";
  const byComposition = REVIEW_TEMPLATE_PRESETS.find(
    (t) => t.appliesTo.composition === composition,
  );
  const byMaterials = input.hasMaterials
    ? REVIEW_TEMPLATE_PRESETS.find((t) => t.appliesTo.hasMaterials === true)
    : undefined;
  return {
    template:
      composition === "subjective"
        ? (byComposition ?? defaultTemplate())
        : (byMaterials ?? byComposition ?? defaultTemplate()),
    warning: null,
  };
}
