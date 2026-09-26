import { describe, expect, it } from "vitest";
import {
  contentTreeOkSchema,
  contentTreeSchema,
  importCommitDataSchema,
  importCommitOkSchema,
  importCommitRequestSchema,
  importLintErrorBodySchema,
  importPreviewDataSchema,
  importPreviewOkSchema,
  importPreviewRequestSchema,
  studentLectureDetailOkSchema,
  studentLectureDetailSchema,
  studentLectureListOkSchema,
  studentLectureSummarySchema,
} from "./content-api.ts";

/**
 * 内容导入 API 契约测试（T1.10）：请求体校验（markdown/filename 非空、courseId 可选 UUID）、
 * preview/commit 响应 data 形态、LINT_ERROR 错误壳（统一壳 + _issues 附加字段）。
 * T1.11 追加：GET /api/teacher/content 内容树契约（树状结构、讲义无题目摘要、单元展开题目）。
 * T2.3 追加：学生端讲义摘要/列表/详情契约（topic 可空、markdown 非空）。
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

describe("contentTreeSchema / contentTreeOkSchema（T1.11 内容树）", () => {
  const tree = {
    courses: [
      {
        id: "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
        title: "默认课程",
        lectures: [
          {
            id: "e70cb1f8-98a4-4f6a-8a5e-2b64e64b28b4",
            title: "第1讲 有理数",
            updatedAt: "2026-09-26T00:00:00.000Z",
          },
        ],
        units: [
          {
            id: "练习四",
            title: "练习四",
            topic: "有理数加减混合",
            updatedAt: "2026-09-26T00:00:00.000Z",
            questions: [
              {
                id: "练习四-1",
                type: "fill",
                difficulty: 2,
                knowledge: ["有理数加法"],
                version: 1,
              },
            ],
          },
        ],
      },
    ],
  };

  // 夹具各节点（noUncheckedIndexedAccess：取下标后收窄再使用）
  const course = tree.courses[0];
  if (course === undefined) throw new Error("测试夹具缺失课程节点");
  const lecture = course.lectures[0];
  if (lecture === undefined) throw new Error("测试夹具缺失讲义节点");
  const unit = course.units[0];
  if (unit === undefined) throw new Error("测试夹具缺失单元节点");
  const question = unit.questions[0];
  if (question === undefined) throw new Error("测试夹具缺失题目节点");

  it("课程 → 讲义/单元 → 题目摘要的树状结构通过", () => {
    expect(contentTreeSchema.safeParse(tree).success).toBe(true);
    expect(
      contentTreeOkSchema.safeParse({ ok: true, data: tree }).success,
    ).toBe(true);
  });

  it("空树（未导入任何内容）通过", () => {
    expect(contentTreeSchema.safeParse({ courses: [] }).success).toBe(true);
  });

  it("单元 topic 可为 null（未标注主题）", () => {
    const r = contentTreeSchema.safeParse({
      courses: [{ ...course, units: [{ ...unit, topic: null }] }],
    });
    expect(r.success).toBe(true);
  });

  it("题目摘要缺字段 / 题型非法 / version 非正整数被拒", () => {
    // 缺 id/type/difficulty/knowledge/version
    expect(
      contentTreeSchema.safeParse({
        courses: [{ ...course, units: [{ ...unit, questions: [{}] }] }],
      }).success,
    ).toBe(false);
    expect(
      contentTreeSchema.safeParse({
        courses: [
          {
            ...course,
            units: [{ ...unit, questions: [{ ...question, type: "essay" }] }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      contentTreeSchema.safeParse({
        courses: [
          {
            ...course,
            units: [{ ...unit, questions: [{ ...question, version: 0 }] }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("讲义节点不接受题目数组（讲义无题目摘要，多余字段被剥除）", () => {
    const r = contentTreeSchema.safeParse({
      courses: [
        { ...course, lectures: [{ ...lecture, questions: [{ id: "q1" }] }] },
      ],
    });
    // 未知字段按 Zod 默认剥除：讲义下的 questions 不进入解析结果
    expect(r.success).toBe(true);
    if (r.success) {
      const parsedLecture = r.data.courses[0]?.lectures[0];
      expect(
        (parsedLecture as Record<string, unknown> | undefined)?.questions,
      ).toBeUndefined();
    }
  });
});

describe("学生端讲义契约（T2.3）", () => {
  const summary = {
    id: "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
    title: "第1讲 有理数",
    topic: "有理数",
    updatedAt: "2026-09-20T10:00:00.000Z",
  } as const;

  it("讲义摘要：topic 可为 null（无关联单元/未标注主题）", () => {
    expect(
      studentLectureSummarySchema.safeParse({ ...summary, topic: null })
        .success,
    ).toBe(true);
  });

  it("讲义摘要：id 非 UUID、缺 updatedAt 被拒", () => {
    expect(
      studentLectureSummarySchema.safeParse({ ...summary, id: "not-uuid" })
        .success,
    ).toBe(false);
    expect(
      studentLectureSummarySchema.safeParse({
        id: summary.id,
        title: summary.title,
        topic: null,
      }).success,
    ).toBe(false);
  });

  it("讲义列表与详情成功壳：ok=true + data 形态", () => {
    expect(
      studentLectureListOkSchema.safeParse({
        ok: true,
        data: { lectures: [summary] },
      }).success,
    ).toBe(true);
    expect(
      studentLectureDetailOkSchema.safeParse({
        ok: true,
        data: {
          id: summary.id,
          title: summary.title,
          markdown: "# 第1讲 有理数\n\n## 一、正数与负数\n",
          updatedAt: summary.updatedAt,
        },
      }).success,
    ).toBe(true);
    // 空列表合法（未导入任何讲义）
    expect(
      studentLectureListOkSchema.safeParse({
        ok: true,
        data: { lectures: [] },
      }).success,
    ).toBe(true);
  });

  it("讲义详情：markdown 为空串被拒（讲义必有 H1 标题行）", () => {
    expect(
      studentLectureDetailSchema.safeParse({
        id: summary.id,
        title: summary.title,
        markdown: "",
        updatedAt: summary.updatedAt,
      }).success,
    ).toBe(false);
  });
});
