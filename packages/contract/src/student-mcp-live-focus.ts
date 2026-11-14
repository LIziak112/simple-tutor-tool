import { z } from "zod";
import { learningContentIdSchema } from "./learning-context.ts";

export const MCP_LIVE_FOCUS_HEARTBEAT_MS = 20_000;
export const MCP_LIVE_FOCUS_TTL_MS = 60_000;
export const MCP_LIVE_FOCUS_MAX_VIEWS = 12;
const liveFocusGenerationSchema = z.hash("sha256");

/** 每个作答页面单独上报单调序号，空题号表示撤回该页面焦点。 */
export const studentMcpLiveFocusRequestSchema = z.strictObject({
  generation: liveFocusGenerationSchema,
  viewId: z.uuid(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  questionId: learningContentIdSchema.nullable(),
});
export const studentMcpLiveFocusCapabilitySchema = z.strictObject({
  generation: liveFocusGenerationSchema.nullable(),
});
export type StudentMcpLiveFocusRequest = z.infer<
  typeof studentMcpLiveFocusRequestSchema
>;

/** 实时工具仅定位已由学生主动发起的待领取任务。 */
export const aiMcpCurrentContextSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("disabled") }),
  z.strictObject({ status: z.literal("no_current_question") }),
  z.strictObject({ status: z.literal("student_action_required") }),
  z.strictObject({ status: z.literal("authorized_task"), taskId: z.uuid() }),
]);
export type AiMcpCurrentContext = z.infer<typeof aiMcpCurrentContextSchema>;
