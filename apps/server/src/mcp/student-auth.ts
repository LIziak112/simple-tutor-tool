import type { Context, Next } from "hono";
import { studentAiDomainOf } from "../auth/student-ai-domain.ts";
import type { Db } from "../db/client";
import { HttpError } from "../lib/http-error.ts";
import { findActiveMcpConnectionByToken } from "../services/ai-companion/connection-service";

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
 *
 * 模块 0（个人账号）：个人账号绑定学习者的 mcp token 只服务 /mcp/personal
 * （教师白名单 ∪ 学生全部工具）；拿到本端点同样 401 同文案——端点与账号类型
 * 一一对应，不让同一枚 token 在两个端点呈现两种工具面。解析单源
 * resolveMcpStudentToken 由两个端点共用，差别只在账号类型闸门。
 */

/** token 解析结果（两个端点共用）：学生 + 连接行 + 所属账号类型与教师 id */
export interface ResolvedMcpStudent {
  readonly studentId: string;
  readonly connectionId: string;
  readonly teacherId: string;
  readonly accountKind: "class" | "personal";
}

/** /mcp/student 路由的环境类型（c.var.mcpStudent） */
export interface StudentMcpEnv {
  Variables: {
    /** token 绑定的学生身份（全部工具闭包的唯一身份来源） */
    mcpStudent: ResolvedMcpStudent;
  };
}

/** 401 响应体（非统一壳：/mcp 独立于 /api 的响应格式） */
const UNAUTHORIZED_BODY = {
  error: "UNAUTHORIZED",
  message: "MCP Token 无效或已失效，请在「连接 AI」设置中重置后重试",
} as const;

/** 协议解析后、执行工具前核对同一凭证及绑定的账号域。 */
export function studentMcpToolAuthorization(
  db: Db,
  header: string | undefined,
  expected: ResolvedMcpStudent,
): () => boolean {
  return () => {
    const current = resolveMcpStudentToken(db, header);
    return (
      current?.connectionId === expected.connectionId &&
      current.studentId === expected.studentId &&
      current.teacherId === expected.teacherId &&
      current.accountKind === expected.accountKind
    );
  };
}

export function revokedMcpTokenError(): HttpError {
  return new HttpError(401, UNAUTHORIZED_BODY.error, UNAUTHORIZED_BODY.message);
}

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
 * Bearer token → 学生身份（两个端点共用的解析单源）：连接命中 + 学生未归档 +
 * 教师域可用，任一不满足 → null（调用方给同一份 401 文案）。
 */
export function resolveMcpStudentToken(
  db: Db,
  authorizationHeader: string | undefined,
): ResolvedMcpStudent | null {
  const token = bearerTokenOf(authorizationHeader);
  const connection =
    token === null ? null : findActiveMcpConnectionByToken(db, token);
  if (connection === null) return null;
  const domain = studentAiDomainOf(db, connection.studentId);
  if (domain === null) return null;
  return {
    studentId: connection.studentId,
    connectionId: connection.id,
    teacherId: domain.teacherId,
    accountKind: domain.accountKind,
  };
}

/** 401 响应（统一文案 + WWW-Authenticate，防探测）——个人端点同文案复用 */
export function unauthorizedMcpStudent(c: Context): Response {
  return unauthorized(c);
}

/**
 * /mcp/student 鉴权中间件工厂：逐请求实时核对，通过后把 token 绑定的学生
 * 放进 c.var.mcpStudent；个人账号学习者的 token 不属于本端点（同文案 401）。
 * 所有路径显式 return（noImplicitReturns）。
 */
export function createRequireStudentMcpToken(db: Db) {
  return async (
    c: Context<StudentMcpEnv>,
    next: Next,
  ): Promise<Response | undefined> => {
    const resolved = resolveMcpStudentToken(db, c.req.header("authorization"));
    if (resolved === null || resolved.accountKind !== "class") {
      return unauthorized(c);
    }
    c.set("mcpStudent", resolved);
    await next();
    return;
  };
}
