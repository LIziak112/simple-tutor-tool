import { describe, expect, it } from "vitest";
import {
  studentCreateRequestSchema,
  studentListQuerySchema,
  studentLoginRequestSchema,
  studentMeDataSchema,
  studentPasswordChangeRequestSchema,
  studentUpdateRequestSchema,
} from "./student.ts";

/**
 * 学生契约自测（T2.1）：锁定关键字段策略与查询参数解析，
 * 防止后续调整契约时无声放宽（前后端共用这一份，改坏即红）。
 */

describe("studentCreateRequestSchema", () => {
  it("接受中文姓名/登录名与可选密码、备注", () => {
    const parsed = studentCreateRequestSchema.parse({
      displayName: "张三",
      loginName: "张三",
    });
    expect(parsed.displayName).toBe("张三");
    expect(parsed.password).toBeUndefined();
  });

  it("姓名 trim 后为空 / 登录名超长 / 密码过短均拒绝", () => {
    expect(
      studentCreateRequestSchema.safeParse({
        displayName: "  ",
        loginName: "张三",
      }).success,
    ).toBe(false);
    expect(
      studentCreateRequestSchema.safeParse({
        displayName: "张三",
        loginName: "x".repeat(33),
      }).success,
    ).toBe(false);
    expect(
      studentCreateRequestSchema.safeParse({
        displayName: "张三",
        loginName: "张三",
        password: "12345",
      }).success,
    ).toBe(false);
  });
});

describe("studentUpdateRequestSchema", () => {
  it("空对象合法（全部字段缺省 = 不改）；archived 布尔可选", () => {
    expect(studentUpdateRequestSchema.safeParse({}).success).toBe(true);
    expect(
      studentUpdateRequestSchema.safeParse({ archived: true }).success,
    ).toBe(true);
    expect(
      studentUpdateRequestSchema.safeParse({ archived: "true" }).success,
    ).toBe(false);
  });
});

describe("studentListQuerySchema", () => {
  it("includeArchived 接受 undefined / true / false，拒绝其他字符串", () => {
    expect(studentListQuerySchema.parse({})).toEqual({});
    expect(
      studentListQuerySchema.parse({ includeArchived: "true" }),
    ).toEqual({ includeArchived: true });
    expect(
      studentListQuerySchema.parse({ includeArchived: "false" }),
    ).toEqual({ includeArchived: false });
    expect(
      studentListQuerySchema.safeParse({ includeArchived: "yes!" }).success,
    ).toBe(false);
  });
});

describe("studentLoginRequestSchema / studentPasswordChangeRequestSchema", () => {
  it("登录：登录名与密码非空（密码不校验强度，只挡空串）", () => {
    expect(
      studentLoginRequestSchema.safeParse({
        loginName: "张三",
        password: "123",
      }).success,
    ).toBe(true);
    expect(
      studentLoginRequestSchema.safeParse({ loginName: " ", password: "1" })
        .success,
    ).toBe(false);
  });

  it("自助改密：新密码走完整策略（≥6 位），原密码只要求非空", () => {
    expect(
      studentPasswordChangeRequestSchema.safeParse({
        oldPassword: "123",
        newPassword: "abc123",
      }).success,
    ).toBe(true);
    expect(
      studentPasswordChangeRequestSchema.safeParse({
        oldPassword: "123",
        newPassword: "abc",
      }).success,
    ).toBe(false);
  });
});

describe("studentMeDataSchema（学生端无泄露约束）", () => {
  it("不含 linkToken / passwordHash / note 字段", () => {
    const keys = Object.keys(studentMeDataSchema.shape);
    expect(keys).toEqual(
      expect.arrayContaining(["id", "displayName", "loginName"]),
    );
    expect(keys).not.toContain("linkToken");
    expect(keys).not.toContain("passwordHash");
    expect(keys).not.toContain("note");
  });
});
