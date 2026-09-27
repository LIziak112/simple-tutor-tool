import { describe, expect, it } from "vitest";
import {
  lectureMetaUpdateSchema,
  libraryBatchRequestSchema,
  libraryFolderReorderSchema,
  libraryListQuerySchema,
  libraryUnitSummarySchema,
  libraryUsageSchema,
  unitMetaUpdateSchema,
} from "./library-api.ts";

/**
 * 资源库 API 契约测试（T2A.2）：
 * - 列表查询参数（folderId "none"/UUID、deleted 枚举）；
 * - 单元/讲义元数据更新（可空字段显式 null = 清空；缺省 = 不改）；
 * - 使用情况、批量操作（ids 非空去重、action×附加参数组合）、文件夹排序请求。
 */

const UUID = "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b";

describe("libraryListQuerySchema", () => {
  it("全部参数可缺省；folderId 接受 none 与 UUID；deleted 只接受 0/1", () => {
    expect(libraryListQuerySchema.safeParse({}).success).toBe(true);
    expect(
      libraryListQuerySchema.safeParse({
        folderId: "none",
        q: "有理数",
        deleted: "1",
      }).success,
    ).toBe(true);
    expect(libraryListQuerySchema.safeParse({ folderId: UUID }).success).toBe(
      true,
    );
    expect(libraryListQuerySchema.safeParse({ deleted: "2" }).success).toBe(
      false,
    );
  });
});

describe("unitMetaUpdateSchema", () => {
  it("字段缺省 = 不改；显式 null = 清空（topic/folderId/lectureId）", () => {
    expect(unitMetaUpdateSchema.safeParse({}).success).toBe(true);
    expect(
      unitMetaUpdateSchema.safeParse({
        title: "新标题",
        topic: null,
        folderId: null,
        lectureId: null,
      }).success,
    ).toBe(true);
    expect(
      unitMetaUpdateSchema.safeParse({
        title: "新标题",
        topic: "有理数",
        folderId: UUID,
        lectureId: UUID,
      }).success,
    ).toBe(true);
  });

  it("空标题被拒（中文 message）；folderId 非 UUID 被拒", () => {
    expect(unitMetaUpdateSchema.safeParse({ title: "  " }).success).toBe(false);
    expect(unitMetaUpdateSchema.safeParse({ folderId: "练习四" }).success).toBe(
      false,
    );
  });
});

describe("lectureMetaUpdateSchema", () => {
  it("folderId 可空（移入未归类）；缺省 = 不改", () => {
    expect(lectureMetaUpdateSchema.safeParse({}).success).toBe(true);
    expect(lectureMetaUpdateSchema.safeParse({ folderId: null }).success).toBe(
      true,
    );
    expect(lectureMetaUpdateSchema.safeParse({ folderId: UUID }).success).toBe(
      true,
    );
  });
});

describe("libraryUsageSchema", () => {
  it("接受 {courses, assignments, attemptCount}（dueAt 可空）", () => {
    expect(
      libraryUsageSchema.safeParse({
        courses: [{ id: UUID, name: "初一上", visible: true }],
        assignments: [{ id: UUID, title: "周末练习", dueAt: null }],
        attemptCount: 2,
      }).success,
    ).toBe(true);
    expect(libraryUsageSchema.safeParse({ courses: [] }).success).toBe(false);
  });
});

describe("libraryBatchRequestSchema", () => {
  it("move/delete/restore/addToCourse 均要求非空 ids", () => {
    for (const action of [
      "move",
      "delete",
      "restore",
      "addToCourse",
    ] as const) {
      expect(
        libraryBatchRequestSchema.safeParse({ action, kind: "unit", ids: [] })
          .success,
      ).toBe(false);
      expect(
        libraryBatchRequestSchema.safeParse({
          action,
          kind: "lecture",
          ids: ["练习四"],
        }).success,
      ).toBe(true);
    }
  });

  it("move 可携带 folderId（null = 未归类）；addToCourse 可携带 courseId 与 visible", () => {
    expect(
      libraryBatchRequestSchema.safeParse({
        action: "move",
        kind: "unit",
        ids: ["练习四"],
        folderId: null,
      }).success,
    ).toBe(true);
    expect(
      libraryBatchRequestSchema.safeParse({
        action: "addToCourse",
        kind: "unit",
        ids: ["练习四"],
        courseId: UUID,
        visible: false,
      }).success,
    ).toBe(true);
  });
});

describe("libraryFolderReorderSchema", () => {
  it("ids 非空且不能有重复", () => {
    expect(libraryFolderReorderSchema.safeParse({ ids: [] }).success).toBe(
      false,
    );
    expect(
      libraryFolderReorderSchema.safeParse({ ids: [UUID, UUID] }).success,
    ).toBe(false);
    expect(libraryFolderReorderSchema.safeParse({ ids: [UUID] }).success).toBe(
      true,
    );
  });
});

describe("libraryUnitSummarySchema", () => {
  it("接受含题型分布 / 考点汇总 / 引用数 / 题目摘要的完整形状", () => {
    expect(
      libraryUnitSummarySchema.safeParse({
        id: "练习四",
        title: "练习四",
        topic: "有理数加减混合",
        folderId: UUID,
        lectureId: null,
        lectureTitle: null,
        updatedAt: "2026-09-26T00:00:00.000Z",
        deletedAt: null,
        questionCount: 8,
        typeDistribution: { judge: 1, choice: 1 },
        knowledge: ["相反数"],
        courseCount: 1,
        assignmentCount: 0,
        questions: [
          {
            id: "练习四-1",
            type: "judge",
            difficulty: 1,
            knowledge: ["有理数的概念"],
            version: 1,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("缺 questionCount 被拒（列表必须带题数，§4-3）", () => {
    expect(
      libraryUnitSummarySchema.safeParse({
        id: "练习四",
        title: "练习四",
        topic: null,
        folderId: null,
        lectureId: null,
        lectureTitle: null,
        updatedAt: "2026-09-26T00:00:00.000Z",
        deletedAt: null,
        typeDistribution: {},
        knowledge: [],
        courseCount: 0,
        assignmentCount: 0,
        questions: [],
      }).success,
    ).toBe(false);
  });
});
