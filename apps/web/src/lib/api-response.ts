import {
  apiResponseSchema,
  type RequestDiagnostics,
  responseDiagnosticsOf,
} from "@tutor/contract";
import type { ZodType } from "zod";

/** 业务错误可按错误码分支处理，extra 携带统一响应壳以外的诊断。 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly extra?: Record<string, unknown>,
    readonly diagnostics?: RequestDiagnostics,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

class InvalidApiResponseError extends Error {
  constructor(
    status: number,
    readonly diagnostics?: RequestDiagnostics,
  ) {
    super(`服务器响应异常（HTTP ${status}），请稍后重试`);
    this.name = "InvalidApiResponseError";
  }
}

export function invalidApiResponse(
  status: number,
  diagnostics?: RequestDiagnostics,
): Error {
  return new InvalidApiResponseError(status, diagnostics);
}

export function requestErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const requestId =
    error instanceof ApiError || error instanceof InvalidApiResponseError
      ? error.diagnostics?.requestId
      : undefined;
  return requestId
    ? `${error.message}（请求编号 ${requestId}）`
    : error.message;
}

export function parseApiResponse(
  body: unknown,
  status: number,
  diagnostics?: RequestDiagnostics,
) {
  const parsed = apiResponseSchema.safeParse(body);
  if (!parsed.success) throw invalidApiResponse(status, diagnostics);
  return parsed.data;
}

/** XHR 上传先解统一响应壳，再验证各自的成功数据。 */
export function parseUploadResponse<T>(
  status: number,
  text: string,
  schema: ZodType<T>,
  invalidDataMessage: string,
): T {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalidApiResponse(status);
  }
  const response = parseApiResponse(body, status);
  if (!response.ok) {
    throw new ApiError(response.error, response.message, status);
  }
  const data = schema.safeParse(response.data);
  if (!data.success) throw new Error(invalidDataMessage);
  return data.data;
}

/** DOMException可来自不同realm，中止身份不依赖Error构造器相等。 */
export function isAbortReason(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

/**
 * 调用 hc 接口并解包响应壳（T1.9 起）：
 * - 成功 → 返回 data 部分；
 * - { ok:false } → 抛 ApiError（code + 服务端中文 message + 壳外附加字段）；
 * - 网络失败 / 响应不符合契约壳 → 抛带中文提示的 Error。
 * 响应壳用共享契约 apiResponseSchema 校验，避免前端手写同一结构。
 */
export async function callApi<T>(
  fn: () => Promise<Response>,
  reuse?: (response: Response) => T | undefined,
): Promise<T> {
  let res: Response;
  try {
    res = await fn();
  } catch (err) {
    // 中止身份保留（T6R.8 复审⑬）：AbortError 原样上抛——调用方（note-sync）
    // 据此区分「会话切换主动中止（丢弃）」与网络错误（退避）；其余失败
    // 归并中文网络文案
    if (isAbortReason(err)) throw err;
    throw new Error(
      "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
    );
  }
  const reused = reuse?.(res);
  if (reused !== undefined) return reused;
  return (await readShell(res)) as T;
}

/** 取统一壳（ok/error/message）之外的附加字段（如 LINT_ERROR 的 _issues） */
function pickExtraFields(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== "ok" && key !== "error" && key !== "message") {
      extra[key] = value;
    }
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/**
 * 非 2xx 响应 → 抛错（口径同 callApi 的错误路径，供文件直出接口复用）：
 * { ok:false } 统一壳 → ApiError（code + 服务端中文 message + 壳外附加字段），
 * 调用方按 code 分支（如 404 INK_NOT_FOUND 降级）；壳解析失败/非壳 → 通用中文 Error。
 */
export async function throwShellError(res: Response): Promise<never> {
  await readShell(res);
  throw invalidApiResponse(res.status, responseDiagnosticsOf(res.headers));
}

async function readShell(res: Response): Promise<unknown> {
  const diagnostics = responseDiagnosticsOf(res.headers);
  let body: unknown;
  try {
    body = await res.json();
  } catch (error) {
    if (isAbortReason(error)) throw error;
    throw invalidApiResponse(res.status, diagnostics);
  }
  const response = parseApiResponse(body, res.status, diagnostics);
  if (!response.ok) {
    throw new ApiError(
      response.error,
      response.message,
      res.status,
      pickExtraFields(body),
      diagnostics,
    );
  }
  return response.data;
}
