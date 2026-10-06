import { expect } from "vitest";
import { HttpError } from "../lib/http-error.ts";

/**
 * 服务层测试的 HttpError 断言共享件（复审⑪/⑫提升；此前 answer-release
 * 与 student-course-service 各持一份私有副本）。
 *
 * 断言形态（asserts 收窄）：err 必须是 HttpError 且 status/code 精确相等；
 * 传 extra 时对 HttpError.extra 做 toMatchObject（部分匹配——供 409 附带
 * _current 摘要等结构化字段的锁定）。
 */
export function expectHttpError(
  err: unknown,
  status: number,
  code: string,
  extra?: Record<string, unknown>,
): asserts err is HttpError {
  if (!(err instanceof HttpError)) {
    throw new Error(`期望 HttpError，实际是 ${String(err)}`);
  }
  expect(err.status).toBe(status);
  expect(err.code).toBe(code);
  if (extra !== undefined) {
    expect(err.extra).toMatchObject(extra);
  }
}
