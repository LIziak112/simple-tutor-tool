import { describe, expect, it } from "vitest";
import {
  assignmentCreateRequestSchema,
  assignmentDueAtSchema,
  assignmentErrorCodeSchema,
  assignmentListQuerySchema,
  assignmentUpdateRequestSchema,
  studentAssignmentSchema,
  studentPaperDataSchema,
} from "./assignment.ts";

/**
 * 作业契约自测（T2.2，T2.4 追加试卷）：锁定创建/更新请求的关键校验
 * （studentIds 至少一名、dueAt 必须 UTC ISO）、学生端条目与试卷的无泄露字段
 * 集合，防止后续调整契约时无声放宽。
 */

const UNIT_ID = "unit-一元一次方程";
const STUDENT_A = "11111111-1111-4111-8111-111111111111";
const STUDENT_B = "22222222-2222-4222-8222-222222222222";
const DUE_AT = "2026-10-01T12:00:00.000Z";

describe("assignmentCreateRequestSchema", () => {
  it("接受合法请求：unitId + studentIds（title/dueAt 可选）", () => {
    const parsed = assignmentCreateRequestSchema.parse({
      unitId: UNIT_ID,
      studentIds: [STUDENT_A, STUDENT_B],
    });
    expect(parsed.title).toBeUndefined();
    expect(parsed.dueAt).toBeUndefined();
  });

  it("studentIds 为空数组拒绝（作业必须至少指派一名学生）", () => {
    const result = assignmentCreateRequestSchema.safeParse({
      unitId: UNIT_ID,
      studentIds: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("作业必须至少指派一名学生");
    }
  });

  it("studentIds 含非 UUID 拒绝；title trim 后为空拒绝", () => {
    expect(
      assignmentCreateRequestSchema.safeParse({
        unitId: UNIT_ID,
        studentIds: ["not-a-uuid"],
      }).success,
    ).toBe(false);
    expect(
      assignmentCreateRequestSchema.safeParse({
        unitId: UNIT_ID,
        studentIds: [STUDENT_A],
        title: "   ",
      }).success,
    ).toBe(false);
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

describe("assignmentUpdateRequestSchema", () => {
  it("空对象合法（全部缺省 = 不改）；dueAt 显式 null 表示取消截止", () => {
    expect(assignmentUpdateRequestSchema.safeParse({}).success).toBe(true);
    const parsed = assignmentUpdateRequestSchema.parse({ dueAt: null });
    expect(parsed.dueAt).toBeNull();
  });

  it("studentIds 提供时同样要求至少一名", () => {
    expect(
      assignmentUpdateRequestSchema.safeParse({ studentIds: [] }).success,
    ).toBe(false);
  });
});

describe("assignmentListQuerySchema", () => {
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
});

describe("studentAssignmentSchema（学生端无泄露约束）", () => {
  it("只含公开元信息字段：不含 answers/solution/hints/stem 等教师侧字段", () => {
    const keys = Object.keys(studentAssignmentSchema.shape);
    expect(keys).toEqual([
      "id",
      "title",
      "unitId",
      "unitTitle",
      "topic",
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

  it("status 只允许四种完成状态", () => {
    const base = {
      id: STUDENT_A,
      title: "一元一次方程练习",
      unitId: UNIT_ID,
      unitTitle: "一元一次方程",
      topic: "方程",
      questionCount: 5,
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

describe("studentPaperDataSchema（T2.4 学生试卷：元素必须是 QuestionPublic 输出形态）", () => {
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

  it("接受 QuestionPublic 数组；空试卷（0 题）同样合法", () => {
    expect(
      studentPaperDataSchema.safeParse({ questions: [publicQuestion] })
        .success,
    ).toBe(true);
    expect(studentPaperDataSchema.safeParse({ questions: [] }).success).toBe(
      true,
    );
  });

  it("元素携带教师侧字段时整体剥离（strip 语义），机密不外泄", () => {
    const parsed = studentPaperDataSchema.parse({
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
    });
    expect(parsed.questions[0]).toEqual(publicQuestion);
  });

  it("元素形态非法（携带 correct 标记的选项对象 / 缺 hintCount）整体拒绝（fail closed）", () => {
    expect(
      studentPaperDataSchema.safeParse({
        questions: [
          { ...publicQuestion, options: [{ text: "$5$", correct: true }] },
        ],
      }).success,
    ).toBe(false);
    const { hintCount: omitted, ...rest } = publicQuestion;
    expect(omitted).toBe(1);
    expect(
      studentPaperDataSchema.safeParse({ questions: [rest] }).success,
    ).toBe(false);
  });
});

describe("assignmentErrorCodeSchema（T2.4 追加 FORBIDDEN）", () => {
  it("包含未被指派学生的 403 错误码 FORBIDDEN", () => {
    expect(assignmentErrorCodeSchema.safeParse("FORBIDDEN").success).toBe(
      true,
    );
    expect(assignmentErrorCodeSchema.safeParse("NOT_ASSIGNED").success).toBe(
      false,
    );
  });
});
