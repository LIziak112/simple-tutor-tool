import { z } from "zod";
import { attemptPartialRequestSchema } from "./attempt-partial.ts";

/** MCP 与网页共用分批版本、证据、幂等及选题契约；身份固定在鉴权闭包。 */
export const studentMcpSettleInputSchema =
  attemptPartialRequestSchema.safeExtend({
    practiceId: z.uuid(),
  });
export type StudentMcpSettleInput = z.infer<typeof studentMcpSettleInputSchema>;
