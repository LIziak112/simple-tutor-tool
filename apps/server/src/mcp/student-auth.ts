import { eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import type { Db } from "../db/client";
import { students, teachers } from "../db/schema";
import { findActiveMcpConnectionByToken } from "../services/ai-companion/connection-service";
import { getStudentAccount } from "../services/student-service";

/**
 * 学生 MCP 鉴权中间件（SAI-25，B14）——/mcp/student 整组的入口防线。
 *
 * 与教师 /mcp（auth.ts）对称但**凭证域物理隔离**（D1：独立 /mcp/student，
 * 不复用 /mcp 凭证分流）：
 * - `Authorization: Bearer <token>` → `ai_connections`（channel=mcp，active）
 *   的 tokenHash 命中（sha256("ai-mcp-token:"+token) 分用途哈希——教师
 *   apiToken、登录链接 Token 都到不了本域）→ 绑定学生到 c.var.mcpStudent，
 *   之后每个工具按该学生域隔离；**不接受调用参数自报 studentId**；
 * - 浏览器 Cookie 不参与：本端点不读任何会话 Cookie（学生 Cookie 不能换取
 *   MCP 凭证，外部凭证也不能管理账号——会话守卫的接口不认 Bearer，两侧互不
 *   越权）；
 * - 实时核对（每个 HTTP 请求独立成套，无缓存）：无 token / 错 token /
 *   重置（撤销，旧哈希被覆盖）/ 删除连接（archivedAt）/ 学生归档 / 所属
 *   教师禁用或缺失 → 401，**同一份文案**（防探测，不区分具体原因）；
 * - 401 响应不走 HTTP 统一壳（/mcp 不在 /api 命名空间），简单 JSON +
 *   RFC 6750 的 WWW-Authenticate: Bearer，MCP 客户端据此引导重新配置凭证。
 *
 * 注：mcp token 无有效期字段（SAI-16 定案）——「到期」不存在，失效即撤销
 * （重置覆盖哈希 / 删除归档）两态，均实时生效。
 */

/** /mcp/student 路由的环境类型（c.var.mcpStudent） */
export interface StudentMcpEnv {
  Variables: {
    /** token 绑定的学生身份（全部工具闭包的唯一身份来源） */
    mcpStudent: {
      readonly id: string;
      /** 命中的 mcp 连接行 id（审计/调试用；不进协议响应） */
      readonly connectionId: string;
    };
  };
}

/** 401 响应体（非统一壳：/mcp 独立于 /api 的响应格式） */
const UNAUTHORIZED_BODY = {
  error: "UNAUTHORIZED",
  message: "MCP Token 无效或已失效，请在「连接 AI」设置中重置后重试",
} as const;

/**
 * 解析 Authorization: Bearer <token>；非 Bearer 形式返回 null。
 * 大小写不敏感（RFC 7235 scheme 大小写无关；与教师 auth.ts 同式）。
 */
function bearerTokenOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token !== undefined && token.length > 0 ? token : null;
}

/** 401 响应（统一文案 + WWW-Authenticate，防探测） */
function unauthorized(c: Context): Response {
  return c.json(UNAUTHORIZED_BODY, 401, {
    "WWW-Authenticate": 'Bearer realm="simple-tutor-tool student MCP"',
  });
}

/**
 * 学生所属教师的可用性（教师域可用性实时核对，B14 执行步骤 4）：
 * 学生行存在且所属教师未被禁用——教师被禁用时其学生域的外部数据面
 * （MCP 出口）一并冻结；查不到任何环节都按不可用处理（同文案不泄露原因）。
 */
function teacherDomainUsable(db: Db, studentId: string): boolean {
  const student = db
    .select({ teacherId: students.teacherId })
    .from(students)
    .where(eq(students.id, studentId))
    .get();
  // teacherId 列可空（历史行）；空值 = 域不完整，按不可用处理（同文案）
  if (student?.teacherId == null) return false;
  const teacher = db
    .select({ disabledAt: teachers.disabledAt })
    .from(teachers)
    .where(eq(teachers.id, student.teacherId))
    .get();
  return teacher !== undefined && teacher.disabledAt === null;
}

/**
 * /mcp/student 鉴权中间件工厂：逐请求实时核对，通过后把 token 绑定的学生
 * 放进 c.var.mcpStudent。所有路径显式 return（noImplicitReturns）。
 */
export function createRequireStudentMcpToken(db: Db) {
  return async (
    c: Context<StudentMcpEnv>,
    next: Next,
  ): Promise<Response | undefined> => {
    const token = bearerTokenOf(c.req.header("authorization"));
    const connection =
      token === null ? null : findActiveMcpConnectionByToken(db, token);
    const account =
      connection === null ? null : getStudentAccount(db, connection.studentId);
    if (
      connection === null ||
      account === null ||
      !teacherDomainUsable(db, connection.studentId)
    ) {
      return unauthorized(c);
    }
    c.set("mcpStudent", { id: account.id, connectionId: connection.id });
    await next();
    return;
  };
}
