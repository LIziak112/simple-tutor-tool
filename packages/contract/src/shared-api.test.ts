import { describe, expect, it } from "vitest";
import {
  sharedErrorCodeSchema,
  sharedFileListSchema,
  sharedFilenameSchema,
  sharedFileSummarySchema,
  sharedImportRequestSchema,
  sharedPreviewRequestSchema,
  sharedPublishDataSchema,
} from "./shared-api.ts";

/**
 * 共享发布 API 契约测试（T2B.7）：列表项/规模防线字段、发布响应、预览与导入
 * 请求体（filename 防路径穿越）、错误码集合。契约是前后端唯一事实来源，
 * 服务端路由测试与前端页面共用同一份定义。
 */

/** 合法共享列表项样例（published 来源） */
const summaryFixture = {
  filename: "练习四-teacher-20260930-120000.md",
  kind: "practice",
  title: "练习四",
  questionCount: 8,
  publisher: "teacher",
  publishedAt: "2026-09-30T04:00:00.000Z",
  source: "published",
  canDelete: true,
};

describe("sharedFilenameSchema（文件名防穿越，D17）", () => {
  it("接受普通文件名（含中文与 .md 扩展名）", () => {
    expect(
      sharedFilenameSchema.safeParse("练习四-teacher-20260930-120000.md")
        .success,
    ).toBe(true);
    expect(sharedFilenameSchema.safeParse("本地讲义.md").success).toBe(true);
  });

  it("拒绝路径穿越与非法形状：../、绝对路径、反斜杠、空名、. 与 ..", () => {
    for (const bad of [
      "../secret.md",
      "..",
      ".",
      "a/b.md",
      "a\\b.md",
      "",
      "x\u0000y.md",
    ] as const) {
      expect(sharedFilenameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("sharedFileSummarySchema（列表项）", () => {
  it("接受完整摘要；本地文件 publisher 为 null、来源 local", () => {
    expect(sharedFileSummarySchema.safeParse(summaryFixture).success).toBe(
      true,
    );
    expect(
      sharedFileSummarySchema.safeParse({
        ...summaryFixture,
        publisher: null,
        source: "local",
        canDelete: false,
      }).success,
    ).toBe(true);
  });

  it("拒绝缺失字段 / 非法 kind 与 source / 非法发布者登录名", () => {
    const { canDelete: _drop, ...withoutCanDelete } = summaryFixture;
    expect(sharedFileSummarySchema.safeParse(withoutCanDelete).success).toBe(
      false,
    );
    expect(
      sharedFileSummarySchema.safeParse({ ...summaryFixture, kind: "quiz" })
        .success,
    ).toBe(false);
    expect(
      sharedFileSummarySchema.safeParse({ ...summaryFixture, source: "usb" })
        .success,
    ).toBe(false);
    expect(
      sharedFileSummarySchema.safeParse({ ...summaryFixture, publisher: "a/b" })
        .success,
    ).toBe(false);
  });

  it("多余字段被剥离（不出现 meta 的 teacherId 等内部信息）", () => {
    const parsed = sharedFileSummarySchema.safeParse({
      ...summaryFixture,
      teacherId: "teacher-internal-id",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && "teacherId" in parsed.data).toBe(false);
  });
});

describe("sharedFileListSchema（规模防线字段，D15）", () => {
  it("接受 files + truncated + oversizeHidden", () => {
    expect(
      sharedFileListSchema.safeParse({
        files: [summaryFixture],
        truncated: false,
        oversizeHidden: 0,
      }).success,
    ).toBe(true);
  });

  it("拒绝缺失 truncated / oversizeHidden", () => {
    expect(
      sharedFileListSchema.safeParse({ files: [], truncated: false }).success,
    ).toBe(false);
  });
});

describe("发布 / 预览 / 导入请求响应", () => {
  it("sharedPublishDataSchema：只含实际写入文件名", () => {
    expect(
      sharedPublishDataSchema.safeParse({ filename: "a-2.md" }).success,
    ).toBe(true);
    expect(sharedPublishDataSchema.safeParse({}).success).toBe(false);
  });

  it("sharedPreviewRequestSchema / sharedImportRequestSchema：folderId 可选可空", () => {
    expect(
      sharedPreviewRequestSchema.safeParse({ filename: "a.md" }).success,
    ).toBe(true);
    expect(
      sharedPreviewRequestSchema.safeParse({ filename: "a.md", folderId: null })
        .success,
    ).toBe(true);
    expect(
      sharedPreviewRequestSchema.safeParse({
        filename: "a.md",
        folderId: "0199aaaa-1111-4222-8333-444455556666",
      }).success,
    ).toBe(true);
    expect(
      sharedImportRequestSchema.safeParse({ filename: "../a.md" }).success,
    ).toBe(false);
  });
});

describe("sharedErrorCodeSchema", () => {
  it("只收录共享专属错误码", () => {
    expect(sharedErrorCodeSchema.options).toEqual([
      "SHARED_FILE_NOT_FOUND",
      "FORBIDDEN_SHARED_FILE",
    ]);
  });
});
