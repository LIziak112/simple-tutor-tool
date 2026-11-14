import { z } from "zod";
import {
  learningContentIdSchema,
  learningContextSchema,
} from "./learning-context.ts";
import { MEMO_METADATA_MAX_BYTES } from "./memo-api.ts";
/** 只读来源选择，不接收授权、阶段或客户端拼装的会话坐标。 */
export const LEARNING_CONTEXT_BODY_MAX_BYTES = MEMO_METADATA_MAX_BYTES;
export const learningContextRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("question"),
    attemptId: z.uuid(),
    questionId: learningContentIdSchema,
    surface: z.enum(["attempt", "result", "lesson"]),
    expectedQuestionRevisionId: z.uuid().optional(),
  }),
  z.strictObject({
    kind: z.literal("lecture"),
    lectureId: learningContentIdSchema,
    courseId: learningContentIdSchema.optional(),
    sectionId: z.null().optional(),
  }),
]);
export type LearningContextRequest = z.infer<
  typeof learningContextRequestSchema
>;
export const learningContextOkSchema = z.object({
  ok: z.literal(true),
  data: learningContextSchema,
});
