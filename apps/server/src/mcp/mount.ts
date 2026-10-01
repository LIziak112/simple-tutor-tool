import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { Db } from "../db/client";
import { createRequireMcpToken, type McpEnv } from "./auth";
import { createMcpServer } from "./server";

/**
 * /mcp 挂载（T4.6）——SDK Streamable HTTP 传输，**不走统一壳、不走 /api 前缀**
 * （SDK 协议格式原样；app.ts 挂在 /api 路由之后、静态托管之前）。
 *
 * 挂载方式：Hono 子应用桥接 SDK Web 标准 RequestHandler——
 * c.req.raw（原生 Request）→ transport.handleRequest → 原生 Response 原样返回。
 *
 * stateless 模式（sessionIdGenerator: undefined）：每个 HTTP 请求独立成套
 * （新建 McpServer 实例 + transport，请求结束即关），无跨请求会话状态——
 * 工具全部无状态、按 token 绑定教师域，stateless 是最简且无状态漂移的形态
 * （SDK 文档：无 Session ID、无会话校验；GET 带 token+accept SSE 返回 200 的立即关闭空流、
 * DELETE 返回 200 空体——Opus 实测④核实的 SDK 1.31 实际行为，无功能与安全影响）。
 * enableJsonResponse: true——工具型服务器用 JSON 响应（非 SSE 流）。
 *
 * 鉴权：createRequireMcpToken 在 transport 之前执行（无/错 token/禁用教师 →
 * 401，同一文案防探测，D22）。
 */

/** 挂载选项（与 createApp 的注入面一致） */
export interface McpMountOptions {
  readonly db: Db;
  /** DATA_DIR（learning-pack 装配） */
  readonly dataDir: string;
  /** DSL 规范目录覆盖（缺省按 spec-files.ts 候选顺序解析） */
  readonly specDir?: string | undefined;
}

/**
 * 创建 /mcp 子应用（app.route("/mcp", …) 挂载）。
 * 全方法接听（app.all）：POST 走 SDK；GET/DELETE 交由 SDK stateless 语义处理
 * （GET=200 立即关闭的空 SSE 流、DELETE=200 空体，见文件头注释；PUT/PATCH 等才 405）。
 */
export function createMcpRoutes(options: McpMountOptions) {
  const requireToken = createRequireMcpToken(options.db);
  return new Hono<McpEnv>().use("*", requireToken).all("/", async (c) => {
    // 鉴权通过：token 绑定的教师（c.var.mcpTeacher）成为本请求全部工具的域
    const server = createMcpServer({
      db: options.db,
      dataDir: options.dataDir,
      teacherId: c.var.mcpTeacher.id,
      specDir: options.specDir,
    });
    // stateless 模式：不传 sessionIdGenerator（运行时读 options.sessionIdGenerator，
    // 缺省即 undefined = 无会话；SDK 文档的显式 undefined 写法在
    // exactOptionalPropertyTypes 下类型不接受，省略语义完全相同）。
    // enableJsonResponse: true——工具型服务器用 JSON 响应（非 SSE 流）。
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    // 请求结束关闭 transport 与 server 实例（stateless：不留任何状态）
    transport.onclose = () => {
      void server.close();
    };
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      // 兜底清理（onclose 之外路径，如 handleRequest 抛错）；
      // 已关闭时再关为幂等 no-op
      await transport.close();
    }
  });
}
