import { z } from "zod";
import { learningRecordSchema } from "./learning-record.ts";
import {
  aiDispatchPayloadSchema,
  aiMaterialKindSchema,
  aiMcpClaimViewSchema,
  aiShareViewSchema,
} from "./student-ai.ts";

/**
 * AI 学习记录视图（LR-PR5，学习记录模型设计稿 §7.3）：以 role:"ai" 的
 * LearningRecord 为底 + 压缩台账。P5「AI 吃结构化、图作附件」——点序列经
 * RDP 简化（ε = 坐标域宽 × AI_STROKE_EPSILON_RATIO，纸面=逻辑宽 1000、
 * 圈画=底图像素宽），单材料总点数超过 AI_MAX_POINTS_PER_MATERIAL 再按笔
 * 均匀抽稀并置 compacted:true。压缩在服务端装配层执行
 * （apps/server services/learning-record-ai.ts），本契约只锁形状与台账口径。
 *
 * 三视图（claim / share / dispatch）以 extend 追加**可选** record——契约只增，
 * 旧载荷零变化；文件独立于 student-ai.ts 的视图定义（消费方两向单引，
 * 不引入 student-ai ↔ learning-record 的循环求值）。
 */

/** 单材料压缩台账（如实告知；抽稀只改点密度，不改笔数与次序） */
export const aiCompactionEntrySchema = z
  .object({
    kind: aiMaterialKindSchema,
    pageIndex: z.number().int().min(0),
    /** RDP + 抽稀前的活笔+墓碑总点数 */
    originalPoints: z.number().int().min(0),
    keptPoints: z.number().int().min(0),
    /** true = RDP 后仍超上限，按笔均匀抽稀 */
    compacted: z.boolean(),
  })
  .strict();
export type AiCompactionEntry = z.infer<typeof aiCompactionEntrySchema>;

export const learningRecordAiViewSchema = z
  .object({
    /** role 恒 "ai"（装配层产出；schema 层校验防误投学生/教师记录） */
    record: learningRecordSchema,
    compaction: z
      .object({
        epsilonRatio: z.number().min(0).max(1),
        maxPointsPerMaterial: z.number().int().positive(),
        materials: z.array(aiCompactionEntrySchema),
      })
      .strict(),
  })
  .strict()
  .superRefine((view, ctx) => {
    // P6：教师私注/标记不进学生 AI 通道（同 aiContextSnapshot 的 strict
    // 拒绝口径）；identity 教师域键与答案/解析按设计稿 §3.2「teacher/ai(授权)」
    // 口径放行，授权在装配层裁决（任务快照 missingNote）。
    if (view.record.role !== "ai") {
      ctx.addIssue({
        code: "custom",
        path: ["record", "role"],
        message: "AI 视图的 record.role 必须为 ai",
      });
    }
    const banned: Array<[unknown, string[]]> = [
      [
        view.record.grading.teacherComment,
        ["record", "grading", "teacherComment"],
      ],
      [view.record.grading.teacherMark, ["record", "grading", "teacherMark"]],
      [view.record.grading.reviewSource, ["record", "grading", "reviewSource"]],
    ];
    for (const [value, path] of banned) {
      if (value !== undefined && value !== null) {
        ctx.addIssue({
          code: "custom",
          path,
          message: `AI 视图禁携 ${path.join(".")}（P6）`,
        });
      }
    }
  });
export type LearningRecordAiView = z.infer<typeof learningRecordAiViewSchema>;

// ---------- 三视图追加 record（契约只增；可选，旧载荷零变化） ----------

/** MCP 领取视图 + AI 记录（领取即授权外发，record 与 materials 同源） */
export const aiMcpClaimViewWithRecordSchema = aiMcpClaimViewSchema
  .extend({
    record: learningRecordAiViewSchema.optional(),
  })
  .strict();
export type AiMcpClaimViewWithRecord = z.infer<
  typeof aiMcpClaimViewWithRecordSchema
>;

/** 分享视图 + AI 记录（票据读端点，URL 绑定票据，同材料口径） */
export const aiShareViewWithRecordSchema = aiShareViewSchema
  .extend({
    record: learningRecordAiViewSchema.optional(),
  })
  .strict();
export type AiShareViewWithRecord = z.infer<typeof aiShareViewWithRecordSchema>;

/** 页内出站载荷 + AI 记录（用户段「待分析数据」包裹，注入防御约定不变） */
export const aiDispatchPayloadWithRecordSchema = aiDispatchPayloadSchema
  .extend({
    record: learningRecordAiViewSchema.optional(),
  })
  .strict();
export type AiDispatchPayloadWithRecord = z.infer<
  typeof aiDispatchPayloadWithRecordSchema
>;
