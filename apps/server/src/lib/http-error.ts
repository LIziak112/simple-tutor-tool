import type { Context } from "hono";
import type { ZodType } from "zod";

/**
 * 带 HTTP 状态码与 UPPER_SNAKE 错误码的业务异常。
 * service 层抛出，统一错误中间件（app.ts onError）映射为 §0.3 响应壳：
 * { ok:false, error:code, message } + 对应状态码。
 */

/** 业务错误允许的状态码（Hono 的 c.json 需要字面量状态类型，收窄在这里集中管理） */
export type HttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429;

export class HttpError extends Error {
  constructor(
    /** HTTP 状态码 */
    readonly status: HttpErrorStatus,
    /** UPPER_SNAKE 错误码（TEACHER_EXISTS / INVALID_CREDENTIALS / …，见 packages/contract auth.ts） */
    readonly code: string,
    message: string,
    /**
     * 附加进错误响应壳的额外字段（如导入 commit 的 LINT_ERROR 携带 _issues 供前端标红）。
     * 键名建议下划线开头，避免与统一壳的 ok/error/message 混淆；无附加信息时省略。
     */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * 解析并校验 JSON 请求体。
 * 不合法（非 JSON / 不符合契约 schema）时抛 400 VALIDATION_ERROR，
 * 中文提示带上第一条 issue 说明（契约 schema 里写的中文 message）。
 * 说明：项目未安装 @hono/zod-validator（零新增依赖），用这一处等价实现。
 */
export async function parseJsonBody<T>(
  c: Context,
  schema: ZodType<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "VALIDATION_ERROR", "请求体不是合法的 JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "格式不正确";
    throw new HttpError(400, "VALIDATION_ERROR", `请求参数不合法：${first}`);
  }
  return parsed.data;
}
