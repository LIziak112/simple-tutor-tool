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
  learningPackV2JsonSchema,
  learningPackV2Schema,
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

  it("v2 证据模块：勾选时提及 evidence 原稿图片，未勾不出现（T6R.12）", () => {
    const withEvidence = renderLearningPackPrompt({ ...base, evidence: true });
    expect(withEvidence).toContain("evidence/");
    const without = renderLearningPackPrompt(base);
    expect(without).not.toContain("evidence/");
  });

  it("使用方法交付清单按模块枚举：evidence 与 blobs/media/ 配图目录进入清单（复审 A9）", () => {
    const md = renderLearningPackPrompt({
      ...base,
      evidence: true,
      media: true,
    });
    expect(md).toContain("evidence/ 图片目录");
    expect(md).toContain("blobs/media/ 配图目录");
    expect(md).toContain("ink/ 图片目录");
    const neither = renderLearningPackPrompt({ ...base, ink: false });
    expect(neither).not.toContain("图片目录");
    expect(neither).not.toContain("配图目录");
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

// ---------- T6R.12：v2 证据装配契约（快照关联 + evidence + manifest） ----------

describe("v2 导出请求（T6R.12：packVersion 与 evidence 模块依赖）", () => {
  it("packVersion 缺省 = v1 兼容；evidence 缺省 false（缺省不改变 v1 请求形状）", () => {
    const parsed = learningPackExportRequestSchema.parse(MIN_REQUEST);
    expect(parsed.packVersion).toBeUndefined();
    expect(parsed.modules.evidence).toBe(false);
  });

  it("显式 packVersion=2 合法；evidence 勾选在 v2 + responses 勾选时通过", () => {
    const parsed = learningPackExportRequestSchema.parse({
      ...MIN_REQUEST,
      packVersion: 2,
      modules: { responses: true, evidence: true },
    });
    expect(parsed.packVersion).toBe(2);
    expect(parsed.modules.evidence).toBe(true);
  });

  it("选模块依赖：evidence 勾选但 responses 未勾 → 拒绝", () => {
    const result = learningPackExportRequestSchema.safeParse({
      ...MIN_REQUEST,
      packVersion: 2,
      modules: { evidence: true },
    });
    expect(result.success).toBe(false);
  });

  it("evidence 是 v2 专属模块：v1 请求勾选 evidence → 拒绝", () => {
    const result = learningPackExportRequestSchema.safeParse({
      ...MIN_REQUEST,
      modules: { questions: "stem", evidence: true },
    });
    expect(result.success).toBe(false);
  });

  it("packVersion 只认 2（1 必须以缺省表达，防止双写漂移）", () => {
    expect(
      learningPackExportRequestSchema.safeParse({
        ...MIN_REQUEST,
        packVersion: 1,
      }).success,
    ).toBe(false);
  });
});

describe("LearningPack v2 schema（T6R.12：快照关联 + manifest）", () => {
  /** v2 骨架：meta（version=2 + modules.evidence 回显）+ 一名学生 + 最小 manifest */
  const MIN_V2_PACK = {
    meta: {
      version: 2,
      generatedAt: "2026-10-05T00:00:00.000Z",
      goal: "diagnose-weakness",
      days: 30,
      from: "2026-09-05T00:00:00.000Z",
      to: "2026-10-05T00:00:00.000Z",
      anonymized: true,
      modules: {
        lectures: false,
        questions: null,
        responses: true,
        summaries: false,
        ink: false,
        traces: false,
        evidence: true,
      },
      note: "评语为教师原文，可能包含学生真实姓名。",
    },
    students: [
      {
        id: "0b7e0f4e-1c2d-4e3a-9f10-112233445566",
        name: "学生A",
        archived: false,
      },
    ],
    manifest: { files: [], missing: [], contextNotes: [] },
  } as const;

  it("最小 v2 pack：manifest 恒出现，evidence/content section 可缺席", () => {
    const pack = learningPackV2Schema.parse(MIN_V2_PACK);
    expect(pack.manifest.files).toEqual([]);
  });

  it("v2 responses 行带 questionRef/snapshotHash/evidenceRef（快照一一配对）", () => {
    const pack = learningPackV2Schema.parse({
      ...MIN_V2_PACK,
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
            teacherComment: null,
            questionRef: "q001",
            snapshotHash:
              "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
            evidenceRef: "e001",
          },
        ],
      },
    });
    expect(pack.attempts?.responses?.[0]?.questionRef).toBe("q001");
    // evidenceRef 缺席合法（evidence 模块未勾选时不得出现悬垂引用）
    const noEvidence = learningPackV2Schema.parse({
      ...MIN_V2_PACK,
      meta: {
        ...MIN_V2_PACK.meta,
        modules: { ...MIN_V2_PACK.meta.modules, evidence: false },
      },
      attempts: {
        responses: [
          {
            attemptId: "2d902b60-3e4f-4a5b-9a32-334455667788",
            studentId: "0b7e0f4e-1c2d-4e3a-9f10-112233445566",
            questionId: "有理数随堂练习-3",
            no: 3,
            answerText: null,
            autoCorrect: null,
            finalCorrect: null,
            teacherMark: null,
            teacherComment: null,
            questionRef: "q001",
            snapshotHash: null,
          },
        ],
      },
    });
    expect(noEvidence.attempts?.responses?.[0]?.evidenceRef).toBeUndefined();
  });

  it("v2 question 条目：ref/present/snapshotHash/media 引用；缺失快照 present=false", () => {
    const pack = learningPackV2Schema.parse({
      ...MIN_V2_PACK,
      meta: {
        ...MIN_V2_PACK.meta,
        modules: { ...MIN_V2_PACK.meta.modules, questions: "solution" },
      },
      content: {
        questions: [
          {
            ref: "q001",
            questionId: "有理数随堂练习-3",
            unitId: "有理数随堂练习",
            unitTitle: "有理数随堂练习",
            type: "fill",
            difficulty: 2,
            knowledge: ["有理数加法"],
            stemMd: "计算 $(-3)+5=[[-2]]$",
            present: true,
            snapshotHash:
              "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
            media: [
              {
                src: "blobs/media/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png",
                present: true,
              },
            ],
          },
          {
            ref: "q002",
            questionId: "已删除的旧题-7",
            unitId: null,
            unitTitle: null,
            type: "fill",
            difficulty: 2,
            knowledge: [],
            stemMd: "",
            present: false,
            snapshotHash: null,
            media: [],
          },
        ],
      },
    });
    expect(pack.content?.questions?.[0]?.present).toBe(true);
    expect(pack.content?.questions?.[1]?.stemMd).toBe("");
    expect(pack.content?.questions?.[1]?.snapshotHash).toBeNull();
  });

  it("evidence 条目：五态 + frozen 携带 version 与图片清单（裁剪区/像素/状态）", () => {
    const pack = learningPackV2Schema.parse({
      ...MIN_V2_PACK,
      evidence: [
        {
          ref: "e001",
          attemptId: "2d902b60-3e4f-4a5b-9a32-334455667788",
          studentId: "0b7e0f4e-1c2d-4e3a-9f10-112233445566",
          questionId: "有理数随堂练习-3",
          questionRef: "q001",
          no: 3,
          phase: "scratch",
          state: "frozen",
          version: {
            versionId: "3f0177d0-5e60-4f71-8a54-4455667788aa",
            savedAt: "2026-10-04T10:00:00.000Z",
            strokeCount: 12,
            pointCount: 240,
            paperHeight: 800,
          },
          images: [
            {
              file: "evidence/e001-original-01.png",
              spec: "analysis",
              pageIndex: 0,
              crop: { x: 0, y: 0, width: 1000, height: 800 },
              pixelWidth: 1000,
              pixelHeight: 800,
              state: "ready",
            },
            {
              file: "evidence/e001-original-02.png",
              spec: "analysis",
              pageIndex: 1,
              crop: { x: 0, y: 760, width: 1000, height: 800 },
              pixelWidth: 1000,
              pixelHeight: 800,
              state: "missing",
            },
          ],
        },
        {
          ref: "e002",
          attemptId: "2d902b60-3e4f-4a5b-9a32-334455667788",
          studentId: "0b7e0f4e-1c2d-4e3a-9f10-112233445566",
          questionId: "有理数随堂练习-4",
          questionRef: "q002",
          no: 4,
          phase: "scratch",
          state: "not_collected",
          images: [],
        },
      ],
    });
    expect(pack.evidence?.[0]?.state).toBe("frozen");
    expect(pack.evidence?.[0]?.images?.[1]?.state).toBe("missing");
    expect(pack.evidence?.[1]?.state).toBe("not_collected");
  });

  it("manifest：files/missing/contextNotes；missing 必带 reason 与关联 refs", () => {
    const pack = learningPackV2Schema.parse({
      ...MIN_V2_PACK,
      manifest: {
        files: [
          { path: "summary.md", kind: "summary", bytes: 800, refs: [] },
          {
            path: "blobs/media/0123.png",
            kind: "media",
            bytes: 4096,
            refs: ["q001"],
          },
          {
            path: "evidence/e001-original-01.png",
            kind: "evidence",
            bytes: 12_000,
            refs: ["e001"],
          },
        ],
        missing: [
          {
            path: "evidence/e001-original-02.png",
            kind: "evidence-image",
            reason: "图片文件缺失",
            refs: ["e001"],
          },
        ],
        contextNotes: ["题目内容模块未勾选：题目上下文未提供。"],
      },
    });
    expect(pack.manifest.missing[0]?.refs).toEqual(["e001"]);
    expect(
      learningPackV2Schema.safeParse({
        ...MIN_V2_PACK,
        manifest: { files: [], missing: [{ path: "x.png", kind: "media" }] },
      }).success,
    ).toBe(false);
  });

  it("v1 形状不进 v2 schema：version=1 且无 manifest → 拒绝（两版本显式区分）", () => {
    const v1Like = {
      meta: {
        version: 1,
        generatedAt: "2026-10-05T00:00:00.000Z",
        goal: "diagnose-weakness",
        days: 30,
        from: null,
        to: "2026-10-05T00:00:00.000Z",
        anonymized: true,
        modules: {
          lectures: false,
          questions: null,
          responses: false,
          summaries: false,
          ink: false,
          traces: false,
        },
        note: "x",
      },
      students: [],
    } as const;
    // v1 pack 仍过 v1 schema（兼容锁定）
    expect(learningPackSchema.parse(v1Like)).toBeTruthy();
    // 但过不了 v2 schema（version 字面量 + manifest 必填）
    expect(learningPackV2Schema.safeParse(v1Like).success).toBe(false);
  });
});

describe("v2 JSON Schema 导出（T6R.12）", () => {
  it("learningPackV2JsonSchema 可序列化且包含 evidence 与 manifest", () => {
    const schema = learningPackV2JsonSchema();
    const text = JSON.stringify(schema);
    expect(schema.title).toContain("v2");
    for (const key of ['"evidence"', '"manifest"', '"questionRef"']) {
      expect(text).toContain(key);
    }
  });
});
