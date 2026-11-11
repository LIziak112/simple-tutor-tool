import {
  McpServer,
  type RegisteredTool,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  AnySchema,
  ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * 白名单 MCP 服务器（个人账号 /mcp/personal 用，模块 0）。
 *
 * 复用教师 / 学生两份工具注册函数（registerTeacherTools / registerStudentTools，
 * 工具定义单源），但只保留白名单内的工具：registerTool 被拦截——名字不在白名单
 * 的工具注册后**立刻移除**，实例结构上不存在，tools/list 不出现、伪造 tools/call
 * 也只能得到协议层 Unknown tool（与学生 server「从零构造」同一安全口径，而不是
 * 「注册后仅隐藏」）。
 *
 * remove() 在实例尚未 connect 时不发 tools/list_changed 通知（SDK 1.31：
 * sendToolListChanged 仅在已连接时发送），stateless 挂载下每个请求都是先注册后
 * connect，故本拦截无协议副作用。
 */
export class AllowListMcpServer extends McpServer {
  readonly #allowed: ReadonlySet<string>;

  constructor(
    serverInfo: ConstructorParameters<typeof McpServer>[0],
    allowedToolNames: Iterable<string>,
  ) {
    super(serverInfo);
    this.#allowed = new Set(allowedToolNames);
  }

  /** 白名单外的工具：注册即移除（见文件头说明）；签名与 SDK 1.31 基类一致 */
  override registerTool<
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: OutputArgs;
      annotations?: ToolAnnotations;
      _meta?: Record<string, unknown>;
    },
    cb: ToolCallback<InputArgs>,
  ): RegisteredTool {
    const tool = super.registerTool(name, config, cb);
    if (!this.#allowed.has(name)) {
      tool.remove();
    }
    return tool;
  }
}
