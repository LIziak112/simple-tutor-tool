import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Db } from "../db/client";

/**
 * 学生 MCP 工具实例（SAI-25 首发骨架 / SAI-26 注册任务工具）。
 *
 * 与教师 server.ts **独立构建**（B14 执行步骤 3）：不把教师 14 工具全部
 * 注册后仅在 tools/list 隐藏，而是从零构造只属于学生的 McpServer——教师
 * 工具在本实例结构上不存在，伪造 tools/call 也无法调用（协议层 Unknown
 * tool）。学生身份（studentId）只来自鉴权中间件注入的 deps，全部工具闭包
 * 固定该域；调用参数自报 studentId 一律无效。
 */
export const STUDENT_MCP_SERVER_NAME = "simple-tutor-tool-student";
export const STUDENT_MCP_SERVER_VERSION = "2.0.0";

/** createStudentMcpServer 的依赖注入 */
export interface StudentMcpServerDeps {
  readonly db: Db;
  /** DATA_DIR（材料 PNG 字节读取） */
  readonly dataDir: string;
  /** token 绑定的学生（全部工具以此域隔离；唯一身份来源是鉴权中间件） */
  readonly studentId: string;
}

/**
 * 创建一台绑定单学生的 MCP 服务器实例。
 * stateless 挂载下每个 HTTP 请求新建一个实例（注册开销可忽略，无跨请求状态）。
 * SAI-25 首发为空工具集；SAI-26 在此注册四类任务工具
 * （list_my_ai_tasks / claim_ai_task / renew_ai_lease / submit_ai_reply）。
 */
export function createStudentMcpServer(deps: StudentMcpServerDeps): McpServer {
  const server = new McpServer({
    name: STUDENT_MCP_SERVER_NAME,
    version: STUDENT_MCP_SERVER_VERSION,
  });
  // SAI-26：工具注册入口（保持 deps 闭包域 = token 学生域）
  void deps;
  return server;
}
