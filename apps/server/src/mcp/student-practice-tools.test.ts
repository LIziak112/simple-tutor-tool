import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, it } from "vitest";
import { HttpError } from "../lib/http-error.ts";
import { callToolJson } from "../test/mcp-test-utils.ts";

it("三个新读工具仅注册公开读能力，错误沿统一guard，不扩大旧提交工具", async () => {
  const { registerStudentPracticeTools } = await import(
    "./student-practice-tools.ts"
  );
  const server = new McpServer({
    name: "practice-read-registration",
    version: "1",
  });
  registerStudentPracticeTools(server, {
    list: () => ({ schemaVersion: 1, practices: [], total: 0 }),
    practice: () => {
      throw new HttpError(403, "AI_POLICY_DISABLED", "当前教学模式不可读题", {
        answers: "私有答案",
        teacherComment: "私注",
        snapshot: { solutionMd: "私有图" },
      });
    },
    question: () => {
      throw new HttpError(403, "AI_POLICY_DISABLED", "当前教学模式不可读题");
    },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "read-registration", version: "1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_practice",
      "get_practice_question",
      "list_my_practices",
    ]);
    for (const tool of tools)
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
    expect(await callToolJson(client, "list_my_practices", {})).toEqual({
      isError: false,
      data: { schemaVersion: 1, practices: [], total: 0 },
    });
    expect(
      await callToolJson(client, "get_practice", {
        practiceId: "10000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({
      isError: true,
      data: { error: "AI_POLICY_DISABLED", message: "当前教学模式不可读题" },
    });
  } finally {
    await client.close();
    await server.close();
  }
});
