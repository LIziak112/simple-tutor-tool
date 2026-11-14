import { z } from "zod";
import { memoKindSchema, memoMediaSchema, memoTagsSchema } from "./memo-api.ts";
/** 分享只授予当前归属教师这一条随笔；不授予来源资源或其他随笔。 */
export const memoShareInputSchema = z.object({ teacherId: z.string().min(1) });
export const memoShareStateSchema = z.object({
  teacherId: z.string().nullable(),
  availableTeacherId: z.string().nullable(),
});
export const sharedMemoSchema = z.object({
  id: z.uuid(),
  seq: z.number().int().positive().optional(),
  kind: memoKindSchema,
  text: z.string().nullable(),
  media: memoMediaSchema.nullable(),
  tags: memoTagsSchema,
  recordedAt: z.string(),
  sourceLabel: z.string().nullable(),
});
export type SharedMemo = z.infer<typeof sharedMemoSchema>;
/** 服务端解析后的安全导航坐标；客户端集中转换为站内路由。 */
export const memoSourceTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unavailable") }),
  z.object({
    kind: z.literal("attempt"),
    attemptId: z.string(),
    questionId: z.string(),
    replaced: z.boolean(),
  }),
  z.object({
    kind: z.literal("lecture"),
    lectureId: z.string(),
    sectionId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("unit"),
    courseId: z.string(),
    unitId: z.string(),
  }),
  z.object({ kind: z.literal("course"), courseId: z.string() }),
]);
export type MemoSourceTarget = z.infer<typeof memoSourceTargetSchema>;
