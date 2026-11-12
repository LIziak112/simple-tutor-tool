import { apiResponseSchema } from "@tutor/contract";
import type { ZodType } from "zod";

/** 业务错误可按错误码分支处理，extra 携带统一响应壳以外的诊断。 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function invalidApiResponse(status: number): Error {
  return new Error(`服务器响应异常（HTTP ${status}），请稍后重试`);
}

export function parseApiResponse(body: unknown, status: number) {
  const parsed = apiResponseSchema.safeParse(body);
  if (!parsed.success) throw invalidApiResponse(status);
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
