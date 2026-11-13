import { z } from "zod";
import { wrongPracticeRequestSchema } from "./attempt.ts";

export const createOperationIdSchema = z.uuid();
export const replayableWrongPracticeRequestSchema =
  wrongPracticeRequestSchema.safeExtend({
    operationId: createOperationIdSchema.optional(),
  });

/** 同一次重开确认固定使用相同操作标识和原卷。 */
export const lessonRestartRequestSchema = z.strictObject({
  operationId: createOperationIdSchema,
  expectedAttemptId: z.uuid(),
});

export type LessonRestartRequest = z.infer<typeof lessonRestartRequestSchema>;
