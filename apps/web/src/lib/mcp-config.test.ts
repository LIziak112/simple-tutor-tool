import { describe, expect, it } from "vitest";
import { buildMcpServersConfig } from "./mcp-config";

/**
 * mcpServers 客户端配置片段生成测试（教师 /t/connect 与学生 /s/settings/ai
 * 共用一份生成逻辑）：两端结构一致（type/url/headers + 2 空格缩进），仅
 * serverKey 与代入的地址/Token 不同——教师键 "tutor"、学生键
 * "tutor-student"（同一客户端同时配置两端时不互相覆盖）。
 */

function parseConfig(text: string): {
  server: { type: string; url: string; headers: Record<string, string> };
} {
  const parsed = JSON.parse(text) as {
    mcpServers: Record<
      string,
      { type: string; url: string; headers: Record<string, string> }
    >;
  };
  const keys = Object.keys(parsed.mcpServers);
  expect(keys).toHaveLength(1);
  const server = parsed.mcpServers[keys[0] as string];
  if (server === undefined) throw new Error("mcpServers 条目缺失");
  return { server };
}

describe("buildMcpServersConfig（教师/学生共用配置生成）", () => {
  it("教师键 tutor：代入地址与真实 Token，结构为 type/url/headers Bearer", () => {
    const text = buildMcpServersConfig({
      serverKey: "tutor",
      serverUrl: "http://localhost:8787/mcp",
      token: "t47-real-token",
    });
    expect(text).toBe(
      JSON.stringify(
        {
          mcpServers: {
            tutor: {
              type: "http",
              url: "http://localhost:8787/mcp",
              headers: { Authorization: "Bearer t47-real-token" },
            },
          },
        },
        null,
        2,
      ),
    );
  });

  it("学生键 tutor-student：代入学生端点与占位 Token，同结构可直接复制", () => {
    const text = buildMcpServersConfig({
      serverKey: "tutor-student",
      serverUrl: "http://192.168.1.10:8787/mcp/student",
      token: "<你的MCP_TOKEN>",
    });
    const { server } = parseConfig(text);
    expect(server.type).toBe("http");
    expect(server.url).toBe("http://192.168.1.10:8787/mcp/student");
    expect(server.headers.Authorization).toBe("Bearer <你的MCP_TOKEN>");
  });
});
