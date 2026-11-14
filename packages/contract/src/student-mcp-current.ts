import { z } from "zod";
import { learningContextSchema } from "./learning-context.ts";
import {
  aiMcpCurrentContextSchema,
  MCP_LIVE_FOCUS_MAX_VIEWS,
} from "./student-mcp-live-focus.ts";
import { studentMcpPracticeListDataSchema } from "./student-mcp-practice.ts";
export const studentMcpCurrentInputSchema = z.strictObject({
  responseVersion: z.literal(2).optional(),
});
export const studentMcpCurrentDataSchema = z.strictObject({
  responseVersion: z.literal(2),
  taskContext: aiMcpCurrentContextSchema,
  liveEnabled: z.boolean(),
  location: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("current"),
      context: learningContextSchema,
    }),
    z.strictObject({
      status: z.literal("candidates"),
      contexts: z
        .array(learningContextSchema)
        .min(2)
        .max(MCP_LIVE_FOCUS_MAX_VIEWS),
    }),
    z.strictObject({
      status: z.literal("recent_practice"),
      practice: studentMcpPracticeListDataSchema.shape.practices.element,
    }),
    z.strictObject({ status: z.literal("none") }),
    z.strictObject({ status: z.literal("unavailable") }),
    z.strictObject({ status: z.literal("overflow") }),
  ]),
});
export type StudentMcpCurrentData = z.infer<typeof studentMcpCurrentDataSchema>;
