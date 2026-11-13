import { z } from "zod";
import { materialPublicSchema, questionGroupPublicSchema } from "./material.ts";

// ---------- 开卷上下文读取（冻结快照的公开投影，tt-07a / QM-06） ----------

/**
 * 材料/题组的冻结上下文条目：公开投影（materialPublicSchema /
 * questionGroupPublicSchema 白名单——contentMd/introMd 等学生作答所需）+
 * 冻结时来源版本。**显式白名单扩展而非快照行透传**（三投影纪律，设计方案
 * §8.1）：教师侧 sourceMd 等字段在 parse 时被 strip，答案/详解/提示键绝无
 * 携带通道（材料正文不含答案型内容另由 lint MATERIAL_CONTAINS_ANSWER 保证，
 * 双防线）。
 */
export const attemptContextMaterialSchema = materialPublicSchema.extend({
  /** 冻结时的 materials.version（与去重键/快照身份同源） */
  sourceVersion: z.number().int().min(1),
});
export const attemptContextGroupSchema = questionGroupPublicSchema.extend({
  /** 冻结时的 question_groups.version */
  sourceVersion: z.number().int().min(1),
});

/**
 * GET /attempts/:id/context 的响应 data：该卷全部冻结上下文（作答期渲染与
 * 结果回看只读快照——教师改材料/软删不影响已开卷）。排序 (kind, sourceId,
 * sourceVersion) 稳定（不依赖 live order，TT-06b P2-3 记账）。
 */
export const attemptContextDataSchema = z.object({
  attemptId: z.string().min(1),
  /** 老服务端响应可以省略。来源未知的存量卷不推断当时上下文。 */
  freezeState: z.enum(["frozen", "legacy_unknown"]).optional(),
  materials: z.array(attemptContextMaterialSchema),
  groups: z.array(attemptContextGroupSchema),
});

/** 携带开卷上下文的成功响应壳 */
export const attemptContextOkSchema = z.object({
  ok: z.literal(true),
  data: attemptContextDataSchema,
});

/** 开卷上下文条目（材料/题组公开投影 + 来源版本，tt-07a/QM-06） */
export type AttemptContextMaterial = z.infer<
  typeof attemptContextMaterialSchema
>;
export type AttemptContextGroup = z.infer<typeof attemptContextGroupSchema>;
export type AttemptContextData = z.infer<typeof attemptContextDataSchema>;
