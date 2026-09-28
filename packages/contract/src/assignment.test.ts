import { describe, expect, it } from "vitest";
import {
  assignmentCheckRequestSchema,
  assignmentCreateRequestSchema,
  assignmentDueAtSchema,
  assignmentErrorCodeSchema,
  assignmentListQuerySchema,
  assignmentUpdateRequestSchema,
  defaultAssignmentTitle,
  studentAssignmentSchema,
  studentPaperDataSchema,
  teacherAssignmentSchema,
} from "./assignment.ts";

/**
 * 作业契约自测（T2.2；T2A.7 大改后同步）：锁定创建/更新/检查请求的关键校验
 * （unitIds 至少一个且不可重复提交口径、studentIds 至少一名、dueAt 必须 UTC ISO、
 * courseId 查询参数 UUID/none）、缺省标题规则、学生端条目与试卷的无泄露字段集合，
 * 防止后续调整契约时无声放宽。
 */

const UNIT_ID = "unit-一元一次方程";
const UNIT_ID_2 = "unit-有理数乘除";
const STUDENT_A = "11111111-1111-4111-8111-111111111111";
const STUDENT_B = "22222222-2222-4222-8222-222222222222";
const COURSE_ID = "33333333-3333-4333-8333-333333333333";
const ASSIGNMENT_ID = "44444444-4444-4444-8444-444444444444";
const DUE_AT = "2026-10-01T12:00:00.000Z";

describe("assignmentCreateRequestSchema（T2A.7 多单元 + 课程）", () => {
  it("接受合法请求：unitIds 多个 + studentIds（title/courseId/dueAt 可选）", () => {
    const parsed = assignmentCreateRequestSchema.parse({
      unitIds: [UNIT_ID, UNIT_ID_2],
      studentIds: [STUDENT_A, STUDENT_B],
    });
    expect(parsed.title).toBeUndefined();
    expect(parsed.courseId).toBeUndefined();
    expect(parsed.dueAt).toBeUndefined();
    expect(parsed.unitIds).toEqual([UNIT_ID, UNIT_ID_2]);
  });

  it("courseId 接受 UUID 与显式 null（不挂课程）；非 UUID 拒绝", () => {
    expect(
      assignmentCreateRequestSchema.safeParse({
        unitIds: [UNIT_ID],
        studentIds: [STUDENT_A],
        courseId: COURSE_ID,
      }).success,
    ).toBe(true);
    expect(
      assignmentCreateRequestSchema.safeParse({
        unitIds: [UNIT_ID],
        studentIds: [STUDENT_A],
        courseId: null,
      }).success,
    ).toBe(true);
    expect(
      assignmentCreateRequestSchema.safeParse({
        unitIds: [UNIT_ID],
        studentIds: [STUDENT_A],
        courseId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("unitIds / studentIds 为空数组拒绝（各自的最小数量）", () => {
    expect(
      assignmentCreateRequestSchema.safeParse({
        unitIds: [],
        studentIds: [STUDENT_A],
      }).success,
    ).toBe(false);
    const noUnits = assignmentCreateRequestSchema.safeParse({
      unitIds: [],
      studentIds: [STUDENT_A],
    });
    expect(noUnits.success).toBe(false);
    if (!noUnits.success) {
      expect(noUnits.error.issues[0]?.message).toBe(
        "作业必须至少包含一个练习单元",
      );
    }
    const noStudents = assignmentCreateRequestSchema.safeParse({
      unitIds: [UNIT_ID],
      studentIds: [],
    });
    expect(noStudents.success).toBe(false);
    if (!noStudents.success) {
      expect(noStudents.error.issues[0]?.message).toBe(
        "作业必须至少指派一名学生",
      );
    }
  });

  it("studentIds 含非 UUID 拒绝；title trim 后为空拒绝", () => {
    expect(
      assignmentCreateRequestSchema.safeParse({
        unitIds: [UNIT_ID],
        studentIds: ["not-a-uuid"],
      }).success,
    ).toBe(false);
    expect(
      assignmentCreateRequestSchema.safeParse({
        unitIds: [UNIT_ID],
        studentIds: [STUDENT_A],
        title: "   ",
      }).success,
    ).toBe(false);
  });
});

describe("defaultAssignmentTitle（缺省标题规则，D12）", () => {
  it("单单元 = 该单元标题；多单元 = 「首个单元标题 等 n 个单元」", () => {
    expect(defaultAssignmentTitle(["一元一次方程"])).toBe("一元一次方程");
    expect(
      defaultAssignmentTitle(["一元一次方程", "有理数乘除", "绝对值"]),
    ).toBe("一元一次方程 等 3 个单元");
    expect(defaultAssignmentTitle([])).toBe("");
  });
});

describe("assignmentDueAtSchema（UTC ISO 策略）", () => {
  it("接受带 Z 的 UTC ISO（含毫秒/微秒）；拒绝本地格式与 +hh:mm 偏移", () => {
    expect(assignmentDueAtSchema.safeParse(DUE_AT).success).toBe(true);
    expect(
      assignmentDueAtSchema.safeParse("2026-10-01T12:00:00Z").success,
    ).toBe(true);
    // datetime-local 原始值（无时区）拒绝：前端必须先转 UTC
    expect(assignmentDueAtSchema.safeParse("2026-10-01T20:00").success).toBe(
      false,
    );
    expect(
      assignmentDueAtSchema.safeParse("2026-10-01T20:00:00+08:00").success,
    ).toBe(false);
  });
});

describe("assignmentUpdateRequestSchema（T2A.7 增量名单 + 内容锁定开关）", () => {
  it("空对象合法（全部缺省 = 不改）；dueAt 显式 null 表示取消截止", () => {
    expect(assignmentUpdateRequestSchema.safeParse({}).success).toBe(true);
    const parsed = assignmentUpdateRequestSchema.parse({ dueAt: null });
    expect(parsed.dueAt).toBeNull();
  });

  it("unitIds 提供时不可为空数组；add/removeStudentIds 为 UUID 数组", () => {
    expect(
      assignmentUpdateRequestSchema.safeParse({ unitIds: [] }).success,
    ).toBe(false);
    expect(
      assignmentUpdateRequestSchema.safeParse({
        unitIds: [UNIT_ID, UNIT_ID_2],
      }).success,
    ).toBe(true);
    expect(
      assignmentUpdateRequestSchema.safeParse({
        addStudentIds: [STUDENT_A],
        removeStudentIds: [STUDENT_B],
        confirmStarted: true,
      }).success,
    ).toBe(true);
    expect(
      assignmentUpdateRequestSchema.safeParse({
        addStudentIds: ["nope"],
      }).success,
    ).toBe(false);
  });
});

describe("assignmentCheckRequestSchema（D15 布置前检查）", () => {
  it("unitIds 与 studentIds 均至少一个；空数组拒绝", () => {
    expect(
      assignmentCheckRequestSchema.safeParse({
        unitIds: [UNIT_ID],
        studentIds: [STUDENT_A],
      }).success,
    ).toBe(true);
    expect(
      assignmentCheckRequestSchema.safeParse({
        unitIds: [],
        studentIds: [STUDENT_A],
      }).success,
    ).toBe(false);
    expect(
      assignmentCheckRequestSchema.safeParse({
        unitIds: [UNIT_ID],
        studentIds: [],
      }).success,
    ).toBe(false);
  });
});

describe("assignmentListQuerySchema（T2A.7 courseId 筛选）", () => {
  it("includeDeleted 接受 undefined / true / false，拒绝非布尔写法", () => {
    expect(assignmentListQuerySchema.parse({})).toEqual({});
    expect(assignmentListQuerySchema.parse({ includeDeleted: "true" })).toEqual(
      {
        includeDeleted: true,
      },
    );
    expect(
      assignmentListQuerySchema.parse({ includeDeleted: "false" }),
    ).toEqual({
      includeDeleted: false,
    });
    expect(
      assignmentListQuerySchema.safeParse({ includeDeleted: "yes!" }).success,
    ).toBe(false);
  });

  it("courseId 接受 UUID 与字面量 none（无课程作业）；其他值拒绝", () => {
    expect(assignmentListQuerySchema.parse({ courseId: COURSE_ID })).toEqual({
      courseId: COURSE_ID,
    });
    expect(assignmentListQuerySchema.parse({ courseId: "none" })).toEqual({
      courseId: "none",
    });
    expect(
      assignmentListQuerySchema.safeParse({ courseId: "abc" }).success,
    ).toBe(false);
  });
});

describe("teacherAssignmentSchema（T2A.7 列表行字段集合）", () => {
  it("含单元列表/总题数/四态统计/锁定与已删单元标记；不含学生名单明细", () => {
    const keys = Object.keys(teacherAssignmentSchema.shape);
    expect(keys).toEqual([
      "id",
      "courseId",
      "courseName",
      "title",
      "dueAt",
      "units",
      "totalQuestionCount",
      "containsDeletedUnit",
      "locked",
      "studentCount",
      "rosterStats",
      "deleted",
      "deletedAt",
      "createdAt",
    ]);
    // 名单明细只在详情（roster），列表行不再携带 students 数组
    expect(keys).not.toContain("students");
  });
});

describe("studentAssignmentSchema（学生端无泄露约束，T2A.7 多单元化）", () => {
  it("只含公开元信息字段：不含 answers/solution/hints/stem 等教师侧字段", () => {
    const keys = Object.keys(studentAssignmentSchema.shape);
    expect(keys).toEqual([
      "id",
      "title",
      "units",
      "unitCount",
      "questionCount",
      "dueAt",
      "createdAt",
      "status",
    ]);
    for (const forbidden of [
      "answers",
      "answer",
      "solutionMd",
      "solution",
      "hints",
      "stemMd",
      "options",
      "sourceMd",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("units 为 {id,title} 数组；status 只允许四种完成状态", () => {
    const base = {
      id: ASSIGNMENT_ID,
      title: "一元一次方程练习",
      units: [
        { id: UNIT_ID, title: "一元一次方程" },
        { id: UNIT_ID_2, title: "有理数乘除" },
      ],
      unitCount: 2,
      questionCount: 8,
      dueAt: DUE_AT,
      createdAt: "2026-09-27T08:00:00.000Z",
    };
    expect(
      studentAssignmentSchema.safeParse({ ...base, status: "not_started" })
        .success,
    ).toBe(true);
    expect(
      studentAssignmentSchema.safeParse({ ...base, status: "graded" }).success,
    ).toBe(true);
    expect(
      studentAssignmentSchema.safeParse({ ...base, status: "done" }).success,
    ).toBe(false);
  });
});

describe("studentPaperDataSchema（T2A.7 分组试卷：元素必须是 QuestionPublic 输出形态）", () => {
  /** 合法公开题目（模拟服务端 parse 后的输出） */
  const publicQuestion = {
    id: "练习四-2",
    type: "choice" as const,
    difficulty: 1,
    knowledge: ["相反数"],
    stemMd: "$-5$ 的相反数是（　）",
    options: ["$-5$", "$5$", "$\\frac{1}{5}$", "$-\\frac{1}{5}$"],
    hintCount: 1,
  };

  it("接受分组结构 {units:[{id,title,questions}]}；空试卷（units 空数组）合法", () => {
    expect(
      studentPaperDataSchema.safeParse({
        units: [
          { id: UNIT_ID, title: "一元一次方程", questions: [publicQuestion] },
        ],
      }).success,
    ).toBe(true);
    expect(studentPaperDataSchema.safeParse({ units: [] }).success).toBe(true);
  });

  it("旧扁平 questions 字段不再合法（契约升级为分组结构）", () => {
    expect(
      studentPaperDataSchema.safeParse({ questions: [publicQuestion] }).success,
    ).toBe(false);
  });

  it("元素携带教师侧字段时整体剥离（strip 语义），机密不外泄", () => {
    const parsed = studentPaperDataSchema.parse({
      units: [
        {
          id: UNIT_ID,
          title: "一元一次方程",
          questions: [
            {
              ...publicQuestion,
              answers: { kind: "choice", index: 1 },
              solutionMd: "$-5$ 的相反数是 $5$，故选 B。",
              hints: ["只有符号不同的两个数互为相反数"],
              sourceMd: "::::question{type=choice}…::::",
              version: 1,
            },
          ],
        },
      ],
    });
    expect(parsed.units[0]?.questions[0]).toEqual(publicQuestion);
  });

  it("元素形态非法（携带 correct 标记的选项对象 / 缺 hintCount）整体拒绝（fail closed）", () => {
    expect(
      studentPaperDataSchema.safeParse({
        units: [
          {
            id: UNIT_ID,
            title: "一元一次方程",
            questions: [
              { ...publicQuestion, options: [{ text: "$5$", correct: true }] },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    const { hintCount: omitted, ...rest } = publicQuestion;
    expect(omitted).toBe(1);
    expect(
      studentPaperDataSchema.safeParse({
        units: [{ id: UNIT_ID, title: "一元一次方程", questions: [rest] }],
      }).success,
    ).toBe(false);
  });
});

describe("assignmentErrorCodeSchema（T2A.7 追加 4 个错误码）", () => {
  it("包含重复单元/内容锁定/移出确认/课程不存在", () => {
    expect(assignmentErrorCodeSchema.parse("DUPLICATE_UNIT")).toBe(
      "DUPLICATE_UNIT",
    );
    expect(assignmentErrorCodeSchema.parse("ASSIGNMENT_CONTENT_LOCKED")).toBe(
      "ASSIGNMENT_CONTENT_LOCKED",
    );
    expect(assignmentErrorCodeSchema.parse("CONFIRM_REQUIRED")).toBe(
      "CONFIRM_REQUIRED",
    );
    expect(assignmentErrorCodeSchema.parse("COURSE_NOT_FOUND")).toBe(
      "COURSE_NOT_FOUND",
    );
    // 旧码保留
    expect(assignmentErrorCodeSchema.parse("FORBIDDEN")).toBe("FORBIDDEN");
    expect(assignmentErrorCodeSchema.safeParse("NOT_ASSIGNED").success).toBe(
      false,
    );
  });
});
