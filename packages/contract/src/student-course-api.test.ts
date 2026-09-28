import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 学生端课程契约测试（T2A.5）：schema 边界（合法/非法样本）。
 * 行为级验证（D5 过滤、D22 错误矩阵、泄露断言）在
 * apps/server/src/routes/student-courses.test.ts 与
 * apps/server/src/services/student-course-service.test.ts。
 */

// 被测模块（index.ts 已 re-export；这里直接读文件确认模块本身可独立解析）
const source = readFileSync(
  new URL("./student-course-api.ts", import.meta.url),
  "utf8",
);

describe("学生端课程契约（T2A.5）", () => {
  const courseId = "2d8e39ca-8dbc-4a2e-ad9e-9d3d3d3d3d3d";

  it("模块导出齐全（列表/详情/条目/错误码与类型）", () => {
    for (const name of [
      "studentCourseSummarySchema",
      "studentCourseListDataSchema",
      "studentCourseItemSchema",
      "studentCourseDetailDataSchema",
      "studentCourseErrorCodeSchema",
      "studentCourseListOkSchema",
      "studentCourseDetailOkSchema",
    ]) {
      expect(source).toContain(`export const ${name}`);
    }
  });

  it("错误码固定为 D22 两态（403 COURSE_ACCESS_DENIED / 404 NOT_FOUND）", async () => {
    const { studentCourseErrorCodeSchema } = await import(
      "./student-course-api.ts"
    );
    expect(
      studentCourseErrorCodeSchema.safeParse("COURSE_ACCESS_DENIED").success,
    ).toBe(true);
    expect(studentCourseErrorCodeSchema.safeParse("NOT_FOUND").success).toBe(
      true,
    );
    expect(
      studentCourseErrorCodeSchema.safeParse("COURSE_NOT_FOUND").success,
    ).toBe(false);
  });

  it("课程摘要：completedUnitCount 恒 0 占位字段为必填整数", async () => {
    const { studentCourseSummarySchema } = await import(
      "./student-course-api.ts"
    );
    const base = {
      id: courseId,
      name: "初一上",
      description: null,
      visibleLectureCount: 3,
      visibleUnitCount: 5,
      completedUnitCount: 0,
    } as const;
    expect(studentCourseSummarySchema.safeParse(base).success).toBe(true);
    expect(
      studentCourseSummarySchema.safeParse({
        ...base,
        description: "有理数与数轴",
      }).success,
    ).toBe(true);
    // 缺 completedUnitCount / 负数计数 / id 非 UUID 被拒
    const { completedUnitCount: _drop, ...missing } = base;
    expect(studentCourseSummarySchema.safeParse(missing).success).toBe(false);
    expect(
      studentCourseSummarySchema.safeParse({ ...base, visibleUnitCount: -1 })
        .success,
    ).toBe(false);
    expect(
      studentCourseSummarySchema.safeParse({ ...base, id: "not-uuid" }).success,
    ).toBe(false);
  });

  it("目录条目：三种 kind、questionCount 仅单元可带（其余 null）", async () => {
    const { studentCourseItemSchema } = await import("./student-course-api.ts");
    const itemId = "4faf5bef-afde-4c40-8f0a-cf6f6f6f6f6f";
    expect(
      studentCourseItemSchema.safeParse({
        id: itemId,
        kind: "section",
        refId: null,
        title: "第一章",
        order: 0,
        questionCount: null,
        attempt: null,
      }).success,
    ).toBe(true);
    expect(
      studentCourseItemSchema.safeParse({
        id: itemId,
        kind: "lecture",
        refId: "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
        title: "第1讲 有理数",
        order: 1,
        questionCount: null,
        attempt: null,
      }).success,
    ).toBe(true);
    expect(
      studentCourseItemSchema.safeParse({
        id: itemId,
        kind: "unit",
        refId: "有理数小练",
        title: "有理数小练",
        order: 2,
        questionCount: 4,
        attempt: null,
      }).success,
    ).toBe(true);
    // unit 的 refId 来自 DSL（非 UUID 合法）；非法 kind 被拒
    expect(
      studentCourseItemSchema.safeParse({
        id: itemId,
        kind: "folder",
        refId: null,
        title: "x",
        order: 0,
        questionCount: null,
      }).success,
    ).toBe(false);
  });

  it("课程详情成功壳：ok=true + data 形态", async () => {
    const { studentCourseDetailOkSchema } = await import(
      "./student-course-api.ts"
    );
    expect(
      studentCourseDetailOkSchema.safeParse({
        ok: true,
        data: {
          id: courseId,
          name: "初一上",
          description: null,
          items: [],
        },
      }).success,
    ).toBe(true);
    expect(
      studentCourseDetailOkSchema.safeParse({
        ok: true,
        data: { id: courseId, name: "初一上", items: [] },
      }).success,
    ).toBe(false);
  });
});

describe("T2A.6 课程练习：单元条目作答摘要与单元落地页契约", () => {
  const courseId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
  const attemptId = "5fa85f64-5717-4562-b3fc-2c963f66afa6";

  it("单元条目携带作答摘要（D10：次数/首次/最近/最高分/待批）；从未做为 null", async () => {
    const { studentCourseItemSchema } = await import(
      "./student-course-api.ts"
    );
    expect(
      studentCourseItemSchema.safeParse({
        id: "6fa85f64-5717-4562-b3fc-2c963f66afa6",
        kind: "unit",
        refId: "有理数小练",
        title: "有理数小练",
        order: 2,
        questionCount: 4,
        attempt: {
          count: 2,
          submittedCount: 1,
          hasDraft: true,
          firstScore: 60,
          latestScore: 60,
          bestScore: 60,
          pendingCount: 1,
        },
      }).success,
    ).toBe(true);
    // 得分越界 → 拒绝
    expect(
      studentCourseItemSchema.safeParse({
        id: "6fa85f64-5717-4562-b3fc-2c963f66afa6",
        kind: "unit",
        refId: "有理数小练",
        title: "有理数小练",
        order: 2,
        questionCount: 4,
        attempt: {
          count: 1,
          submittedCount: 1,
          hasDraft: false,
          firstScore: 101,
          latestScore: null,
          bestScore: null,
          pendingCount: 0,
        },
      }).success,
    ).toBe(false);
  });

  it("单元落地页：题数/题型分布/历次列表（attemptNo 降序）+ 汇总；成功壳形态", async () => {
    const { studentUnitLandingOkSchema } = await import(
      "./student-course-api.ts"
    );
    const data = {
      courseId,
      courseName: "初一上",
      unitId: "有理数小练",
      title: "有理数小练",
      topic: "正数与负数",
      questionCount: 2,
      typeDistribution: { judge: 1, fill: 1 },
      attempts: [
        {
          attemptId,
          attemptNo: 2,
          status: "draft",
          score: null,
          startedAt: "2026-09-27T06:00:00.000Z",
          submittedAt: null,
        },
        {
          attemptId: "7fa85f64-5717-4562-b3fc-2c963f66afa6",
          attemptNo: 1,
          status: "submitted",
          score: 75,
          startedAt: "2026-09-27T02:00:00.000Z",
          submittedAt: "2026-09-27T02:30:00.000Z",
        },
      ],
      summary: {
        count: 2,
        submittedCount: 1,
        hasDraft: true,
        firstScore: 75,
        latestScore: 75,
        bestScore: 75,
        pendingCount: 0,
      },
    };
    expect(studentUnitLandingOkSchema.safeParse({ ok: true, data }).success).toBe(
      true,
    );
    // summary 为 null（从未做）同样合法；缺 attempts 字段拒绝
    expect(
      studentUnitLandingOkSchema.safeParse({
        ok: true,
        data: { ...data, summary: null, attempts: [] },
      }).success,
    ).toBe(true);
    const { attempts: _omit, ...withoutAttempts } = data;
    expect(
      studentUnitLandingOkSchema.safeParse({
        ok: true,
        data: withoutAttempts,
      }).success,
    ).toBe(false);
  });
});
