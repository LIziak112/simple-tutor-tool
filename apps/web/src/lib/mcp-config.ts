import { type AccountKind, PERSONAL_MCP_PATH } from "@tutor/contract";

/**
 * mcpServers 客户端配置片段生成（教师 /t/connect 与学生 /s/settings/ai 共用）：
 * 两端保持同一份结构（type/url/headers Bearer + 2 空格缩进），用户在客户端
 * 之间迁移时配置样式一致；serverKey 区分两端——教师 "tutor"、学生
 * "tutor-student"、个人账号 "tutor-personal"（同一客户端同时配置多个端点时
 * 不互相覆盖）。
 */

/**
 * 学习者 AI 连接的 MCP 端点与配置键（模块 0）：班级学生 → /mcp/student；
 * 个人账号的学习者 → /mcp/personal（同一枚 token，教师白名单 ∪ 学生全部工具）。
 */
export function learnerMcpEndpoint(
  origin: string,
  accountKind: AccountKind,
): { url: string; serverKey: string } {
  return accountKind === "personal"
    ? { url: `${origin}${PERSONAL_MCP_PATH}`, serverKey: "tutor-personal" }
    : { url: `${origin}/mcp/student`, serverKey: "tutor-student" };
}
export function buildMcpServersConfig(options: {
  serverKey: string;
  serverUrl: string;
  token: string;
}): string {
  return JSON.stringify(
    {
      mcpServers: {
        [options.serverKey]: {
          type: "http",
          url: options.serverUrl,
          headers: { Authorization: `Bearer ${options.token}` },
        },
      },
    },
    null,
    2,
  );
}
