import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  aiMcpCurrentContextSchema,
  studentMcpCurrentInputSchema,
} from "@tutor/contract";
import type { Db } from "../db/client.ts";
import { getStudentMcpCurrentContext } from "../services/ai-companion/student-ai-live-context.ts";
import { getStudentMcpCurrentV2 } from "../services/student-mcp-current.ts";
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
        "定位学生在当前题主动加入队列的求助。默认仅返回状态和可选任务 ID，读取任务仍需显式领取。responseVersion=2 增加当前题规范上下文；多窗口冲突返回候选，须让学生选择，溢出或失权不猜题；无页面时仅返回最近进行中练习。",
      inputSchema: studentMcpCurrentInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard((input) =>
      jsonContent(
        input.responseVersion === 2
          ? getStudentMcpCurrentV2(db, studentId, connectionId)
          : aiMcpCurrentContextSchema.parse(
              getStudentMcpCurrentContext(db, studentId, connectionId),
            ),
      ),
    ),
  );
}
