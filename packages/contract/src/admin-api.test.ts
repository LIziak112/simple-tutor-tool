import { describe, expect, it } from "vitest";
import {
  adminErrorCodeSchema,
  adminOverviewDataSchema,
  adminSettingsUpdateRequestSchema,
  adminTeacherCreateRequestSchema,
  adminTeacherListQuerySchema,
  adminTeacherResetPasswordRequestSchema,
  adminTeacherSummarySchema,
  adminTeacherUpdateRequestSchema,
} from "./admin-api.ts";

/**
 * 管理端 API 契约测试（T2B.6）：教师摘要 / 创建 / 更新 / 重置密码 / 注册开关 /
 * 概览计数 / 错误码集合。契约是前后端唯一事实来源，响应形状在这里钉死，
 * 服务端路由测试与前端页面共用同一份定义。
 */

/** 合法教师摘要样例（disabledAt=null = 未禁用） */
const summaryFixture = {
  id: "0199aaaa-1111-4222-8333-444455556666",
  loginName: "teacher",
  isAdmin: true,
  disabledAt: null,
  createdAt: "2026-09-30T00:00:00.000Z",
  studentCount: 3,
};

describe("adminTeacherSummarySchema（教师摘要）", () => {
  it("接受完整摘要；disabledAt 可空（禁用语义 D5）", () => {
    expect(adminTeacherSummarySchema.safeParse(summaryFixture).success).toBe(
      true,
    );
    expect(
      adminTeacherSummarySchema.safeParse({
        ...summaryFixture,
        disabledAt: "2026-09-30T01:00:00.000Z",
        isAdmin: false,
      }).success,
    ).toBe(true);
  });

  it("拒绝缺失字段 / 非法登录名 / 负数学生数", () => {
    const { studentCount: _drop, ...withoutCount } = summaryFixture;
    expect(adminTeacherSummarySchema.safeParse(withoutCount).success).toBe(
      false,
    );
    expect(
      adminTeacherSummarySchema.safeParse({
        ...summaryFixture,
        loginName: "a/b",
      }).success,
    ).toBe(false);
    expect(
      adminTeacherSummarySchema.safeParse({
        ...summaryFixture,
        studentCount: -1,
      }).success,
    ).toBe(false);
  });

  it("不出现任何内部凭证字段（passwordHash 等绝不返回）", () => {
    const parsed = adminTeacherSummarySchema.safeParse({
      ...summaryFixture,
      passwordHash: "scrypt$xxx",
    });
    expect(parsed.success).toBe(true);
    // 多余字段被剥离（strip 语义）
    expect(parsed.success && "passwordHash" in parsed.data).toBe(false);
  });
});

describe("请求体与查询参数", () => {
  it("创建请求：password 可选（缺省由服务端生成 12 位随机密码）", () => {
    expect(
      adminTeacherCreateRequestSchema.safeParse({
        loginName: "李老师",
        password: "admin-given-8",
      }).success,
    ).toBe(true);
    expect(
      adminTeacherCreateRequestSchema.safeParse({ loginName: "李老师" })
        .success,
    ).toBe(true);
    expect(
      adminTeacherCreateRequestSchema.safeParse({
        loginName: "李老师",
        password: "short",
      }).success,
    ).toBe(false);
  });

  it("更新请求：loginName 与 isAdmin 均可选（缺省 = 不改）", () => {
    expect(adminTeacherUpdateRequestSchema.safeParse({}).success).toBe(true);
    expect(
      adminTeacherUpdateRequestSchema.safeParse({ isAdmin: true }).success,
    ).toBe(true);
    expect(
      adminTeacherUpdateRequestSchema.safeParse({ loginName: "新名字" })
        .success,
    ).toBe(true);
    expect(
      adminTeacherUpdateRequestSchema.safeParse({
        loginName: "新名字",
        isAdmin: false,
      }).success,
    ).toBe(true);
    expect(
      adminTeacherUpdateRequestSchema.safeParse({ isAdmin: "yes" }).success,
    ).toBe(false);
  });

  it("重置密码请求：password 可选（缺省由服务端生成）", () => {
    expect(
      adminTeacherResetPasswordRequestSchema.safeParse({
        password: "new-pass-123",
      }).success,
    ).toBe(true);
    expect(adminTeacherResetPasswordRequestSchema.safeParse({}).success).toBe(
      true,
    );
    expect(
      adminTeacherResetPasswordRequestSchema.safeParse({ password: "short" })
        .success,
    ).toBe(false);
  });

  it("列表查询：status 默认 all，只接受 all/active/disabled", () => {
    const parsed = adminTeacherListQuerySchema.safeParse({});
    expect(parsed.success && parsed.data.status).toBe("all");
    for (const status of ["all", "active", "disabled"] as const) {
      expect(adminTeacherListQuerySchema.safeParse({ status }).success).toBe(
        true,
      );
    }
    expect(
      adminTeacherListQuerySchema.safeParse({ status: "other" }).success,
    ).toBe(false);
  });

  it("注册开关更新请求：allowRegistration 必填布尔", () => {
    expect(
      adminSettingsUpdateRequestSchema.safeParse({ allowRegistration: false })
        .success,
    ).toBe(true);
    expect(
      adminSettingsUpdateRequestSchema.safeParse({ allowRegistration: "false" })
        .success,
    ).toBe(false);
    expect(adminSettingsUpdateRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("概览计数（D20：只返回聚合计数，无明细）", () => {
  it("接受六个计数/布尔字段；缺一不可", () => {
    const fixture = {
      teacherCount: 2,
      activeTeacherCount: 1,
      studentCount: 10,
      attemptCount: 42,
      sharedFileCount: 0,
      registrationOpen: true,
    };
    expect(adminOverviewDataSchema.safeParse(fixture).success).toBe(true);
    for (const key of Object.keys(fixture) as (keyof typeof fixture)[]) {
      const { [key]: _drop, ...rest } = fixture;
      expect(adminOverviewDataSchema.safeParse(rest).success, key).toBe(false);
    }
  });
});

describe("管理端错误码", () => {
  it("固定集合：仅 TEACHER_NOT_FOUND（鉴权/冲突类在 auth 模块定义）", () => {
    expect(adminErrorCodeSchema.safeParse("TEACHER_NOT_FOUND").success).toBe(
      true,
    );
    expect(adminErrorCodeSchema.safeParse("LAST_ADMIN").success).toBe(false);
    expect(adminErrorCodeSchema.safeParse("ADMIN_ONLY").success).toBe(false);
  });
});
