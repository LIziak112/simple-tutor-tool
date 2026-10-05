import type { Context } from "hono";
import type { ZodType } from "zod";

/**
 * 带 HTTP 状态码与 UPPER_SNAKE 错误码的业务异常。
 * service 层抛出，统一错误中间件（app.ts onError）映射为 §0.3 响应壳：
 * { ok:false, error:code, message } + 对应状态码。
 */

/**
 * 业务错误允许的状态码（Hono 的 c.json 需要字面量状态类型，收窄在这里集中管理）。
 * 500 仅用于需要向调用方传达中文原因的部署级错误（如 T1.13 的 SPEC_UNAVAILABLE：
 * 规范文档目录缺失），其余未处理异常仍走 app.ts 的通用 500 INTERNAL 壳。
 * 413 为 T2.8 笔迹超限（INK_TOO_LARGE）启用；
 * 415 为图片白名单外格式（UNSUPPORTED_MEDIA_TYPE，媒体管线）启用。
 */
export type HttpErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 413
  | 415
  | 422
  | 429
  | 500;

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
  return parseJsonText(await c.req.text(), schema);
}

/**
 * parseJsonBody 的空请求体变体（T6R.3 交卷）：请求体为空（无 body 或纯空白）
 * 时返回 **undefined** 而不是 400——供「请求体可省略、省略按空集合语义」的
 * 接口使用（交卷不带请求体 → 空 revisions → 与冻结集合比对失败 →
 * 409 QUESTION_REVISION_STALE 可诊断，见 attempt-service.submitAttempt）。
 * 非空但非法（非 JSON / 不符合 schema）仍走 400 VALIDATION_ERROR。
 */
export async function parseJsonBodyOrEmpty<T>(
  c: Context,
  schema: ZodType<T>,
): Promise<T | undefined> {
  const text = await c.req.text();
  if (text.trim() === "") return undefined;
  return parseJsonText(text, schema);
}

/** 两个 parseJsonBody 变体的共享段：文本 → JSON.parse → schema 校验（400 口径一致） */
function parseJsonText<T>(text: string, schema: ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
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
