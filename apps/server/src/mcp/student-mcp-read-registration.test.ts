import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { callToolJson } from "../test/mcp-test-utils.ts";
import { createPersonalMcpServer } from "./personal-server.ts";
import {
  createStudentMcpServer,
  STUDENT_MCP_TOOL_NAMES,
} from "./student-server.ts";

// 历史兼容快照，不是运行时新工具名单；新增工具不能使这些旧名字消失。
const legacyNames = [
  "claim_ai_task",
  "claim_attempt_review",
  "create_wrong_practice",
  "get_current_context",
  "list_my_ai_tasks",
  "list_my_attempt_reviews",
  "list_my_wrong_questions",
  "renew_ai_lease",
  "renew_attempt_review_lease",
  "submit_ai_reply",
  "check_ai_reply",
  "submit_rubric_opinion",
  "submit_attempt_review_result",
  "student_submit_practice_question",
  "list_my_memos",
  "add_memo",
  "get_memo_media",
];

async function withClient(
  server: McpServer,
  run: (client: Client) => Promise<void>,
) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-read-compatibility", version: "1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function deps() {
  return {
    db: createTestDb(),
    dataDir: createTestDir(),
    publicUrl: "http://localhost:8787",
    studentId: "student-read-compat",
    hmacSecret: "fixture-secret",
    isAuthorized: () => true,
  };
}

describe("A1 注册拆分的旧工具兼容", () => {
  it("学生实例保留全部17个旧工具，运行名单与实际注册精确相等", async () => {
    await withClient(createStudentMcpServer(deps()), async (client) => {
      const tools = (await client.listTools()).tools;
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual([...STUDENT_MCP_TOOL_NAMES].sort());
      expect(names).toEqual(expect.arrayContaining(legacyNames));
      expect(new Set(names).size).toBe(names.length);
      const submit = tools.find(
        (tool) => tool.name === "student_submit_practice_question",
      );
      expect(submit?.annotations).toMatchObject({
        destructiveHint: true,
        idempotentHint: true,
      });
      expect(submit?.inputSchema.oneOf).toHaveLength(3);
      expect(submit?.inputSchema.required).toEqual(
        expect.arrayContaining([
          "practiceId",
          "questionRevisionId",
          "workflowVersion",
          "workflowRevision",
          "expectedAnswerRevision",
          "evidence",
        ]),
      );
    });
  });

  it("个人实例复用全部学生工具，不出现班级管理工具", async () => {
    await withClient(
      createPersonalMcpServer({ ...deps(), teacherId: TEST_TEACHER_ID }),
      async (client) => {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        expect(names).toEqual(expect.arrayContaining(legacyNames));
        expect(names).not.toContain("create_student");
        expect(names).not.toContain("assign_homework");
      },
    );
  });

  it("公开读定位条件在真实tools/list与runtime均要求id或题序", async () => {
    await withClient(createStudentMcpServer(deps()), async (client) => {
      const tool = (await client.listTools()).tools.find(
        (item) => item.name === "get_practice_question",
      );
      expect(tool?.inputSchema.type).toBe("object");
      expect(tool?.inputSchema.additionalProperties).toBe(false);
      expect(tool?.inputSchema.anyOf).toEqual([
        { required: ["questionId"] },
        { required: ["questionNo"] },
      ]);
      const missing = await client.callTool({
        name: "get_practice_question",
        arguments: { practiceId: "10000000-0000-4000-8000-000000000001" },
      });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing.content)).toContain("请提供题目 id 或题序");
      const unknown = await client.callTool({
        name: "get_practice_question",
        arguments: {
          practiceId: "10000000-0000-4000-8000-000000000001",
          questionNo: 1,
          rogue: "禁止静默strip",
        },
      });
      expect(unknown.isError).toBe(true);
      expect(JSON.stringify(unknown.content)).toContain("rogue");
    });
  });

  it("无参数current继续返回旧disabled状态，不隐式造任务或当前题", async () => {
    await withClient(createStudentMcpServer(deps()), async (client) => {
      expect(await callToolJson(client, "get_current_context", {})).toEqual({
        isError: false,
        data: { status: "disabled" },
      });
    });
  });
});
