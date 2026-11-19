import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { teacherResponseAnswerEditSchema } from "@tutor/contract";
import type { Db } from "../db/client.ts";
import { editTeacherDraftAnswer } from "../services/kernel-choice-amendments.ts";
import { guard, jsonContent } from "./tool-result.ts";

export function registerTeacherAnswerEdit(
  server: McpServer,
  db: Db,
  dataDir: string,
  teacherId: string,
): void {
  server.registerTool(
    "update_response_answer",
    {
      description:
        "修正未作废草稿卷中未提交题目的草稿答案。用 query_student_responses 定位并读取版本。修正不会提交、判分或计入学生改答次数，原因同步留痕。",
      inputSchema: teacherResponseAnswerEditSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guard((edit) =>
      jsonContent(editTeacherDraftAnswer(db, dataDir, teacherId, edit)),
    ),
  );
}
