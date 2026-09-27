import { describe, expect, it } from "vitest";
import { courseUpdateRequestSchema } from "./content-api.ts";
import {
  courseDetailDataSchema,
  courseDetailItemSchema,
  courseItemUpdateRequestSchema,
  courseItemsAddRequestSchema,
  courseItemsReorderRequestSchema,
  courseListDataSchema,
  courseListOkSchema,
  courseMembersRequestSchema,
  courseStudentViewDataSchema,
  courseSummarySchema,
} from "./course-api.ts";

/**
 * 课程 API 契约测试（T2A.4）：列表/详情形态（name 口径、状态标签枚举、
 * 可见条目数与成员 id 集合）、批量添加请求（items 非空、withCompanionUnits）、
 * 条目更新（publishAt UTC ISO、显式 null 取消定时）、排序与成员请求的
 * ids 非空且不重复、PATCH 课程 name/title 互斥（兼容旧字段）。
 */

const summary = {
  id: "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
  name: "初一上",
  description: null,
  archived: false,
  archivedAt: null,
  order: 0,
  memberCount: 2,
  itemCount: 5,
  visibleItemCount: 3,
  memberIds: [
    "1b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
    "2b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
  ],
  hasAttempts: false,
  createdAt: "2026-09-01T00:00:00.000Z",
} as const;

const detailItem = {
  id: "3b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
  kind: "lecture",
  refId: "4b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
  title: "第1讲 有理数",
  order: 0,
  visible: true,
  publishAt: null,
  status: "visible",
  questionCount: null,
  resourceUpdatedAt: "2026-09-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
} as const;

describe("courseSummarySchema / courseListDataSchema", () => {
  it("接受完整摘要（name 口径、memberIds 与计数同源）", () => {
    expect(courseSummarySchema.safeParse(summary).success).toBe(true);
    expect(
      courseListDataSchema.safeParse({ courses: [summary] }).success,
    ).toBe(true);
    expect(courseListOkSchema.safeParse({ ok: true, data: { courses: [] } })
      .success).toBe(true);
  });

  it("memberIds 非数组或 hasAttempts 缺失被拒", () => {
    expect(
      courseSummarySchema.safeParse({ ...summary, memberIds: "x" }).success,
    ).toBe(false);
    expect(
      courseSummarySchema.safeParse({ ...summary, hasAttempts: undefined })
        .success,
    ).toBe(false);
  });
});

describe("courseDetailDataSchema", () => {
  it("接受目录条目 + 成员；状态标签限定五种枚举", () => {
    const data = {
      id: summary.id,
      name: "初一上",
      description: "有理数章节",
      archived: false,
      archivedAt: null,
      order: 0,
      hasAttempts: true,
      items: [
        detailItem,
        {
          ...detailItem,
          id: "5b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
          kind: "section",
          refId: null,
          title: "第一周",
          status: "hidden",
          visible: false,
          resourceUpdatedAt: null,
        },
        {
          ...detailItem,
          id: "6b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
          kind: "unit",
          refId: "u-1",
          title: "练习四",
          status: "no-questions",
          questionCount: 0,
        },
      ],
      members: [
        {
          studentId: summary.memberIds[0],
          displayName: "张三",
          joinedAt: "2026-09-01T00:00:00.000Z",
          archived: false,
        },
      ],
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    expect(courseDetailDataSchema.safeParse(data).success).toBe(true);
    expect(
      courseDetailItemSchema.safeParse({
        ...detailItem,
        status: "unknown",
      }).success,
    ).toBe(false);
  });
});

describe("courseItemsAddRequestSchema", () => {
  it("接受讲义 + 分节混排（visible / withCompanionUnits 可选）", () => {
    expect(
      courseItemsAddRequestSchema.safeParse({
        items: [
          { kind: "lecture", refId: "l-1" },
          { kind: "section", title: "第一周" },
        ],
        visible: false,
        withCompanionUnits: true,
      }).success,
    ).toBe(true);
    expect(courseItemsAddRequestSchema.safeParse({ items: [] }).success).toBe(
      false,
    );
  });
});

describe("courseItemUpdateRequestSchema", () => {
  it("publishAt 接受 UTC ISO 与显式 null（取消定时）；带时区偏移被拒", () => {
    expect(
      courseItemUpdateRequestSchema.safeParse({
        publishAt: "2026-09-30T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      courseItemUpdateRequestSchema.safeParse({ publishAt: null }).success,
    ).toBe(true);
    expect(
      courseItemUpdateRequestSchema.safeParse({
        publishAt: "2026-09-30T08:00:00+08:00",
      }).success,
    ).toBe(false);
  });
});

describe("courseItemsReorderRequestSchema / courseMembersRequestSchema", () => {
  it("ids 非空且不能重复", () => {
    const a = "1b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b";
    const b = "2b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b";
    expect(
      courseItemsReorderRequestSchema.safeParse({ ids: [a, b] }).success,
    ).toBe(true);
    expect(
      courseItemsReorderRequestSchema.safeParse({ ids: [a, a] }).success,
    ).toBe(false);
    expect(courseItemsReorderRequestSchema.safeParse({ ids: [] }).success).toBe(
      false,
    );
    expect(
      courseMembersRequestSchema.safeParse({ studentIds: [a, a] }).success,
    ).toBe(false);
  });

  it("非 UUID 的 refId（单元 id 来自 DSL 允许非 UUID）不受 members 校验影响", () => {
    expect(
      courseMembersRequestSchema.safeParse({ studentIds: ["u-1"] }).success,
    ).toBe(false);
  });
});

describe("courseStudentViewDataSchema", () => {
  it("接受成员可见目录（只含元信息，不含题目内容）", () => {
    expect(
      courseStudentViewDataSchema.safeParse({
        studentId: summary.memberIds[0],
        studentName: "张三",
        courseArchived: false,
        studentArchived: false,
        isMember: true,
        items: [
          {
            id: detailItem.id,
            kind: "lecture",
            refId: detailItem.refId,
            title: "第1讲 有理数",
            order: 0,
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("courseUpdateRequestSchema（content-api，name/title 兼容）", () => {
  it("name 与 title 同义，同时提供被拒", () => {
    expect(courseUpdateRequestSchema.safeParse({ name: "初一上" }).success).toBe(
      true,
    );
    expect(
      courseUpdateRequestSchema.safeParse({ title: "初一上" }).success,
    ).toBe(true);
    expect(
      courseUpdateRequestSchema.safeParse({ name: "a", title: "b" }).success,
    ).toBe(false);
  });

  it("description 显式 null 与 archived 开关被接受", () => {
    expect(
      courseUpdateRequestSchema.safeParse({
        description: null,
        archived: true,
      }).success,
    ).toBe(true);
  });
});
