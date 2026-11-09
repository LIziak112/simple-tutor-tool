import { z } from "zod";

/**
 * 通用量表判卷（个人学习迭代模块 3）——不限学科、不限题型的「量表」：
 * 题目内 `:::rubric` 声明若干评价项，每项统一 1–4 档（1 最低、4 最高）；
 * 本人自评先行（逐项档位 + 一句依据），Agent 经 MCP 对同一冻结作答与量表
 * 独立给意见（逐项档位 + 依据 + 可选证据句），分歧逐项并排，由本人裁定
 * （保留自评 / 采纳意见 / 自行改写）。量表分与对错判定、总分、错题统计
 * 互不混算（第 3 版计划：申论练习分单列）。
 */

export const RUBRIC_LEVEL_MAX = 4;
export const RUBRIC_ITEMS_MAX = 8;
export const RUBRIC_ITEM_TITLE_MAX_CHARS = 40;
export const RUBRIC_ITEM_DESC_MAX_CHARS = 200;
export const RUBRIC_NOTE_MAX_CHARS = 300;
export const RUBRIC_EVIDENCE_MAX_CHARS = 300;

/** 量表的一项：id 由解析器按序生成（r1…），title 是显示名，desc 说明评什么 */
export const rubricItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(RUBRIC_ITEM_TITLE_MAX_CHARS),
    desc: z.string().max(RUBRIC_ITEM_DESC_MAX_CHARS).optional(),
  })
  .strict();
export type RubricItem = z.infer<typeof rubricItemSchema>;

/** 量表：首版档位固定 4（1–4），items 1–8 项 */
export const rubricSchema = z
  .object({
    items: z.array(rubricItemSchema).min(1).max(RUBRIC_ITEMS_MAX),
    levels: z.literal(RUBRIC_LEVEL_MAX),
  })
  .strict();
export type Rubric = z.infer<typeof rubricSchema>;

export const rubricLevelSchema = z.number().int().min(1).max(RUBRIC_LEVEL_MAX);

/** 一项评定：档位 + 可选证据句（Agent 用来指出原文段落 / 量表依据） */
export const rubricRatingSchema = z
  .object({
    id: z.string().min(1),
    level: rubricLevelSchema,
    evidence: z.string().max(RUBRIC_EVIDENCE_MAX_CHARS).optional(),
  })
  .strict();
export type RubricRating = z.infer<typeof rubricRatingSchema>;

export const rubricSourceSchema = z.enum(["self", "agent"]);
export type RubricSource = z.infer<typeof rubricSourceSchema>;

/** 一份完整评定（自评或 Agent 意见）：逐项档位 + 一句依据 + 时间 */
export const rubricAssessmentSchema = z
  .object({
    source: rubricSourceSchema,
    ratings: z.array(rubricRatingSchema).min(1),
    note: z.string().max(RUBRIC_NOTE_MAX_CHARS),
    at: z.string().min(1),
    /** agent 来源：对应的 AI 任务 id（可回到回信） */
    taskId: z.uuid().optional(),
  })
  .strict();
export type RubricAssessment = z.infer<typeof rubricAssessmentSchema>;

/** 本人裁定：保留自评 / 采纳 Agent / 自行改写（custom 必带逐项档位） */
export const rubricDecisionSchema = z.enum(["self", "agent", "custom"]);
export type RubricDecision = z.infer<typeof rubricDecisionSchema>;

export const rubricAdjudicationSchema = z
  .object({
    decision: rubricDecisionSchema,
    ratings: z.array(rubricRatingSchema).min(1),
    note: z.string().max(RUBRIC_NOTE_MAX_CHARS),
    at: z.string().min(1),
  })
  .strict();
export type RubricAdjudication = z.infer<typeof rubricAdjudicationSchema>;

/**
 * 结果页单题的量表视图：量表 + 三份记录（缺省 null）+ 在途 Agent 任务。
 * 展示默认值：final ?? self（个人练习以本人为准，Agent 只是意见）。
 */
export const rubricReviewSchema = z
  .object({
    rubric: rubricSchema,
    self: rubricAssessmentSchema.nullable(),
    agent: rubricAssessmentSchema.nullable(),
    final: rubricAdjudicationSchema.nullable(),
    /** 已发起、尚未收到意见的判卷任务 id；null = 没有在途 */
    pendingAgentTaskId: z.uuid().nullable(),
  })
  .strict();
export type RubricReview = z.infer<typeof rubricReviewSchema>;

// ---------- 请求 ----------

export const rubricSelfRequestSchema = z
  .object({
    ratings: z.array(rubricRatingSchema).min(1),
    note: z.string().max(RUBRIC_NOTE_MAX_CHARS).default(""),
  })
  .strict();
export type RubricSelfRequest = z.infer<typeof rubricSelfRequestSchema>;

export const rubricFinalRequestSchema = z
  .object({
    decision: rubricDecisionSchema,
    /** custom 必填；self / agent 忽略（以对应记录为准） */
    ratings: z.array(rubricRatingSchema).min(1).optional(),
    note: z.string().max(RUBRIC_NOTE_MAX_CHARS).default(""),
  })
  .strict();
export type RubricFinalRequest = z.infer<typeof rubricFinalRequestSchema>;

/** Agent 经 MCP 写回的意见（taskId / leaseToken 走任务租约校验） */
export const rubricOpinionInputSchema = z
  .object({
    ratings: z.array(rubricRatingSchema).min(1),
    note: z.string().min(1).max(RUBRIC_NOTE_MAX_CHARS),
  })
  .strict();
export type RubricOpinionInput = z.infer<typeof rubricOpinionInputSchema>;

// ---------- 纯函数 ----------

/**
 * 评定是否完整覆盖量表：每项恰好一条、无未知 id。返回出错说明（null = 合格）。
 */
export function rubricRatingsProblem(
  rubric: Rubric,
  ratings: readonly RubricRating[],
): string | null {
  const known = new Set(rubric.items.map((item) => item.id));
  const seen = new Set<string>();
  for (const rating of ratings) {
    if (!known.has(rating.id)) return `量表里没有「${rating.id}」这一项`;
    if (seen.has(rating.id)) return `「${rating.id}」重复评定`;
    seen.add(rating.id);
  }
  const missing = rubric.items.filter((item) => !seen.has(item.id));
  if (missing.length > 0) {
    return `还有未评定的项：${missing.map((item) => item.title).join("、")}`;
  }
  return null;
}

/** 总档位（各项档位之和）；满分 = 项数 × 4 */
export function rubricTotalOf(ratings: readonly RubricRating[]): number {
  return ratings.reduce((sum, rating) => sum + rating.level, 0);
}
export function rubricMaxOf(rubric: Rubric): number {
  return rubric.items.length * rubric.levels;
}

/** 两份评定逐项不一致的项 id（任一方缺项不算分歧） */
export function rubricDisagreementsOf(
  a: readonly RubricRating[],
  b: readonly RubricRating[],
): string[] {
  const levelsOfB = new Map(b.map((rating) => [rating.id, rating.level]));
  return a
    .filter((rating) => {
      const other = levelsOfB.get(rating.id);
      return other !== undefined && other !== rating.level;
    })
    .map((rating) => rating.id);
}

/** 展示用的当前评定：裁定 > 自评 > 无 */
export function rubricEffectiveOf(
  review: Pick<RubricReview, "self" | "final">,
): readonly RubricRating[] | null {
  return review.final?.ratings ?? review.self?.ratings ?? null;
}
