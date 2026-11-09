import type { Context, Next } from "hono";
import type { Db } from "../db/client";
import { resolveMcpStudentToken, unauthorizedMcpStudent } from "./student-auth";

/**
 * 个人账号 MCP 鉴权中间件（模块 0「一枚 token」）——/mcp/personal 的入口防线。
 *
 * 个人账号的唯一外部凭证就是其绑定学习者的 AI 连接 token（ai_connections，
 * channel=mcp）：解析与 /mcp/student 共用 resolveMcpStudentToken（连接命中 +
 * 学生未归档 + 教师域可用，实时核对、无缓存），再加一道账号类型闸门——
 * 只接受 accountKind='personal' 的学习者；班级学生的 token 来本端点、个人 token
 * 去 /mcp/student、教师 apiToken 来任一学生端点，都是同一份 401 文案（防探测）。
 *
 * 通过后 c.var.mcpPersonal 同时携带教师 id（教师白名单工具的域）与学生 id
 * （学生工具的域）——两者在数据上就是同一个人（teachers.personalStudentId），
 * 工具闭包不信任任何客户端自报身份。
 */

/** /mcp/personal 路由的环境类型（c.var.mcpPersonal） */
export interface PersonalMcpEnv {
  Variables: {
    mcpPersonal: {
      /** 个人账号的教师行 id（教师白名单工具的域） */
      readonly teacherId: string;
      /** 绑定学习者 id（学生工具的域） */
      readonly studentId: string;
      /** 命中的 mcp 连接行 id（审计 / 调试用；不进协议响应） */
      readonly connectionId: string;
    };
  };
}

/** /mcp/personal 鉴权中间件工厂。所有路径显式 return（noImplicitReturns）。 */
export function createRequirePersonalMcpToken(db: Db) {
  return async (
    c: Context<PersonalMcpEnv>,
    next: Next,
  ): Promise<Response | undefined> => {
    const resolved = resolveMcpStudentToken(db, c.req.header("authorization"));
    if (resolved === null || resolved.accountKind !== "personal") {
      return unauthorizedMcpStudent(c);
    }
    c.set("mcpPersonal", {
      teacherId: resolved.teacherId,
      studentId: resolved.studentId,
      connectionId: resolved.connectionId,
    });
    await next();
    return;
  };
}
