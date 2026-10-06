import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  learningPackManifestMissingSchema,
  learningPackManifestSchema,
} from "./learning-pack.ts";
import {
  renderReviewPackPrompt,
  reviewPackJsonSchema,
  reviewPackPreviewDataSchema,
  reviewPackSchema,
} from "./review-pack.ts";

/**
 * T6R.13 单题完整导出契约测试：
 * - reviewPackSchema（pack.json）：student/teacher 两形态合法样本往返；
 *   **学生域 id 剥离与答案剔除由 schema 结构性强制**（superRefine 拒绝学生
 *   包携带 questionId/attemptId/studentId/versionId/answers/solutionMd/
 *   判定/评语——安全审查留档硬要求，不是实现层约定）；
 * - manifest 复用 learningPackManifestSchema（不另造竞争格式），kind 枚举
 *   含新增的 "question"（题目 md 附件）；
 * - renderReviewPackPrompt（共享 review.md 提示词基础）：角色分节、缺图
 *   明确不完整不自动声称可诊断、复制文字不得提示成「文字图片全复制」；
 * - reviewPackJsonSchema 与 pnpm schema:export 产物逐字节一致（zip 内
 *   schema.json 单一来源）。
 */

/** 学生包最小合法样本（除 manifest 外无任何教师域键） */
const STUDENT_PACK = {
  kind: "review-pack",
  version: 1,
  role: "student",
  generatedAt: "2026-10-07T00:00:00.000Z",
  question: {
    ref: "q001",
    no: 3,
    present: true,
    snapshotHash:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    type: "fill",
    difficulty: 2,
    knowledge: ["有理数"],
    stemMd: "计算 $2+3$",
    options: ["5", "6"],
  },
  response: { no: 3, answerText: "5" },
  evidence: {
    ref: "e001",
    phase: "scratch",
    state: "frozen",
    images: [
      {
        file: "evidence/e001-original-01.png",
        pageIndex: 0,
        crop: { x: 0, y: 0, width: 1000, height: 800 },
        pixelWidth: 1000,
        pixelHeight: 800,
        state: "ready",
      },
    ],
  },
  manifest: {
    files: [
      {
        path: "questions/q001/stem.md",
        kind: "question",
        bytes: 120,
        refs: ["q001"],
      },
      {
        path: "evidence/e001-original-01.png",
        kind: "evidence",
        bytes: 2048,
        refs: ["e001"],
      },
    ],
    missing: [],
    contextNotes: [],
  },
} as const;

/** 教师包样本：教师域字段齐全（v1 教师域文档化设计——真实 id 照常携带） */
const TEACHER_PACK = {
  ...STUDENT_PACK,
  role: "teacher",
  question: {
    ...STUDENT_PACK.question,
    questionId: "加法练习-1",
    answers: { kind: "fill", blanks: [["5"]] },
    solutionMd: "解析：2+3=5",
  },
  response: {
    ...STUDENT_PACK.response,
    attemptId: "55555555-5555-4555-8555-555555555555",
    studentId: "44444444-4444-4444-8444-444444444444",
    autoCorrect: true,
    finalCorrect: true,
    teacherMark: null,
    teacherComment: "过程规范",
  },
  evidence: {
    ...STUDENT_PACK.evidence,
    attemptId: "55555555-5555-4555-8555-555555555555",
    studentId: "44444444-4444-4444-8444-444444444444",
    questionId: "加法练习-1",
    version: {
      versionId: "33333333-3333-4333-8333-333333333333",
      savedAt: "2026-10-06T00:00:00.000Z",
      strokeCount: 4,
      pointCount: 40,
      paperHeight: 800,
    },
  },
} as const;

describe("reviewPackSchema（pack.json，双角色）", () => {
  it("学生包合法样本通过；教师域键一概缺席", () => {
    const parsed = reviewPackSchema.parse(STUDENT_PACK);
    expect(parsed.role).toBe("student");
    expect(parsed.question).not.toHaveProperty("questionId");
    expect(parsed.response).not.toHaveProperty("attemptId");
    expect(parsed.evidence).not.toHaveProperty("version");
  });

  it("教师包合法样本通过：真实 id/答案/判定/评语齐全（教师域文档化设计）", () => {
    const parsed = reviewPackSchema.parse(TEACHER_PACK);
    expect(parsed.role).toBe("teacher");
    expect(parsed.question.questionId).toBe("加法练习-1");
    expect(parsed.response.teacherComment).toBe("过程规范");
    expect(parsed.evidence.version?.versionId).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
  });

  it("学生包携带教师域字段被拒（id 剥离与答案剔除是 schema 级不变量）", () => {
    const cases: ReadonlyArray<Record<string, unknown>> = [
      {
        ...STUDENT_PACK,
        question: { ...STUDENT_PACK.question, questionId: "加法练习-1" },
      },
      {
        ...STUDENT_PACK,
        question: {
          ...STUDENT_PACK.question,
          answers: { kind: "fill", blanks: [["5"]] },
        },
      },
      {
        ...STUDENT_PACK,
        question: { ...STUDENT_PACK.question, solutionMd: "解析" },
      },
      {
        ...STUDENT_PACK,
        response: {
          ...STUDENT_PACK.response,
          attemptId: "55555555-5555-4555-8555-555555555555",
        },
      },
      {
        ...STUDENT_PACK,
        response: { ...STUDENT_PACK.response, finalCorrect: true },
      },
      {
        ...STUDENT_PACK,
        response: { ...STUDENT_PACK.response, teacherComment: "评语" },
      },
      {
        ...STUDENT_PACK,
        evidence: {
          ...STUDENT_PACK.evidence,
          version: {
            versionId: "33333333-3333-4333-8333-333333333333",
            savedAt: "2026-10-06T00:00:00.000Z",
            strokeCount: 4,
            pointCount: 40,
            paperHeight: 800,
          },
        },
      },
    ];
    for (const [index, sample] of cases.entries()) {
      const result = reviewPackSchema.safeParse(sample);
      expect(
        result.success,
        `第 ${index} 个样本应被拒绝（学生包不得携带教师域字段）`,
      ).toBe(false);
    }
  });

  it("manifest 复用 learningPackManifestSchema：kind 含 question（新增枚举值）", () => {
    expect(reviewPackSchema.parse(STUDENT_PACK).manifest).toEqual(
      learningPackManifestSchema.parse(STUDENT_PACK.manifest),
    );
    // 缺失行复用 v2 manifest 缺失形状（media/evidence-image + reason + refs）
    expect(
      learningPackManifestMissingSchema.parse({
        path: "blobs/media/abc.png",
        kind: "media",
        reason: "媒体文件缺失",
        refs: ["q001"],
      }).kind,
    ).toBe("media");
  });
});

describe("reviewPackPreviewDataSchema（预览响应）", () => {
  it("合法样本往返；complete=false 携带缺失行", () => {
    const data = reviewPackPreviewDataSchema.parse({
      role: "student",
      questionNo: 3,
      questionPresent: true,
      evidenceState: "frozen",
      released: true,
      answersIncluded: false,
      complete: false,
      files: [{ path: "review.md", kind: "review", bytes: 900, refs: [] }],
      missing: [
        {
          path: "evidence/e001-original-02.png",
          kind: "evidence-image",
          reason: "分析图生成失败",
          refs: ["e001"],
        },
      ],
      attachments: [
        {
          path: "evidence/e001-original-01.png",
          kind: "evidence",
          state: "ready",
          bytes: 2048,
          downloadUrl: "/api/student/note-versions/v/images/i.png",
        },
        {
          path: "evidence/e001-original-02.png",
          kind: "evidence",
          state: "missing",
          bytes: 0,
          reason: "分析图生成失败",
        },
      ],
      reviewMd: "# 单题复习包",
    });
    expect(data.complete).toBe(false);
    expect(data.attachments[0]?.downloadUrl).toContain("/api/student/");
  });
});

describe("renderReviewPackPrompt（共享 review.md 提示词基础）", () => {
  const base = {
    role: "student" as const,
    questionNo: 3,
    evidenceState: "frozen",
    released: true,
    answersIncluded: false,
    files: [
      { path: "questions/q001/stem.md", bytes: 120 },
      { path: "evidence/e001-original-01.png", bytes: 2048 },
    ],
    missing: [],
    imageCount: 1,
    graphFigureCount: 0,
    interactionNotes: [],
  };

  it("完整学生包：说明不含参考答案与判定；复制文字明确不含图片", () => {
    const md = renderReviewPackPrompt(base);
    expect(md).toContain("第 3 题");
    expect(md).toContain("不含参考答案");
    // 复制语义红线：文字与图片分开交付，不得提示「文字图片全复制」
    expect(md).toContain("复制文字");
    expect(md).toContain("不含");
    expect(md).not.toMatch(/文字图片全复制|全部复制/);
    expect(md).toContain("不含任何图片");
  });

  it("缺失清单非空：明确材料不完整、不自动声称可诊断", () => {
    const md = renderReviewPackPrompt({
      ...base,
      missing: [
        {
          path: "evidence/e001-original-01.png",
          reason: "分析图生成失败",
        },
      ],
    });
    expect(md).toContain("不完整");
    expect(md).toContain("不要假装看到了图片");
  });

  it("教师包：携带答案时提示仅供核对 + 教师需确认事项；不写入成绩", () => {
    const md = renderReviewPackPrompt({
      ...base,
      role: "teacher",
      answersIncluded: true,
    });
    expect(md).toContain("教师需确认");
    expect(md).toContain("仅供核对");
    expect(md).toContain("不写入成绩");
  });

  it("未公布（released=false）：注明无判定属正常，不推断对错", () => {
    const md = renderReviewPackPrompt({ ...base, released: false });
    expect(md).toContain("尚未公布");
  });

  it("纯文字包（无图片）：不出现图片上传指引", () => {
    const md = renderReviewPackPrompt({
      ...base,
      files: [{ path: "questions/q001/stem.md", bytes: 120 }],
      imageCount: 0,
    });
    expect(md).not.toContain("作为附件上传");
  });

  it("图表参数化导出与交互说明进入数据说明", () => {
    const md = renderReviewPackPrompt({
      ...base,
      graphFigureCount: 2,
      interactionNotes: ["折叠块 1 处（展开状态未记录）"],
    });
    expect(md).toContain("参数化文本说明");
    expect(md).toContain("折叠块 1 处");
  });
});

describe("reviewPackJsonSchema（schema:export 单一来源）", () => {
  it("与 docs/dsl/schema/review-pack.json 产物逐字节一致", () => {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const artifact = readFileSync(
      join(scriptDir, "..", "..", "..", "docs", "dsl", "schema", "review-pack.json"),
      "utf8",
    );
    expect(`${JSON.stringify(reviewPackJsonSchema(), null, 2)}\n`).toBe(
      artifact,
    );
  });
});
