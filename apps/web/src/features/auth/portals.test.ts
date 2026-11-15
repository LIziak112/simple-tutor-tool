import { describe, expect, it } from "vitest";
import {
  PORTALS,
  portalCapabilitiesOf,
  safeReturnTo,
} from "@/portals/registry";

describe("门户注册表与安全回跳", () => {
  it("登记四个门户，管理员复用教师登录", () => {
    expect(Object.keys(PORTALS)).toEqual([
      "student",
      "teacher",
      "personal",
      "admin",
    ]);
    expect(PORTALS.admin.loginPath).toBe("/t/login");
  });

  it.each([
    "https://example.com/s/home",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "//example.com/s/home",
    "/\\example.com",
    "/s/login",
    "/p/register",
    "/t/setup",
    "/t/%6cogin",
    "/unknown",
    "/s/%2f%2fevil",
    "/s/home\n",
  ])("拒绝非法或循环地址 %s", (path) =>
    expect(safeReturnTo(path, "student")).toBe("/s/home"),
  );

  it.each([
    "/t/login",
    "/t/LOGIN",
    "/t/%6Cogin",
    "/t/%4cogin",
    "/t/register",
    "/t/Setup",
  ])("教师回跳排除大小写与编码的认证路由 %s", (path) => {
    expect(safeReturnTo(path, "teacher")).toBe("/t");
  });

  it("保留门户内路径、查询和锚，并拒绝班级账号跨端回跳", () => {
    expect(safeReturnTo("/s/courses/abc?tab=units#q2", "student")).toBe(
      "/s/courses/abc?tab=units#q2",
    );
    expect(safeReturnTo("/s/notebook/q1", "student")).toBe("/s/notebook/q1");
    expect(safeReturnTo("/a/teachers", "teacher")).toBe("/a/teachers");
    expect(safeReturnTo("/t/courses", "student")).toBe("/s/home");
    expect(safeReturnTo("/t/courses", "personal")).toBe("/p/manage/courses");
    expect(safeReturnTo("/s/attempts/a?returnTo=x#q2", "personal")).toBe(
      "/p/learn/attempts/a?returnTo=x#q2",
    );
  });

  it("能力表统一隐藏个人端作业、班级管理、内部登录名", () => {
    expect(portalCapabilitiesOf("teacher", "class").assignments).toBe(true);
    expect(portalCapabilitiesOf("teacher", "personal")).toMatchObject({
      assignments: false,
      members: false,
      teacherAiConnections: false,
      showLoginName: false,
    });
    expect(portalCapabilitiesOf("personal", "class").practice).toBe(false);
    expect(
      portalCapabilitiesOf("admin", "personal").accountAdministration,
    ).toBe(false);
    expect(portalCapabilitiesOf("student", "personal").assignments).toBe(false);
  });
});
