import type { Context, Next } from "hono";
import type { Db } from "../db/client";
import {
  type ApiTokenTeacher,
  authenticateApiToken,
} from "../services/api-token-service";

/**
 * MCP 鉴权中间件（T4.6，D22）——/mcp 整组的入口防线。
 *
 * - `Authorization: Bearer <apiToken>` → teachers.apiToken 命中且
 *   disabledAt IS NULL（requireTeacher 同口径：禁用即全部凭证立即失效）→
 *   绑定教师到 c.var.mcpTeacher，后续每个工具按该教师域隔离；
 * - 无 token / 错 token / 教师已禁用 → 401，**同一份文案**（防探测，不区分
 *   「token 不存在 / 错误 / 已禁用」）。401 响应不走 HTTP 统一壳（/mcp 不在
 *   /api 命名空间），用简单 JSON + RFC 6750 的 WWW-Authenticate: Bearer，
 *   MCP 客户端据此引导重新配置凭证。
 */

/** /mcp 路由的环境类型（c.var.mcpTeacher） */
export interface McpEnv {
  Variables: {
    mcpTeacher: ApiTokenTeacher;
  };
}

/** 401 响应体（非统一壳：/mcp 独立于 /api 的响应格式） */
const UNAUTHORIZED_BODY = {
  error: "UNAUTHORIZED",
  message: "API Token 无效或已失效，请在设置页查看或重置后重试",
} as const;

/**
 * 解析 Authorization: Bearer <token>；非 Bearer 形式返回 null。
 * 大小写不敏感（RFC 7235 scheme 大小写无关）。
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
    "WWW-Authenticate": 'Bearer realm="simple-tutor-tool MCP"',
  });
}

/**
 * /mcp 鉴权中间件工厂：校验通过后把 token 绑定的教师放进 c.var.mcpTeacher。
 * 所有路径显式 return（noImplicitReturns）。
 */
export function createRequireMcpToken(db: Db) {
  return async (
    c: Context<McpEnv>,
    next: Next,
  ): Promise<Response | undefined> => {
    const token = bearerTokenOf(c.req.header("authorization"));
    const teacher = token === null ? null : authenticateApiToken(db, token);
    if (teacher === null) {
      return unauthorized(c);
    }
    c.set("mcpTeacher", teacher);
    await next();
    return;
  };
}
