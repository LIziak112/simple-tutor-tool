import { describe, expect, it } from "vitest";
import { apiErrSchema, apiOkSchema, apiResponseSchema } from "./index";

describe("@tutor/contract：API 响应壳（占位示例，正式契约在 T1.1 定义）", () => {
  it("成功响应 { ok: true, data } 能解析且 data 原样保留", () => {
    const input = { ok: true, data: { time: "2026-09-26T08:00:00.000Z" } };
    expect(apiOkSchema.parse(input)).toEqual(input);
  });

  it("失败响应要求 UPPER_SNAKE_CODE 错误码与非空说明", () => {
    const parsed = apiErrSchema.parse({
      ok: false,
      error: "NOT_FOUND",
      message: "资源不存在",
    });
    expect(parsed.error).toBe("NOT_FOUND");
    // 小写错误码应被拒绝
    expect(
      apiErrSchema.safeParse({ ok: false, error: "oops", message: "不合法" })
        .success,
    ).toBe(false);
  });

  it("联合响应壳按 ok 字段区分成功/失败，负载缺失时解析失败", () => {
    const ok = apiResponseSchema.parse({ ok: true, data: null });
    expect(ok.ok).toBe(true);
    const err = apiResponseSchema.parse({
      ok: false,
      error: "BAD_REQUEST",
      message: "参数错误",
    });
    expect(err.ok).toBe(false);
    // ok: false 但缺少 error/message，应解析失败
    expect(apiResponseSchema.safeParse({ ok: false }).success).toBe(false);
  });
});
