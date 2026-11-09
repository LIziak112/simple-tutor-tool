import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PERSONAL_TEACHER_TOOL_NAMES } from "@tutor/contract";
import type { Db } from "../db/client";
import { registerTeacherTools } from "./server";
import { registerStudentTools, STUDENT_MCP_TOOL_NAMES } from "./student-server";
import { AllowListMcpServer } from "./tool-allow-list";

/**
 * 个人账号 MCP 服务器（模块 0「一枚 token」；第 3 版计划 §3 / 问题清单 Q9 定案）。
 *
 * 一台实例、两份注册、一张白名单：
 * - 教师工具按 PERSONAL_TEACHER_TOOL_NAMES（契约单源）白名单放行——内容管线
 *   （导入 / lint / 资源库 / 课程整理）与本人学习数据的只读查询；班级管理类
 *   （学生 / 作业 / 报告 / 作答改写）结构上不存在；
 * - 学生工具全部放行（STUDENT_MCP_TOOL_NAMES：AI 伴学任务 / 复盘 / 错题）；
 * - 两份工具的域分别绑定个人账号的教师行与学习者行（同一个人，
 *   teachers.personalStudentId），身份只来自鉴权中间件注入的 deps。
 *
 * 白名单由 AllowListMcpServer 在注册时执行（名字不在单内即移除），不是
 * tools/list 层的隐藏——伪造 tools/call 得到协议层 Unknown tool。
 */
export const PERSONAL_MCP_SERVER_NAME = "simple-tutor-tool-personal";
export const PERSONAL_MCP_SERVER_VERSION = "2.0.0";

/** /mcp/personal 实例的完整工具名单（教师白名单 ∪ 学生全部），测试与文档的断言单源 */
export const PERSONAL_MCP_TOOL_NAMES: readonly string[] = [
  ...PERSONAL_TEACHER_TOOL_NAMES,
  ...STUDENT_MCP_TOOL_NAMES,
];

/** createPersonalMcpServer 的依赖注入 */
export interface PersonalMcpServerDeps {
  readonly db: Db;
  /** DATA_DIR（learning-pack 装配、导入图片核对、材料 PNG 读取） */
  readonly dataDir: string;
  readonly publicUrl: string;
  /** DSL 规范目录覆盖（createApp options.specDir 透传） */
  readonly specDir?: string | undefined;
  /** 个人账号的教师行 id（教师白名单工具的域） */
  readonly teacherId: string;
  /** 绑定学习者 id（学生工具的域） */
  readonly studentId: string;
  /** 快照装配 HMAC 密钥（DATA_DIR/secret.key） */
  readonly hmacSecret: string;
}

/**
 * 创建一台绑定单个个人账号的 MCP 服务器实例（教师白名单 + 学生全部工具）。
 * stateless 挂载下每个 HTTP 请求新建一个实例。
 */
export function createPersonalMcpServer(
  deps: PersonalMcpServerDeps,
): McpServer {
  const server = new AllowListMcpServer(
    { name: PERSONAL_MCP_SERVER_NAME, version: PERSONAL_MCP_SERVER_VERSION },
    PERSONAL_MCP_TOOL_NAMES,
  );
  registerTeacherTools(server, {
    db: deps.db,
    dataDir: deps.dataDir,
    teacherId: deps.teacherId,
    specDir: deps.specDir,
  });
  registerStudentTools(server, {
    db: deps.db,
    dataDir: deps.dataDir,
    publicUrl: deps.publicUrl,
    studentId: deps.studentId,
    hmacSecret: deps.hmacSecret,
  });
  return server;
}
