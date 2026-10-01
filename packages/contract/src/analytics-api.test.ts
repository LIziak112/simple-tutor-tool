import { describe, expect, it } from "vitest";
import {
  analyticsAssignmentCellSchema,
  analyticsErrorCodeSchema,
  analyticsLectureReadingMapSchema,
  analyticsOverviewDataSchema,
  analyticsQuerySchema,
  analyticsQuestionsDataSchema,
  analyticsStudentDataSchema,
  analyticsTrendPointSchema,
  analyticsUnitCellSchema,
} from "./analytics-api.ts";

/**
 * 学情分析契约测试（T4.1）：查询参数（days 数值/「all」/默认值）、矩阵单元格
 * 判别联合、趋势桶 null 对率、画像与题目统计的完整形态。契约是前后端唯一
 * 事实来源，服务层/路由测试共用同一份定义。
 */

const UUID = "0199aaaa-1111-4222-8333-444455556666";

describe("analyticsQuerySchema（D3/D5 查询参数）", () => {
  it("空对象取默认值 days=30、focusDays=14", () => {
    const parsed = analyticsQuerySchema.parse({});
    expect(parsed.days).toBe(30);
    expect(parsed.focusDays).toBe(14);
    expect(parsed.courseId).toBeUndefined();
  });

  it("查询字符串数值被 coerce（「7」→ 7、「14」→ 14）", () => {
    const parsed = analyticsQuerySchema.parse({
      courseId: UUID,
      days: "7",
      focusDays: "21",
    });
    expect(parsed.courseId).toBe(UUID);
    expect(parsed.days).toBe(7);
    expect(parsed.focusDays).toBe(21);
  });

  it("days 支持「all」（全部时间）", () => {
    const parsed = analyticsQuerySchema.parse({ days: "all" });
    expect(parsed.days).toBe("all");
  });

  it("非法值被拒绝（0、负数、非数字、超范围）", () => {
    expect(analyticsQuerySchema.safeParse({ days: "0" }).success).toBe(false);
    expect(analyticsQuerySchema.safeParse({ days: "-7" }).success).toBe(false);
    expect(analyticsQuerySchema.safeParse({ days: "abc" }).success).toBe(false);
    expect(analyticsQuerySchema.safeParse({ days: "9999" }).success).toBe(false);
    expect(analyticsQuerySchema.safeParse({ focusDays: "0" }).success).toBe(
      false,
    );
    expect(
      analyticsQuerySchema.safeParse({ courseId: "not-uuid" }).success,
    ).toBe(false);
  });
});

describe("完成矩阵单元格（D2 判别联合）", () => {
  it("作业列单元格", () => {
    expect(
      analyticsAssignmentCellSchema.parse({
        kind: "assignment",
        studentId: UUID,
        assignmentId: UUID,
        status: "graded",
        attemptId: UUID,
        submittedAt: "2026-09-28T10:00:00.000Z",
      }),
    ).toMatchObject({ status: "graded" });
  });

  it("课程单元列单元格（做过次数/首次得分/重做，D1/D2）", () => {
    expect(
      analyticsUnitCellSchema.parse({
        kind: "course-unit",
        studentId: UUID,
        courseId: UUID,
        unitId: "有理数课程练习",
        status: "graded",
        attemptCount: 3,
        redoCount: 2,
        firstScore: 80,
        pendingCount: 0,
        latestSubmittedAt: "2026-09-28T10:00:00.000Z",
      }),
    ).toMatchObject({ attemptCount: 3, redoCount: 2 });
  });

  it("非法状态被拒绝", () => {
    expect(
      analyticsUnitCellSchema.safeParse({
        kind: "course-unit",
        studentId: UUID,
        courseId: UUID,
        unitId: "u",
        status: "done",
        attemptCount: 1,
        redoCount: 0,
        firstScore: null,
        pendingCount: 0,
        latestSubmittedAt: null,
      }).success,
    ).toBe(false);
  });
});

describe("周趋势桶（D5）", () => {
  it("无已判定题的桶 correctRate 为 null", () => {
    const point = analyticsTrendPointSchema.parse({
      weekStart: "2026-09-28",
      attemptCount: 0,
      judgedCount: 0,
      correctCount: 0,
      correctRate: null,
    });
    expect(point.correctRate).toBeNull();
  });

  it("weekStart 必须是 YYYY-MM-DD", () => {
    expect(
      analyticsTrendPointSchema.safeParse({
        weekStart: "2026-09-28T00:00:00Z",
        attemptCount: 1,
        judgedCount: 2,
        correctCount: 1,
        correctRate: 0.5,
      }).success,
    ).toBe(false);
  });
});

describe("总览/画像/题目响应形态（完整 fixture）", () => {
  it("总览：矩阵 + 趋势 + 重点 + 离线 + 关键计数", () => {
    const data = analyticsOverviewDataSchema.parse({
      range: { days: 30, from: "2026-09-01T04:00:00.000Z", to: "2026-10-01T04:00:00.000Z" },
      focusDays: 14,
      matrix: {
        students: [{ studentId: UUID, displayName: "小明", archived: false }],
        assignmentColumns: [
          {
            assignmentId: UUID,
            title: "开学摸底练习",
            dueAt: null,
            courseId: UUID,
            courseName: "初一数学",
          },
        ],
        unitColumns: [
          {
            courseId: UUID,
            courseName: "初一数学",
            unitId: "有理数随堂练习",
            unitTitle: "有理数随堂练习",
            order: 2,
          },
        ],
        cells: [
          {
            kind: "assignment",
            studentId: UUID,
            assignmentId: UUID,
            status: "not-started",
            attemptId: null,
            submittedAt: null,
          },
          {
            kind: "course-unit",
            studentId: UUID,
            courseId: UUID,
            unitId: "有理数随堂练习",
            status: "in-progress",
            attemptCount: 1,
            redoCount: 0,
            firstScore: null,
            pendingCount: 0,
            latestSubmittedAt: null,
          },
        ],
      },
      trend: [
        {
          weekStart: "2026-09-28",
          attemptCount: 2,
          judgedCount: 5,
          correctCount: 3,
          correctRate: 0.6,
        },
      ],
      focus: {
        focusDays: 14,
        from: "2026-09-17T04:00:00.000Z",
        points: [
          {
            knowledge: "有理数加法",
            wrongCount: 3,
            judgedCount: 5,
            correctRate: 0.4,
            representative: {
              questionId: "练习四-4",
              stemMd: "计算：$(-3)+7=$ [[4]]",
              type: "fill",
              difficulty: 2,
              knowledge: ["有理数加法"],
              attemptId: UUID,
              studentId: UUID,
              studentName: "小红",
              answerText: "5",
              submittedAt: "2026-09-27T10:00:00.000Z",
            },
          },
        ],
      },
      pendingMarkCount: 2,
      studentCount: 3,
      redoCount: 2,
      offline: { offlineShare: 0.5, activeSecTotal: 600, offlineSecTotal: 300 },
      overall: { judgedCount: 10, correctCount: 7, correctRate: 0.7 },
    });
    expect(data.matrix.cells).toHaveLength(2);
    expect(data.focus.points[0]?.knowledge).toBe("有理数加法");
  });

  it("画像：考点/异常/重做/离线/讲义地图", () => {
    const data = analyticsStudentDataSchema.parse({
      studentId: UUID,
      studentName: "小明",
      archived: false,
      range: { days: "all", from: null, to: "2026-10-01T04:00:00.000Z" },
      trend: [],
      knowledge: [
        {
          knowledge: "相反数",
          correctCount: 1,
          wrongCount: 2,
          pendingCount: 1,
          judgedCount: 3,
          correctRate: 1 / 3,
        },
      ],
      totals: { judgedCount: 3, correctCount: 1, pendingCount: 1, correctRate: 1 / 3 },
      anomalies: [
        {
          attemptId: UUID,
          questionId: "数轴练习-2",
          stemMd: "选择题干",
          type: "choice",
          difficulty: 2,
          knowledge: ["数轴"],
          activeSec: 300,
          medianSec: 60,
          multipleOfMedian: 5,
          hintsUsed: 0,
          reasons: ["slow"],
          submittedAt: "2026-09-29T10:00:00.000Z",
        },
      ],
      redo: [
        {
          courseId: UUID,
          courseName: "初一数学",
          unitId: "有理数随堂练习",
          unitTitle: "有理数随堂练习",
          attemptCount: 3,
          redoCount: 2,
          firstScore: 80,
          latestSubmittedAt: "2026-09-17T10:00:00.000Z",
        },
      ],
      offline: { offlineShare: 0, activeSecTotal: 0, offlineSecTotal: 0 },
      lectures: [
        {
          lectureId: UUID,
          title: "第1讲 有理数",
          updatedAt: "2026-09-01T00:00:00.000Z",
          map: {
            sections: [
              {
                headingIndex: 0,
                level: 2,
                text: "一、正数与负数",
                reached: true,
                rawDwellSec: 300,
                dwellSec: 295,
                expectedSec: 30,
                status: "deep",
              },
            ],
            folds: [
              {
                docIndex: 1,
                name: "fold",
                hostHeadingIndex: 0,
                opened: true,
                openCount: 1,
                firstOpenOffsetSec: 55,
                rawDwellSec: 120,
                dwellSec: 120,
                expectedSec: 4,
                status: "read",
              },
            ],
            steps: [
              {
                docIndex: 3,
                hostHeadingIndex: 0,
                revealedCount: 2,
                total: 2,
                paceSec: [140],
                status: "step-by-step",
              },
            ],
            summary: {
              readSec: 295,
              totalVisibleSec: 360,
              sectionCoverage: 1,
              foldOpenRate: 1,
              hintOpenCount: 0,
              solutionOpenCount: 0,
              stepsRushContainerCount: 0,
              stepsTotalContainers: 1,
              stepsOverallMedianPaceSec: 140,
              degradedEventCount: 0,
            },
          },
        },
      ],
    });
    expect(data.anomalies[0]?.reasons).toEqual(["slow"]);
    expect(data.lectures[0]?.map.summary.readSec).toBe(295);
  });

  it("题目统计：错误答案分布含「未作答」（null）条目", () => {
    const data = analyticsQuestionsDataSchema.parse({
      range: { days: 7, from: "2026-09-24T04:00:00.000Z", to: "2026-10-01T04:00:00.000Z" },
      questions: [
        {
          questionId: "数轴练习-2",
          unitId: "数轴练习",
          unitTitle: "数轴练习",
          type: "choice",
          difficulty: 2,
          knowledge: ["数轴"],
          stemMd: "题干",
          submittedCount: 3,
          judgedCount: 3,
          correctCount: 1,
          pendingCount: 0,
          correctRate: 1 / 3,
          avgSec: 140,
          medianSec: 60,
          anomalyCount: 2,
          wrongAnswers: [
            { answerText: "A", count: 1 },
            { answerText: null, count: 1 },
          ],
          lastSubmittedAt: "2026-09-29T10:00:00.000Z",
        },
      ],
    });
    expect(data.questions[0]?.wrongAnswers[1]?.answerText).toBeNull();
  });
});

describe("讲义阅读地图镜像（T4.0b 输出形状）", () => {
  it("空地图（无标题讲义）合法", () => {
    const map = analyticsLectureReadingMapSchema.parse({
      sections: [],
      folds: [],
      steps: [],
      summary: {
        readSec: 0,
        totalVisibleSec: 0,
        sectionCoverage: 0,
        foldOpenRate: 0,
        hintOpenCount: 0,
        solutionOpenCount: 0,
        stepsRushContainerCount: 0,
        stepsTotalContainers: 0,
        stepsOverallMedianPaceSec: null,
        degradedEventCount: 0,
      },
    });
    expect(map.sections).toHaveLength(0);
  });
});

describe("错误码集合", () => {
  it("固定子集（STUDENT_NOT_FOUND 为域隔离 404 口径）", () => {
    expect(
      analyticsErrorCodeSchema.parse("STUDENT_NOT_FOUND"),
    ).toBe("STUDENT_NOT_FOUND");
    expect(analyticsErrorCodeSchema.safeParse("NOT_FOUND").success).toBe(false);
  });
});
