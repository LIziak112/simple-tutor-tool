import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/**
 * stateless Streamable HTTP：一次 HTTP 请求 = 一台刚建好的 McpServer 实例 +
 * 一个 transport，处理完即关（教师 /mcp、学生 /mcp/student、个人 /mcp/personal
 * 三个挂载共用；模块 0 抽出单源）。
 *
 * - 不传 sessionIdGenerator（缺省 undefined = 无会话；SDK 文档的显式 undefined
 *   写法在 exactOptionalPropertyTypes 下类型不接受，省略语义完全相同）；
 * - enableJsonResponse: true——工具型服务器用 JSON 响应（非 SSE 流）；
 * - GET 返回 200 立即关闭的空 SSE 流、DELETE 返回 200 空体（SDK 1.31 实际行为，
 *   无功能与安全影响）；协议内错误由 SDK 按 MCP 规范应答。
 */
export async function serveStatelessMcpRequest(
  server: McpServer,
  request: Request,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  // 请求结束关闭 transport 与 server 实例（stateless：不留任何状态）
  transport.onclose = () => {
    void server.close();
  };
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    // 兜底清理（onclose 之外路径，如 handleRequest 抛错）；已关闭时再关为幂等 no-op
    await transport.close();
  }
}
