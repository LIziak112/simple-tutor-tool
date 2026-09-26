import { describe, expect, it } from "vitest";
import {
  importCommitDataSchema,
  importCommitOkSchema,
  importCommitRequestSchema,
  importLintErrorBodySchema,
  importPreviewDataSchema,
  importPreviewOkSchema,
  importPreviewRequestSchema,
} from "./content-api.ts";

/**
 * 内容导入 API 契约测试（T1.10）：请求体校验（markdown/filename 非空、courseId 可选 UUID）、
 * preview/commit 响应 data 形态、LINT_ERROR 错误壳（统一壳 + _issues 附加字段）。
 */

const lintIssue = {
  level: "error",
  line: 3,
  column: 1,
  code: "FILL_NO_BLANK",
  message: "填空题题干没有任何 [[…]] 空",
} as const;

describe("importPreviewRequestSchema", () => {
  it("接受 {markdown, filename}；markdown/filename 非空", () => {
    expect(
      importPreviewRequestSchema.safeParse({
        markdown: "# 内容",
        filename: "练习.md",
      }).success,
    ).toBe(true);
  });

  it("markdown 为空串被拒（中文 message）", () => {
    const r = importPreviewRequestSchema.safeParse({
      markdown: "",
      filename: "练习.md",
    });
    expect(r.success).toBe(false);
  });

  it("filename 缺失被拒", () => {
    const r = importPreviewRequestSchema.safeParse({ markdown: "# 内容" });
    expect(r.success).toBe(false);
  });
});

describe("importCommitRequestSchema", () => {
  it("courseId 可选；合法 UUID 通过", () => {
    expect(
      importCommitRequestSchema.safeParse({
        markdown: "# 内容",
        filename: "练习.md",
        courseId: "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
      }).success,
    ).toBe(true);
    expect(
      importCommitRequestSchema.safeParse({
        markdown: "# 内容",
        filename: "练习.md",
      }).success,
    ).toBe(true);
  });

  it("courseId 非 UUID 被拒", () => {
    const r = importCommitRequestSchema.safeParse({
      markdown: "# 内容",
      filename: "练习.md",
      courseId: "练习四",
    });
    expect(r.success).toBe(false);
  });
});

describe("importPreviewDataSchema / importPreviewOkSchema", () => {
  const data = {
    version: 1,
    summary: {
      unitCount: 1,
      lectureCount: 0,
      questionCount: 8,
      typeDistribution: { judge: 1, fill: 2 },
    },
    issues: [],
  };

  it("v1/v2 版本号与摘要形态通过", () => {
    expect(importPreviewDataSchema.safeParse(data).success).toBe(true);
    expect(
      importPreviewDataSchema.safeParse({ ...data, version: 2 }).success,
    ).toBe(true);
  });

  it("版本号只允许 1|2", () => {
    expect(
      importPreviewDataSchema.safeParse({ ...data, version: 3 }).success,
    ).toBe(false);
  });

  it("issues 携带 LintIssue 数组（含 warning 级）", () => {
    expect(
      importPreviewDataSchema.safeParse({
        ...data,
        issues: [lintIssue, { ...lintIssue, level: "warning" }],
      }).success,
    ).toBe(true);
  });

  it("成功响应壳 { ok:true, data }", () => {
    expect(importPreviewOkSchema.safeParse({ ok: true, data }).success).toBe(
      true,
    );
  });
});

describe("importCommitDataSchema / importCommitOkSchema", () => {
  const data = {
    importId: "5b0b7ba4-6c07-4a5e-9df7-3b1e0d0b5c66",
    courseId: "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
    units: [{ id: "练习四", title: "练习四", inserted: true, updated: false }],
    lectures: [
      {
        id: "e70cb1f8-98a4-4f6a-8a5e-2b64e64b28b4",
        title: "第1讲 有理数",
        inserted: true,
        updated: false,
      },
    ],
    questions: { inserted: 8, updated: 0 },
  };

  it("统计报告形态通过", () => {
    expect(importCommitDataSchema.safeParse(data).success).toBe(true);
    expect(importCommitOkSchema.safeParse({ ok: true, data }).success).toBe(
      true,
    );
  });

  it("importId/courseId 必须是 UUID", () => {
    expect(
      importCommitDataSchema.safeParse({ ...data, importId: "abc" }).success,
    ).toBe(false);
    expect(
      importCommitDataSchema.safeParse({ ...data, courseId: "abc" }).success,
    ).toBe(false);
  });

  it("题目统计的 inserted/updated 为非负整数", () => {
    expect(
      importCommitDataSchema.safeParse({
        ...data,
        questions: { inserted: -1, updated: 0 },
      }).success,
    ).toBe(false);
  });
});

describe("importLintErrorBodySchema（commit 遇 error 级 issue 的响应体）", () => {
  it("统一错误壳 + _issues 附加字段通过", () => {
    const body = {
      ok: false,
      error: "LINT_ERROR",
      message: "文档存在 1 个 error 级问题，请先修复后重试",
      _issues: [lintIssue],
    };
    expect(importLintErrorBodySchema.safeParse(body).success).toBe(true);
  });

  it("_issues 缺失或为空被拒（有 error 才会返回该壳）", () => {
    expect(
      importLintErrorBodySchema.safeParse({
        ok: false,
        error: "LINT_ERROR",
        message: "x",
      }).success,
    ).toBe(false);
    expect(
      importLintErrorBodySchema.safeParse({
        ok: false,
        error: "LINT_ERROR",
        message: "x",
        _issues: [],
      }).success,
    ).toBe(false);
  });

  it("error 码不是 LINT_ERROR 被拒", () => {
    expect(
      importLintErrorBodySchema.safeParse({
        ok: false,
        error: "VALIDATION_ERROR",
        message: "x",
        _issues: [lintIssue],
      }).success,
    ).toBe(false);
  });
});
