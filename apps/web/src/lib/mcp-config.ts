/**
 * mcpServers 客户端配置片段生成（教师 /t/connect 与学生 /s/settings/ai 共用）：
 * 两端保持同一份结构（type/url/headers Bearer + 2 空格缩进），用户在客户端
 * 之间迁移时配置样式一致；serverKey 区分两端——教师 "tutor"、学生
 * "tutor-student"（同一客户端同时配置教师与学生端点时不互相覆盖）。
 */
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
