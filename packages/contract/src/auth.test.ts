import { describe, expect, it } from "vitest";
import {
  authErrorCodeSchema,
  teacherInfoOkSchema,
  teacherLoginNameSchema,
  teacherLoginRequestSchema,
  teacherPasswordSchema,
  teacherSetupRequestSchema,
  teacherStatusOkSchema,
} from "./auth.ts";
import { apiErrSchema } from "./index.ts";

/**
 * 身份认证契约测试（T1.9；T2B.2 起覆盖教师登录名规则 D2 与新错误码）：
 * 密码策略、登录名策略、setup/login 请求体、status 与教师信息响应壳、auth 错误码集合。
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

describe("teacherLoginNameSchema（登录名规则，D2）", () => {
  it("接受中文、字母、数字、下划线、连字符（长度 2–32）", () => {
    expect(teacherLoginNameSchema.safeParse("teacher").success).toBe(true);
    expect(teacherLoginNameSchema.safeParse("张老师").success).toBe(true);
    expect(teacherLoginNameSchema.safeParse("Teacher_01").success).toBe(true);
    expect(teacherLoginNameSchema.safeParse("li-ming").success).toBe(true);
    // 长度上界恰好 32（中文同样按 32 个字符计）
    expect(teacherLoginNameSchema.safeParse("a".repeat(32)).success).toBe(true);
    expect(teacherLoginNameSchema.safeParse("王".repeat(32)).success).toBe(
      true,
    );
  });

  it('拒绝空白与文件路径非法字符 \\ / : * ? " < > |（登录名会进共享文件名）', () => {
    const invalid = [
      "张 三", // 半角空格
      "张　三", // 全角空格
      "a\tb",
      "a\nb",
      "a/b",
      "a\\b",
      "a:b",
      "a*b",
      "a?b",
      'a"b',
      "a<b",
      "a>b",
      "a|b",
      "teacher#1", // 其他符号也不允许（白名单口径）
      "teacher@甲",
    ];
    for (const name of invalid) {
      const parsed = teacherLoginNameSchema.safeParse(name);
      expect(parsed.success, `应拒绝：${JSON.stringify(name)}`).toBe(false);
      expect(!parsed.success && parsed.error.issues[0]?.message).toBe(
        "登录名只能包含中文、字母、数字、下划线或连字符",
      );
    }
  });

  it("长度边界：1 个字符 / 33 个字符 / 空串拒绝并给中文提示", () => {
    const short = teacherLoginNameSchema.safeParse("a");
    expect(short.success).toBe(false);
    expect(!short.success && short.error.issues[0]?.message).toBe(
      "登录名至少需要 2 个字符",
    );

    expect(teacherLoginNameSchema.safeParse("a".repeat(33)).success).toBe(
      false,
    );
    const tooLong = teacherLoginNameSchema.safeParse("王".repeat(33));
    expect(tooLong.success).toBe(false);
    expect(!tooLong.success && tooLong.error.issues[0]?.message).toBe(
      "登录名最多 32 个字符",
    );
    expect(teacherLoginNameSchema.safeParse("").success).toBe(false);
  });
});

describe("setup / login 请求体", () => {
  it("setup 接受 { loginName, password } 且各自沿用策略", () => {
    expect(
      teacherSetupRequestSchema.safeParse({
        loginName: "teacher",
        password: "correct horse",
      }).success,
    ).toBe(true);
    // 登录名非法 / 密码过短均拒绝
    expect(
      teacherSetupRequestSchema.safeParse({
        loginName: "a b",
        password: "correct horse",
      }).success,
    ).toBe(false);
    expect(
      teacherSetupRequestSchema.safeParse({
        loginName: "teacher",
        password: "short",
      }).success,
    ).toBe(false);
    expect(
      teacherSetupRequestSchema.safeParse({ password: "12345678" }).success,
    ).toBe(false);
    // 多余字段被剥离（strip），不参与校验失败
    const parsed = teacherSetupRequestSchema.safeParse({
      loginName: "teacher",
      password: "12345678",
      extra: "忽略",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({
      loginName: "teacher",
      password: "12345678",
    });
  });

  it("login 要求登录名合法且密码非空（长度策略在登录时不重复强制）", () => {
    expect(
      teacherLoginRequestSchema.safeParse({
        loginName: "teacher",
        password: "x",
      }).success,
    ).toBe(true);
    expect(teacherLoginRequestSchema.safeParse({ password: "x" }).success).toBe(
      false,
    );
    expect(
      teacherLoginRequestSchema.safeParse({ loginName: "teacher" }).success,
    ).toBe(false);
    expect(
      teacherLoginRequestSchema.safeParse({
        loginName: "teacher",
        password: "",
      }).success,
    ).toBe(false);
    expect(
      teacherLoginRequestSchema.safeParse({ loginName: "张 三", password: "x" })
        .success,
    ).toBe(false);
  });
});

describe("响应壳（data 具体化）", () => {
  it("status 响应壳含 hasTeacher 与 registrationOpen 两个布尔", () => {
    expect(
      teacherStatusOkSchema.safeParse({
        ok: true,
        data: { hasTeacher: false, registrationOpen: false },
      }).success,
    ).toBe(true);
    expect(
      teacherStatusOkSchema.safeParse({
        ok: true,
        data: { hasTeacher: "yes", registrationOpen: false },
      }).success,
    ).toBe(false);
    // registrationOpen 缺失不符合契约（T2B.2 起必有，避免契约二次变更）
    expect(
      teacherStatusOkSchema.safeParse({ ok: true, data: { hasTeacher: true } })
        .success,
    ).toBe(false);
  });

  it("教师信息响应壳含 id、loginName、isAdmin 与 createdAt", () => {
    expect(
      teacherInfoOkSchema.safeParse({
        ok: true,
        data: {
          id: "uuid-1",
          loginName: "teacher",
          isAdmin: true,
          createdAt: "2026-09-26T00:00:00.000Z",
        },
      }).success,
    ).toBe(true);
    // 缺 loginName / isAdmin 均不通过
    expect(
      teacherInfoOkSchema.safeParse({
        ok: true,
        data: {
          id: "uuid-1",
          isAdmin: true,
          createdAt: "2026-09-26T00:00:00.000Z",
        },
      }).success,
    ).toBe(false);
    expect(
      teacherInfoOkSchema.safeParse({
        ok: true,
        data: {
          id: "uuid-1",
          loginName: "teacher",
          createdAt: "2026-09-26T00:00:00.000Z",
        },
      }).success,
    ).toBe(false);
  });

  it("auth 错误码全在固定集合内（含 T2B.2 新增与 T2B.6 预留），且兼容通用错误壳", () => {
    for (const code of [
      "TEACHER_EXISTS",
      "INVALID_CREDENTIALS",
      "LOCKED",
      "UNAUTHORIZED",
      "VALIDATION_ERROR",
      "ACCOUNT_DISABLED",
      "ADMIN_ONLY",
      "TEACHER_LOGIN_EXISTS",
      "LAST_ADMIN",
      "REGISTRATION_DISABLED",
      "TEACHER_NOT_EXISTS",
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
