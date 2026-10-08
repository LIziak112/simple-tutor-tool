import { describe, expect, it } from "vitest";
import {
  ANNOTATION_BASE_IMAGE_FORM_FIELDS,
  ANNOTATION_BASE_MAX_HEIGHT_PX,
  ANNOTATION_BASE_PNG_MAX_BYTES,
  ANNOTATION_BASE_RENDER_VERSION,
  ANNOTATION_BASE_WIDTH_PX,
  ANNOTATION_BODY_DECOMPRESSED_MAX_BYTES,
  ANNOTATION_BODY_GZIP_MAX_BYTES,
  ANNOTATION_FORM_FIELDS,
  ANNOTATION_MAX_PIXEL_DIM,
  ANNOTATION_MAX_POINTS_PER_STROKE,
  ANNOTATION_MAX_STROKES,
  ANNOTATION_MAX_TOTAL_POINTS,
  annotationBaseImageMetaSchema,
  annotationBaseImageReceiptSchema,
  annotationBasePreviewDataSchema,
  annotationBaseRefSchema,
  annotationBaseStateSchema,
  annotationConflictCurrentSchema,
  annotationDocSchema,
  annotationErrorCodeSchema,
  annotationGraphFigureSchema,
  annotationIssueIsLimit,
  annotationPhaseSchema,
  annotationReceiptSchema,
  annotationSealRequestSchema,
  annotationUploadMetaSchema,
  annotationViewDataSchema,
} from "./annotation.ts";

/**
 * 题干标注契约自测（T6R.20）：锁定 AnnotationDoc v1 形状（坐标域=底图像素
 * 坐标）、上传协议（CAS+mutationId）、底图引用/预览/视图形状的一致性规则、
 * 限额常量与错误码。对照 plan.md「代理 A」文件清单第 1 项。
 */

const P0 = { x: 12, y: 34, p: 0.5, t: 0 };
const P1 = { x: 56, y: 78, p: 0.8, t: 25 };

/** 最小合法 AnnotationDoc（底图 1440×900、单笔两点） */
function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    baseWidth: ANNOTATION_BASE_WIDTH_PX,
    baseHeight: 900,
    strokes: [{ tool: "pen", color: "#c0392b", weight: 6, points: [P0, P1] }],
    ...overrides,
  };
}

/** 底图引用的最小合法形态 */
function baseRef(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    baseId: "0b0b0b0b-1111-4111-8111-0b0b0b0b0b0b",
    state: "ready",
    stale: false,
    pixelWidth: ANNOTATION_BASE_WIDTH_PX,
    pixelHeight: 900,
    ...overrides,
  };
}

describe("常量锁定（暂定值；真机定标后修订须同步改测试锁定值）", () => {
  it("底图渲染版本与几何常量", () => {
    expect(ANNOTATION_BASE_RENDER_VERSION).toBe(1);
    expect(ANNOTATION_BASE_WIDTH_PX).toBe(1440);
    expect(ANNOTATION_BASE_MAX_HEIGHT_PX).toBe(4096);
    expect(ANNOTATION_MAX_PIXEL_DIM).toBe(4096);
  });

  it("限额常量为独立命名（不与 NOTE_*/INK_* 互改）", () => {
    expect(ANNOTATION_BASE_PNG_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(ANNOTATION_BODY_GZIP_MAX_BYTES).toBe(1024 * 1024);
    expect(ANNOTATION_BODY_DECOMPRESSED_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(ANNOTATION_MAX_STROKES).toBe(200);
    expect(ANNOTATION_MAX_POINTS_PER_STROKE).toBe(2000);
    expect(ANNOTATION_MAX_TOTAL_POINTS).toBe(40_000);
  });
});

describe("annotationPhaseSchema / annotationBaseStateSchema", () => {
  it("phase 只认 scratch|correction（标注无 supplement——记录级隔离只有两态）", () => {
    expect(annotationPhaseSchema.safeParse("scratch").success).toBe(true);
    expect(annotationPhaseSchema.safeParse("correction").success).toBe(true);
    expect(annotationPhaseSchema.safeParse("supplement").success).toBe(false);
  });

  it("底图状态三值", () => {
    for (const state of ["pending", "ready", "failed"]) {
      expect(annotationBaseStateSchema.safeParse(state).success).toBe(true);
    }
    expect(annotationBaseStateSchema.safeParse("missing").success).toBe(false);
  });
});

describe("annotationDocSchema", () => {
  it("最小合法文档通过；version≠1 拒绝", () => {
    expect(annotationDocSchema.safeParse(doc()).success).toBe(true);
    expect(annotationDocSchema.safeParse(doc({ version: 2 })).success).toBe(
      false,
    );
  });

  it("baseWidth/baseHeight 边界：1..ANNOTATION_MAX_PIXEL_DIM 整数", () => {
    expect(annotationDocSchema.safeParse(doc({ baseWidth: 0 })).success).toBe(
      false,
    );
    expect(
      annotationDocSchema.safeParse(doc({ baseHeight: 4097 })).success,
    ).toBe(false);
    expect(
      annotationDocSchema.safeParse(doc({ baseWidth: 1440.5 })).success,
    ).toBe(false);
    expect(
      annotationDocSchema.safeParse(doc({ baseHeight: 4096 })).success,
    ).toBe(true);
  });

  it("坐标域=底图像素坐标：越 baseWidth/baseHeight、负值、非有限数拒绝", () => {
    expect(
      annotationDocSchema.safeParse(
        doc({
          strokes: [
            {
              tool: "pen",
              color: "#000",
              weight: 4,
              points: [{ ...P0, x: 1440.5 }],
            },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      annotationDocSchema.safeParse(
        doc({
          strokes: [
            {
              tool: "pen",
              color: "#000",
              weight: 4,
              points: [{ ...P0, y: 901 }],
            },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      annotationDocSchema.safeParse(
        doc({
          strokes: [
            {
              tool: "pen",
              color: "#000",
              weight: 4,
              points: [{ ...P0, x: -1 }],
            },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      annotationDocSchema.safeParse(
        doc({
          strokes: [
            {
              tool: "pen",
              color: "#000",
              weight: 4,
              points: [{ ...P0, x: Number.NaN }],
            },
          ],
        }),
      ).success,
    ).toBe(false);
    // 恰在边界上合法（0 与 baseWidth/baseHeight 本身）
    expect(
      annotationDocSchema.safeParse(
        doc({
          strokes: [
            {
              tool: "pen",
              color: "#000",
              weight: 4,
              points: [
                { ...P0, x: 0, y: 0 },
                { ...P1, x: 1440, y: 900 },
              ],
            },
          ],
        }),
      ).success,
    ).toBe(true);
  });

  it("点数限额：单笔超限/全稿超限携带 params.limit 结构标记（413 分级依据）", () => {
    const manyPoints = Array.from({ length: 2001 }, (_, i) => ({
      ...P0,
      x: (i % 1000) + 0.5,
    }));
    const strokeLimit = annotationDocSchema.safeParse(
      doc({
        strokes: [
          { tool: "pen", color: "#000", weight: 4, points: manyPoints },
        ],
      }),
    );
    expect(strokeLimit.success).toBe(false);
    if (!strokeLimit.success) {
      expect(
        strokeLimit.error.issues.some((issue) => annotationIssueIsLimit(issue)),
      ).toBe(true);
    }

    const strokes = Array.from({ length: 201 }, (_, i) => ({
      tool: "pen" as const,
      color: "#000",
      weight: 4,
      points: [{ ...P0, x: (i % 1000) + 0.5 }],
    }));
    const strokeCountLimit = annotationDocSchema.safeParse(doc({ strokes }));
    expect(strokeCountLimit.success).toBe(false);
    if (!strokeCountLimit.success) {
      expect(
        strokeCountLimit.error.issues.some((issue) =>
          annotationIssueIsLimit(issue),
        ),
      ).toBe(true);
    }

    // 形状错误（非限额）不带标记
    const shapeBad = annotationDocSchema.safeParse(doc({ strokes: "x" }));
    expect(shapeBad.success).toBe(false);
    if (!shapeBad.success) {
      expect(
        shapeBad.error.issues.some((issue) => annotationIssueIsLimit(issue)),
      ).toBe(false);
    }
  });
});

describe("annotationUploadMetaSchema / seal 请求", () => {
  it("baseRevision 0 起、mutationId uuid、phase 缺省 scratch", () => {
    const parsed = annotationUploadMetaSchema.parse({
      baseRevision: 0,
      mutationId: "1c1c1c1c-2222-4222-8222-1c1c1c1c1c1c",
    });
    expect(parsed.phase).toBe("scratch");
    expect(
      annotationUploadMetaSchema.safeParse({
        baseRevision: -1,
        mutationId: "1c1c1c1c-2222-4222-8222-1c1c1c1c1c1c",
      }).success,
    ).toBe(false);
    expect(
      annotationUploadMetaSchema.safeParse({
        baseRevision: 0,
        mutationId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      annotationUploadMetaSchema.safeParse({
        baseRevision: 0,
        mutationId: "1c1c1c1c-2222-4222-8222-1c1c1c1c1c1c",
        phase: "supplement",
      }).success,
    ).toBe(false);
  });

  it("seal 请求 phase 缺省 scratch", () => {
    expect(annotationSealRequestSchema.parse({}).phase).toBe("scratch");
    expect(
      annotationSealRequestSchema.parse({ phase: "correction" }).phase,
    ).toBe("correction");
  });
});

describe("annotationBaseRefSchema 状态一致性", () => {
  it("ready 必须携带像素宽高；非 ready 不得携带；downloadUrl 仅 ready", () => {
    expect(
      annotationBaseRefSchema.safeParse(
        baseRef({ pixelWidth: null, pixelHeight: null }),
      ).success,
    ).toBe(false);
    expect(
      annotationBaseRefSchema.safeParse(baseRef({ state: "pending" })).success,
    ).toBe(false); // pending 却带宽高
    expect(
      annotationBaseRefSchema.safeParse(
        baseRef({ state: "pending", pixelWidth: null, pixelHeight: null }),
      ).success,
    ).toBe(true);
    expect(
      annotationBaseRefSchema.safeParse(
        baseRef({
          state: "pending",
          pixelWidth: null,
          pixelHeight: null,
          downloadUrl: "/x.png",
        }),
      ).success,
    ).toBe(false);
    expect(
      annotationBaseRefSchema.safeParse(
        baseRef({ downloadUrl: "/api/x/image.png" }),
      ).success,
    ).toBe(true);
  });
});

describe("annotationBasePreviewDataSchema", () => {
  it("完整形态通过且未知键被 strip（fail closed 白名单投影口径）", () => {
    const parsed = annotationBasePreviewDataSchema.parse({
      base: baseRef({
        downloadUrl: "/api/student/attempts/a/annotation-base/b/image.png",
      }),
      baseRenderVersion: 1,
      maxWidthPx: 1440,
      questionRevisionId: "resp-row-id-1",
      questionNo: 3,
      questionMd: "计算 $1+1$，填在括号里：[[[]]]\n\n- A. 1\n- B. 2",
      mediaSrcs: ["media/abcdef.png"],
      graphFigures: [{ fn: "x^2", range: "[-2,2]" }],
      interactionNotes: ["【交互内容静态导出】交互状态未记录。"],
      // 教师域多余键：必须被剥掉/拒绝，不进学生载荷
      answers: { kind: "final", answer: "42" },
      snapshotHash: "deadbeef",
    });
    expect(parsed.base.state).toBe("ready");
    expect(parsed.maxWidthPx).toBe(1440);
    expect(parsed.baseRenderVersion).toBe(1);
    expect("answers" in parsed).toBe(false);
    expect("snapshotHash" in parsed).toBe(false);
  });

  it("graphFigures 形状：fn 必填、range 可选", () => {
    expect(
      annotationGraphFigureSchema.safeParse({ fn: "sin(x)" }).success,
    ).toBe(true);
    expect(
      annotationGraphFigureSchema.safeParse({ range: "[-1,1]" }).success,
    ).toBe(false);
  });
});

describe("annotationViewDataSchema", () => {
  const annotationMeta = {
    annotationId: "2d2d2d2d-3333-4333-8333-2d2d2d2d2d2d",
    revision: 2,
    hash: "a".repeat(64),
    savedAt: "2026-10-08T00:00:00.000Z",
    sealedAt: null,
    strokeCount: 1,
    pointCount: 2,
  };

  it("空态（base/doc/annotation 全 null——该题从未建过底图）合法", () => {
    expect(
      annotationViewDataSchema.safeParse({
        base: null,
        maxWidthPx: 1440,
        doc: null,
        annotation: null,
      }).success,
    ).toBe(true);
  });

  it("有标注必有底图（base null 而 doc 非 null 拒绝）", () => {
    expect(
      annotationViewDataSchema.safeParse({
        base: null,
        maxWidthPx: 1440,
        doc: doc(),
        annotation: annotationMeta,
      }).success,
    ).toBe(false);
  });

  it("doc 与 annotation 必须同时为空或同时非空", () => {
    expect(
      annotationViewDataSchema.safeParse({
        base: baseRef(),
        maxWidthPx: 1440,
        doc: doc(),
        annotation: null,
      }).success,
    ).toBe(false);
    expect(
      annotationViewDataSchema.safeParse({
        base: baseRef(),
        maxWidthPx: 1440,
        doc: null,
        annotation: annotationMeta,
      }).success,
    ).toBe(false);
  });

  it("完整形态合法（含已封存标注）", () => {
    expect(
      annotationViewDataSchema.safeParse({
        base: baseRef(),
        maxWidthPx: 1440,
        doc: doc(),
        annotation: { ...annotationMeta, sealedAt: "2026-10-08T01:00:00.000Z" },
      }).success,
    ).toBe(true);
  });
});

describe("回执与冲突摘要形状", () => {
  it("annotationBaseImageMetaSchema：回传身份三字段", () => {
    expect(
      annotationBaseImageMetaSchema.safeParse({
        questionRevisionId: "resp-row-1",
        baseRenderVersion: 1,
        phase: "correction",
      }).success,
    ).toBe(true);
    expect(
      annotationBaseImageMetaSchema.safeParse({
        questionRevisionId: "",
        baseRenderVersion: 1,
        phase: "scratch",
      }).success,
    ).toBe(false);
  });

  it("annotationReceiptSchema", () => {
    expect(
      annotationReceiptSchema.safeParse({
        annotationId: "2d2d2d2d-3333-4333-8333-2d2d2d2d2d2d",
        revision: 1,
        hash: "b".repeat(64),
        savedAt: "2026-10-08T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      annotationReceiptSchema.safeParse({
        annotationId: "2d2d2d2d-3333-4333-8333-2d2d2d2d2d2d",
        revision: 0,
        hash: "b".repeat(64),
        savedAt: "2026-10-08T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("annotationBaseImageReceiptSchema：ready 恒带宽高与 hash", () => {
    expect(
      annotationBaseImageReceiptSchema.safeParse({
        baseId: "0b0b0b0b-1111-4111-8111-0b0b0b0b0b0b",
        state: "ready",
        imageHash: "c".repeat(64),
        pixelWidth: 1440,
        pixelHeight: 900,
        updatedAt: "2026-10-08T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      annotationBaseImageReceiptSchema.safeParse({
        baseId: "0b0b0b0b-1111-4111-8111-0b0b0b0b0b0b",
        state: "pending",
        imageHash: "c".repeat(64),
        pixelWidth: 1440,
        pixelHeight: 900,
        updatedAt: "2026-10-08T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("annotationConflictCurrentSchema：无 head 全空形态", () => {
    expect(
      annotationConflictCurrentSchema.parse({
        annotationId: null,
        revision: 0,
        hash: null,
        savedAt: null,
      }).revision,
    ).toBe(0);
  });
});

describe("错误码与 multipart 字段名单一来源", () => {
  it("annotationErrorCodeSchema 值域锁定", () => {
    const codes = annotationErrorCodeSchema.options;
    for (const code of [
      "ANNOTATION_NOT_FOUND",
      "ANNOTATION_VALIDATION_FAILED",
      "ANNOTATION_LIMIT_EXCEEDED",
      "ANNOTATION_REVISION_CONFLICT",
      "ANNOTATION_MUTATION_MISMATCH",
      "ANNOTATION_BASE_NOT_READY",
      "ANNOTATION_BASE_IMAGE_INVALID",
      "ANNOTATION_BASE_ALREADY_READY",
      "ANNOTATION_BASE_STALE",
      "ANNOTATION_SEALED",
      "ANNOTATION_NOT_SUBMITTED",
    ]) {
      expect(codes).toContain(code);
    }
    for (const code of [
      "ATTEMPT_NOT_FOUND",
      "QUESTION_NOT_FOUND",
      "FORBIDDEN",
      "ALREADY_SUBMITTED",
      "UNAUTHORIZED",
      "VALIDATION_ERROR",
    ]) {
      expect(codes).toContain(code);
    }
  });

  it("两套 multipart 字段名常量", () => {
    expect(ANNOTATION_FORM_FIELDS).toEqual({
      body: "body",
      baseRevision: "baseRevision",
      mutationId: "mutationId",
      phase: "phase",
    });
    expect(ANNOTATION_BASE_IMAGE_FORM_FIELDS).toEqual({
      image: "image",
      questionRevisionId: "questionRevisionId",
      baseRenderVersion: "baseRenderVersion",
      phase: "phase",
    });
  });
});
