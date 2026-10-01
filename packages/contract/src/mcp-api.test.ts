import { describe, expect, it } from "vitest";
import {
  reportCreateDataSchema,
  reportCreateRequestSchema,
  reportListDataSchema,
  reportSummarySchema,
  teacherApiTokenDataSchema,
  teacherApiTokenResetDataSchema,
} from "./mcp-api.ts";

/**
 * MCP 教师侧契约测试（T4.6）：apiToken 查看/重置响应壳与 reports 数据形态。
 * MCP /mcp 端点为 SDK 协议格式（无统一壳契约），此处只覆盖教师 HTTP 侧。
 */

describe("teacherApiTokenDataSchema", () => {
  it("接受未生成的 null 与已生成的 token 字符串", () => {
    expect(teacherApiTokenDataSchema.parse({ token: null })).toEqual({
      token: null,
    });
    expect(
      teacherApiTokenDataSchema.parse({ token: "abc123_-XYZ" }),
    ).toEqual({ token: "abc123_-XYZ" });
  });

  it("拒绝空字符串（未生成必须显式 null）", () => {
    expect(teacherApiTokenDataSchema.safeParse({ token: "" }).success).toBe(
      false,
    );
  });
});

describe("teacherApiTokenResetDataSchema", () => {
  it("接受新 token 字符串", () => {
    expect(teacherApiTokenResetDataSchema.parse({ token: "new-token" })).toEqual(
      { token: "new-token" },
    );
  });
});

describe("reportCreateRequestSchema", () => {
  it("接受合法写入参数并 trim 标题", () => {
    expect(
      reportCreateRequestSchema.parse({
        studentId: "01234567-89ab-4cde-8f01-234567890abc",
        title: "  小明两周学情诊断  ",
        markdown: "# 报告\n内容",
      }),
    ).toEqual({
      studentId: "01234567-89ab-4cde-8f01-234567890abc",
      title: "小明两周学情诊断",
      markdown: "# 报告\n内容",
    });
  });

  it("拒绝非 UUID 学生、空标题与空正文", () => {
    const base = {
      studentId: "not-a-uuid",
      title: "",
      markdown: "",
    };
    expect(reportCreateRequestSchema.safeParse(base).success).toBe(false);
    expect(
      reportCreateRequestSchema.safeParse({
        ...base,
        studentId: "01234567-89ab-4cde-8f01-234567890abc",
      }).success,
    ).toBe(false);
  });
});

describe("reportSummarySchema / reportListDataSchema", () => {
  it("列表行含 id/studentId/title/source/createdAt，source 限 mcp|manual", () => {
    const row = {
      id: "01234567-89ab-4cde-8f01-234567890abc",
      studentId: "01234567-89ab-4cde-8f01-234567890abd",
      title: "诊断报告",
      source: "mcp",
      createdAt: "2026-10-02T00:00:00.000Z",
    };
    expect(reportSummarySchema.parse(row)).toEqual(row);
    expect(
      reportSummarySchema.safeParse({ ...row, source: "other" }).success,
    ).toBe(false);
    expect(reportListDataSchema.parse({ reports: [row] })).toEqual({
      reports: [row],
    });
  });
});

describe("reportCreateDataSchema", () => {
  it("回执不含 markdown 正文（列表口径一致）", () => {
    const data = reportCreateDataSchema.parse({
      id: "01234567-89ab-4cde-8f01-234567890abc",
      studentId: "01234567-89ab-4cde-8f01-234567890abd",
      title: "诊断报告",
      source: "mcp",
      createdAt: "2026-10-02T00:00:00.000Z",
    });
    expect(data.source).toBe("mcp");
    expect("markdown" in data).toBe(false);
  });
});
