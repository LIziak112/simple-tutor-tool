import { describe, expect, it } from "vitest";
import {
  authErrorCodeSchema,
  teacherInfoOkSchema,
  teacherLoginRequestSchema,
  teacherPasswordSchema,
  teacherSetupRequestSchema,
  teacherStatusOkSchema,
} from "./auth.ts";
import { apiErrSchema } from "./index.ts";

/**
 * 身份认证契约测试（T1.9）：
 * 密码策略、setup/login 请求体、status 与教师信息响应壳、auth 错误码集合。
 * 契约是前后端唯一事实来源，策略在这里钉死后两端不允许各自放宽。
 */

describe("teacherPasswordSchema（密码策略）", () => {
  it("接受 8 字符及以上的密码", () => {
    expect(teacherPasswordSchema.safeParse("12345678").success).toBe(true);
    expect(
      teacherPasswordSchema.safeParse("a-very-long-password").success,
    ).toBe(true);
  });

  it("拒绝少于 8 字符与超过 128 字符的密码，并给出中文提示", () => {
    const short = teacherPasswordSchema.safeParse("1234567");
    expect(short.success).toBe(false);
    expect(!short.success && short.error.issues[0]?.message).toBe(
      "密码至少需要 8 个字符",
    );

    const tooLong = teacherPasswordSchema.safeParse("x".repeat(129));
    expect(tooLong.success).toBe(false);
  });
});

describe("setup / login 请求体", () => {
  it("setup 接受 { password } 且沿用密码策略", () => {
    expect(
      teacherSetupRequestSchema.safeParse({ password: "correct horse" })
        .success,
    ).toBe(true);
    expect(
      teacherSetupRequestSchema.safeParse({ password: "short" }).success,
    ).toBe(false);
    // 多余字段被剥离（strip），不参与校验失败
    const parsed = teacherSetupRequestSchema.safeParse({
      password: "12345678",
      extra: "忽略",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ password: "12345678" });
  });

  it("login 只要求密码非空（长度策略在登录时不重复强制）", () => {
    expect(teacherLoginRequestSchema.safeParse({ password: "x" }).success).toBe(
      true,
    );
    expect(teacherLoginRequestSchema.safeParse({}).success).toBe(false);
    expect(teacherLoginRequestSchema.safeParse({ password: "" }).success).toBe(
      false,
    );
  });
});

describe("响应壳（data 具体化）", () => {
  it("status 响应壳只含 hasTeacher 布尔", () => {
    expect(
      teacherStatusOkSchema.safeParse({ ok: true, data: { hasTeacher: false } })
        .success,
    ).toBe(true);
    expect(
      teacherStatusOkSchema.safeParse({ ok: true, data: { hasTeacher: "yes" } })
        .success,
    ).toBe(false);
  });

  it("教师信息响应壳含 id 与 createdAt", () => {
    expect(
      teacherInfoOkSchema.safeParse({
        ok: true,
        data: { id: "uuid-1", createdAt: "2026-09-26T00:00:00.000Z" },
      }).success,
    ).toBe(true);
    expect(
      teacherInfoOkSchema.safeParse({ ok: true, data: { id: "uuid-1" } })
        .success,
    ).toBe(false);
  });

  it("auth 错误码全在固定集合内，且兼容通用错误壳", () => {
    for (const code of [
      "TEACHER_EXISTS",
      "INVALID_CREDENTIALS",
      "LOCKED",
      "UNAUTHORIZED",
      "VALIDATION_ERROR",
    ] as const) {
      expect(authErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(
        apiErrSchema.safeParse({ ok: false, error: code, message: "说明" })
          .success,
      ).toBe(true);
    }
    expect(authErrorCodeSchema.safeParse("SOMETHING_ELSE").success).toBe(false);
  });
});
