import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { aiMcpCurrentContextSchema } from "@tutor/contract";
import type { Db } from "../db/client.ts";
import { getStudentMcpCurrentContext } from "../services/ai-companion/student-ai-live-context.ts";
import { guard, jsonContent } from "./tool-result.ts";

export function registerStudentLiveFocusTool(
  server: McpServer,
  db: Db,
  studentId: string,
  connectionId?: string,
): void {
  server.registerTool(
    "get_current_context",
    {
      description:
        "定位学生在当前题主动加入队列的求助。仅返回状态和可选任务 ID，读取任务仍需显式领取。",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(() =>
      jsonContent(
        aiMcpCurrentContextSchema.parse(
          getStudentMcpCurrentContext(db, studentId, connectionId),
        ),
      ),
    ),
  );
}
