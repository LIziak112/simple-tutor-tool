import { describe, expect, it } from "vitest";
import {
  LEARNING_PACK_GOAL_LABELS,
  LEARNING_PACK_MAX_BYTES,
  learningPackAliasOf,
  learningPackErrorCodeSchema,
  learningPackExportRequestSchema,
  learningPackJsonSchema,
  learningPackPreviewDataSchema,
  learningPackSchema,
  renderLearningPackPrompt,
} from "./learning-pack.ts";

/**
 * AI 学情数据包契约自测（T4.3）：锁定请求校验（模块勾选建模、隐私缺省、
 * 至少一个内容模块）、pack 结构（section 可缺席）、preview 形态、化名编号、
 * JSON Schema 可导出（z.toJSONSchema 不抛错）、prompt 模板按模块拼装
 * （D17：未勾手写不提笔迹、未勾讲义不讲阅读、四模板关键段、自定义段追加）。
 */

/** 最小合法请求体（仅勾题目题干层） */
const MIN_REQUEST = {
  scope: { studentIds: ["0b7e0f4e-1c2d-4e3a-9f10-112233445566"] },
  modules: { questions: "stem" },
  goal: "diagnose-weakness",
} as const;

describe("导出请求 schema（D14）", () => {
  it("最小请求通过，privacy 缺省化名开启、模块缺省不勾选", () => {
    const parsed = learningPackExportRequestSchema.parse(MIN_REQUEST);
    expect(parsed.privacy.anonymize).toBe(true);
    expect(parsed.modules.responses).toBe(false);
    expect(parsed.modules.lectures).toEqual([]);
    expect(parsed.scope.days).toBe(30);
  });

  it("隐私关闭化名（含真实姓名语义）合法显式表达", () => {
    const parsed = learningPackExportRequestSchema.parse({
      ...MIN_REQUEST,
      privacy: { anonymize: false },
    });
    expect(parsed.privacy.anonymize).toBe(false);
  });

  it("一个内容模块都不勾 → 拒绝（ink 单独不算内容模块）", () => {
    const result = learningPackExportRequestSchema.safeParse({
      ...MIN_REQUEST,
      modules: { ink: true },
    });
    expect(result.success).toBe(false);
  });

  it("非法任务目标与非整数 days 拒绝", () => {
    expect(
      learningPackExportRequestSchema.safeParse({
        ...MIN_REQUEST,
        goal: "写周报",
      }).success,
    ).toBe(false);
    expect(
      learningPackExportRequestSchema.safeParse({
        ...MIN_REQUEST,
        scope: { days: 1.5 },
      }).success,
    ).toBe(false);
    expect(
      learningPackExportRequestSchema.safeParse({
        ...MIN_REQUEST,
        scope: { days: "all" },
      }).success,
    ).toBe(true);
  });

  it("讲义勾选项：sectionIndexes 缺省为空数组（仅大纲）", () => {
    const parsed = learningPackExportRequestSchema.parse({
      ...MIN_REQUEST,
      modules: {
        lectures: [
          { lectureId: "0b7e0f4e-1c2d-4e3a-9f10-112233445566" },
          {
            lectureId: "1c8f1a5f-2d3e-4f4a-8f21-223344556677",
            sectionIndexes: [0, 2],
          },
        ],
      },
    });
    expect(parsed.modules.lectures[0]?.sectionIndexes).toEqual([]);
    expect(parsed.modules.lectures[1]?.sectionIndexes).toEqual([0, 2]);
  });
});

describe("LearningPack schema（D19 模块化）", () => {
  /** 骨架 pack（meta + 一名学生，无任何 section）——最小合法形态 */
  const MIN_PACK = {
    meta: {
      version: 1,
      generatedAt: "2026-10-01T00:00:00.000Z",
      goal: "diagnose-weakness",
      days: 30,
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
      anonymized: true,
      modules: {
        lectures: false,
        questions: null,
        responses: false,
        summaries: false,
        ink: false,
        traces: false,
      },
      note: "评语为教师原文，可能包含真实姓名。",
    },
    students: [
      {
        id: "0b7e0f4e-1c2d-4e3a-9f10-112233445566",
        name: "学生A",
        archived: false,
      },
    ],
  } as const;

  it("最小 pack（无任何 section）合法——未勾选的 section 不出现", () => {
    expect(learningPackSchema.parse(MIN_PACK)).toBeTruthy();
  });

  it("attempts section 形状：responses 行与历次汇总行（D15 attemptNo/isFirst/sourceType）", () => {
    const pack = learningPackSchema.parse({
      ...MIN_PACK,
      attempts: {
        responses: [
          {
            attemptId: "2d902b60-3e4f-4a5b-9a32-334455667788",
            studentId: "0b7e0f4e-1c2d-4e3a-9f10-112233445566",
            questionId: "有理数随堂练习-3",
            no: 3,
            answerText: "5",
            autoCorrect: false,
            finalCorrect: false,
            teacherMark: null,
            teacherComment: "再想想异号相加的符号规则。",
          },
        ],
        summaries: [
          {
            attemptId: "2d902b60-3e4f-4a5b-9a32-334455667788",
            studentId: "0b7e0f4e-1c2d-4e3a-9f10-112233445566",
            sourceType: "course",
            assignmentId: null,
            assignmentTitle: null,
            courseId: "3ea13c70-4f5a-4b6c-8b43-445566778899",
            courseName: "初一数学·上学期",
            unitId: "有理数随堂练习",
            unitTitle: "有理数随堂练习",
            attemptNo: 2,
            isFirst: false,
            status: "graded",
            startedAt: "2026-09-15T02:00:00.000Z",
            submittedAt: "2026-09-15T03:00:00.000Z",
            scoreAuto: 80,
            scoreFinal: 80,
            questionCount: 5,
            correctCount: 4,
            wrongCount: 1,
            pendingCount: 0,
          },
        ],
      },
    });
    expect(pack.attempts?.summaries?.[0]?.isFirst).toBe(false);
    expect(pack.attempts?.responses?.[0]?.teacherComment).toContain("符号规则");
  });

  it("错误码集合锁定（EXPORT_TOO_LARGE 为 D18 验收码）", () => {
    expect(learningPackErrorCodeSchema.parse("EXPORT_TOO_LARGE")).toBe(
      "EXPORT_TOO_LARGE",
    );
    expect(learningPackErrorCodeSchema.safeParse("TOO_BIG").success).toBe(
      false,
    );
  });
});

describe("preview 响应 schema", () => {
  it("文件清单 + 总预估 + 上限 + 超限标志与提示", () => {
    const parsed = learningPackPreviewDataSchema.parse({
      files: [
        { path: "pack.json", estimatedBytes: 12_000 },
        { path: "ink/学生A-q-x-2d902b60.png", estimatedBytes: 300_000 },
      ],
      totalEstimatedBytes: 312_000,
      limitBytes: LEARNING_PACK_MAX_BYTES,
      overLimit: false,
      hint: null,
    });
    expect(parsed.files).toHaveLength(2);
  });
});

describe("化名编号（D16）", () => {
  it("按名单顺序：学生A…学生Z、学生AA 起", () => {
    expect(learningPackAliasOf(0)).toBe("学生A");
    expect(learningPackAliasOf(1)).toBe("学生B");
    expect(learningPackAliasOf(25)).toBe("学生Z");
    expect(learningPackAliasOf(26)).toBe("学生AA");
    expect(learningPackAliasOf(27)).toBe("学生AB");
  });
});

describe("prompt 模板单一来源（D17）", () => {
  const base = {
    goal: "diagnose-weakness",
    lectures: true,
    questionLevel: "solution",
    responses: true,
    summaries: true,
    ink: true,
    traces: true,
    anonymized: true,
  } as const;

  it("四模板各自关键段存在", () => {
    for (const goal of [
      "diagnose-weakness",
      "lesson-prep",
      "variant-practice",
      "period-summary",
    ] as const) {
      const md = renderLearningPackPrompt({ ...base, goal });
      expect(md).toContain(
        `# 学情数据包分析任务：${LEARNING_PACK_GOAL_LABELS[goal]}`,
      );
    }
    expect(
      renderLearningPackPrompt({ ...base, goal: "variant-practice" }),
    ).toContain("内容 DSL v2");
    expect(
      renderLearningPackPrompt({ ...base, goal: "period-summary" }),
    ).toContain("面向家长");
  });

  it("按模块拼装：未勾手写不出现笔迹句、未勾讲义不讲阅读地图", () => {
    const noInk = renderLearningPackPrompt({ ...base, ink: false });
    expect(noInk).not.toContain("ink/");
    expect(noInk).not.toContain("手写过程图片");
    const noLecture = renderLearningPackPrompt({
      ...base,
      lectures: false,
      traces: false,
    });
    expect(noLecture).not.toContain("阅读地图");
    expect(noLecture).not.toContain("content.lectures");
  });

  it("化名说明与真名说明随隐私开关切换；评语原文提示在勾选逐题作答时出现", () => {
    const anon = renderLearningPackPrompt(base);
    expect(anon).toContain("已化名");
    expect(anon).toContain("教师评语原文");
    const real = renderLearningPackPrompt({ ...base, anonymized: false });
    expect(real).toContain("包含真实姓名");
  });

  it("题目层级说明随三层变化", () => {
    expect(
      renderLearningPackPrompt({ ...base, questionLevel: "stem" }),
    ).toContain("已隐去");
    expect(
      renderLearningPackPrompt({ ...base, questionLevel: "answer" }),
    ).toContain("参考答案");
  });

  it("自定义附加段追加在「教师附加要求」", () => {
    const md = renderLearningPackPrompt({
      ...base,
      customPrompt: "重点看异号加法的符号处理。",
    });
    expect(md).toContain("## 教师附加要求");
    expect(md).toContain("重点看异号加法的符号处理。");
  });
});

describe("JSON Schema 导出（D19）", () => {
  it("learningPackJsonSchema 可序列化且包含四大 section 与 meta", () => {
    const schema = learningPackJsonSchema();
    const text = JSON.stringify(schema);
    expect(schema.title).toContain("学情数据包");
    for (const key of [
      '"meta"',
      '"students"',
      '"content"',
      '"attempts"',
      '"traces"',
      '"summary"',
    ]) {
      expect(text).toContain(key);
    }
  });
});
