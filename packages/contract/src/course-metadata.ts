import { z } from "zod";
import { reviewTemplateIdSchema } from "./review-template.ts";

/**
 * POST /api/teacher/courses 请求体。title 即课程名（映射 courses.title 列）；
 * T2A.4 起可选 description（课程编辑页新建对话框填写，缺省 null）。
 */
export const courseCreateRequestSchema = z.object({
  examType: z.string().trim().max(80).nullable().optional(),
  reviewTemplateId: reviewTemplateIdSchema.nullable().optional(),
  title: z.string().trim().min(1, "课程名不能为空"),
  description: z.string().trim().max(500, "课程简介最多 500 个字符").optional(),
});

/**
 * PATCH /api/teacher/courses/:id 请求体（字段缺省 = 不改）。
 * T2A.4 扩展（清单口径 name）：name 与 title 同义（name 为 Phase 2A 术语口径，
 * title 兼容旧调用方），二者只能提供一个；description 显式 null = 清空简介；
 * archived：true 归档（archivedAt 置当前时间）、false 恢复（置 null），D4。
 */
export const courseUpdateRequestSchema = z
  .object({
    examType: z.string().trim().max(80).nullable().optional(),
    reviewTemplateId: reviewTemplateIdSchema.nullable().optional(),
    title: z.string().trim().min(1, "课程名不能为空").optional(),
    name: z.string().trim().min(1, "课程名不能为空").optional(),
    description: z
      .string()
      .trim()
      .max(500, "课程简介最多 500 个字符")
      .nullable()
      .optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (body) => !(body.title !== undefined && body.name !== undefined),
    "title 与 name 只能提供一个（两者同义）",
  );

/**
 * 课程 CRUD（创建/更新）响应 data。
 * T2A.4 起增加 description / archived / archivedAt（新增字段，旧消费者不受影响；
 * 课程名仍用 title 字段名——与本组既有契约一致，course-api.ts 的列表/详情用 name）。
 */
export const courseDataSchema = z.object({
  examType: z.string().nullable().optional(),
  reviewTemplateId: z.string().nullable().optional(),
  id: z.uuid(),
  title: z.string().min(1),
  /** 同级排序（小在前） */
  order: z.number().int().min(0),
  description: z.string().nullable(),
  /** 是否已归档（archivedAt 非空） */
  archived: z.boolean(),
  /** 归档时间；未归档为 null */
  archivedAt: z.string().nullable(),
});
