import { describe, expect, it } from "vitest";
import {
  teacherAttemptCardSchema,
  teacherAttemptDetailDataSchema,
  teacherAttemptDetailQuestionSchema,
  teacherAttemptErrorCodeSchema,
  teacherAttemptListQuerySchema,
} from "./teacher-attempt-api.ts";

/**
 * 教师端作答数据契约测试（T3.1）：查询参数（分页 coerce/边界/默认值）、
 * 来源上下文两种来源的字段形态、D7 逐题字段（draft 不带 answers/solutionMd）、
 * 错误码集合。契约是前后端唯一事实来源，服务端路由测试共用同一份定义。
 */

const UUID = "0199aaaa-1111-4222-8333-444455556666";

/** 合法的课程练习卡片样例（course 来源） */
const courseCardFixture = {
  sourceType: "course",
  courseId: UUID,
  courseName: "初一上",
  assignmentId: null,
  assignmentTitle: null,
  unitId: "有理数课程练习",
  unitTitle: "有理数课程练习",
  attemptNo: 2,
  attemptId: UUID,
  studentId: UUID,
  studentName: "小明",
  unitCount: 1,
  questionCount: 3,
  status: "submitted",
  scoreAuto: 100,
  scoreFinal: null,
  pendingCount: 1,
  startedAt: "2026-09-28T10:00:00.000Z",
  submittedAt: "2026-09-28T10:20:00.000Z",
  activeSec: 600,
};

describe("teacherAttemptListQuerySchema（分页与筛选）", () => {
  it("空对象取默认值 limit=50、offset=0", () => {
    const parsed = teacherAttemptListQuerySchema.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.offset).toBe(0);
  });

  it("查询字符串数值被 coerce（「50」→ 50）", () => {
    const parsed = teacherAttemptListQuerySchema.parse({
      limit: "200",
      offset: "10",
    });
    expect(parsed.limit).toBe(200);
    expect(parsed.offset).toBe(10);
  });

  it("拒绝越界分页与非 UUID 筛选值、非法时间格式", () => {
    for (const bad of [
      { limit: 0 },
      { limit: 201 },
      { limit: "abc" },
      { offset: -1 },
      { studentId: "not-a-uuid" },
      { courseId: "none" },
      { from: "2026-09-28T18:00" },
      { sourceType: "exam" },
      { status: "archived" },
    ] as const) {
      expect(
        teacherAttemptListQuerySchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it("unitId 接受 DSL 字符串 id（非 UUID）", () => {
    expect(
      teacherAttemptListQuerySchema.safeParse({ unitId: "有理数课程练习" })
        .success,
    ).toBe(true);
  });
});

describe("teacherAttemptCardSchema（来源上下文与得分双字段）", () => {
  it("接受 course 来源卡片；多余字段被剥离", () => {
    const parsed = teacherAttemptCardSchema.safeParse(courseCardFixture);
    expect(parsed.success).toBe(true);
    expect(parsed.success && "teacherId" in parsed.data).toBe(false);
  });

  it("接受 assignment 来源卡片（单元字段为 null、attemptNo=1）", () => {
    const parsed = teacherAttemptCardSchema.safeParse({
      ...courseCardFixture,
      sourceType: "assignment",
      courseId: UUID,
      courseName: "初一上",
      assignmentId: UUID,
      assignmentTitle: "第一周作业",
      unitId: null,
      unitTitle: null,
      attemptNo: 1,
      status: "draft",
      submittedAt: null,
      scoreAuto: null,
      activeSec: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("拒绝超范围得分与非空作业标题（course 来源须为 null）", () => {
    expect(
      teacherAttemptCardSchema.safeParse({
        ...courseCardFixture,
        scoreAuto: 101,
      }).success,
    ).toBe(false);
    expect(
      teacherAttemptCardSchema.safeParse({
        ...courseCardFixture,
        assignmentTitle: "",
      }).success,
    ).toBe(false);
  });
});

describe("teacherAttemptDetailQuestionSchema（D7：draft 不带答案详解）", () => {
  /** draft 形态：无 answers / solutionMd 键，判定字段全 null */
  const draftQuestion = {
    questionId: "有理数课程练习-1",
    no: 1,
    unitId: "有理数课程练习",
    unitTitle: "有理数课程练习",
    type: "judge",
    difficulty: 1,
    knowledge: ["有理数的概念"],
    stemMd: "$1$ 是正数。[[]]",
    options: undefined,
    answer: { kind: "judge", value: true },
    autoCorrect: null,
    finalCorrect: null,
    teacherMark: null,
    teacherComment: null,
    activeSec: null,
    hintsUsed: 1,
    changeCount: 2,
    ink: null,
  };

  it("draft 逐题（无 answers/solutionMd）可解析", () => {
    expect(
      teacherAttemptDetailQuestionSchema.safeParse(draftQuestion).success,
    ).toBe(true);
  });

  it("已交卷逐题带 answers / solutionMd / 手写信息", () => {
    const parsed = teacherAttemptDetailQuestionSchema.safeParse({
      ...draftQuestion,
      stemMd: "$1$ 是正数。[[正确]]",
      answer: null,
      ink: {
        inkId: UUID,
        pngUrl: `/api/teacher/ink/${UUID}.png`,
        hasStrokes: true,
      },
      answers: { kind: "judge", value: true },
      solutionMd: "大于 $0$ 的数是正数。",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.answers?.kind).toBe("judge");
  });

  it("teacherMark 只收 correct/wrong/null", () => {
    for (const [mark, ok] of [
      ["correct", true],
      ["wrong", true],
      [null, true],
      ["对", false],
    ] as const) {
      expect(
        teacherAttemptDetailQuestionSchema.safeParse({
          ...draftQuestion,
          teacherMark: mark,
        }).success,
      ).toBe(ok);
    }
  });
});

describe("teacherAttemptDetailDataSchema（详情头）", () => {
  it("接受完整详情（含逐题数组与计数）", () => {
    const parsed = teacherAttemptDetailDataSchema.safeParse({
      sourceType: "assignment",
      courseId: UUID,
      courseName: "初一上",
      assignmentId: UUID,
      assignmentTitle: "第一周作业",
      unitId: null,
      unitTitle: null,
      attemptNo: 1,
      attemptId: UUID,
      studentId: UUID,
      studentName: "小明",
      status: "submitted",
      scoreAuto: 50,
      scoreFinal: null,
      correctCount: 1,
      wrongCount: 1,
      pendingCount: 1,
      startedAt: "2026-09-28T10:00:00.000Z",
      submittedAt: "2026-09-28T10:20:00.000Z",
      activeSec: 600,
      questions: [],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("teacherAttemptErrorCodeSchema", () => {
  it("只收录作答数据页错误码（域隔离 404 口径）", () => {
    expect(teacherAttemptErrorCodeSchema.options).toEqual([
      "ATTEMPT_NOT_FOUND",
      "UNAUTHORIZED",
      "VALIDATION_ERROR",
    ]);
  });
});
