import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { createApp } from "../app.ts";

/**
 * MCP 测试的 SDK 客户端连接样板：fetch 桥接 app.request（不监听端口、
 * 协议链路真实）。student-mcp.test.ts 与 student-mcp-tools.test.ts 共用；
 * 教师 mcp.test.ts 的同款为 B14 前既有拷贝，不在 B14 diff 内未并入。
 */

/** fetch 桥接：SDK 客户端 HTTP 请求直达 app.request（协议链路真实） */
export function fetchViaApp(app: ReturnType<typeof createApp>): FetchLike {
  return (url, init) => {
    const target = new URL(String(url));
    return Promise.resolve(app.request(target.pathname + target.search, init));
  };
}

/** 建立 SDK 客户端连接（Streamable HTTP + Bearer token 直达 app） */
export async function connectMcpClientViaApp(
  app: ReturnType<typeof createApp>,
  /** 挂载路径（如 "/mcp/student"）；host 由 fetchViaApp 丢弃，仅占位 */
  path: string,
  token: string,
  clientName: string,
): Promise<Client> {
  const client = new Client({ name: clientName, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://localhost${path}`),
    {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: fetchViaApp(app),
    },
  );
  // SDK 可选回调属性在 exactOptionalPropertyTypes 下与 Transport 接口形态有
  // 出入（教师 mcp.test.ts 同款单层收窄；运行时无误）
  await client.connect(
    transport as unknown as Parameters<Client["connect"]>[0],
  );
  return client;
}
