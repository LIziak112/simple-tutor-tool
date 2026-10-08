import type { AnnotationBasePreviewData } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  ANNOTATION_BASE_MAX_CONTENT_HEIGHT_CSS,
  ANNOTATION_BASE_PAGE_PADDING_CSS,
  ANNOTATION_BASE_WIDTH_CSS,
  ANNOTATION_BASE_WIDTH_PX,
  annotationBaseCanvasPixelSize,
  buildAnnotationBaseSections,
  planAnnotationBaseHeight,
} from "./base-image";

/**
 * T6R.20 底图生成管线——纯函数层测试（版式区块/单页高计划/画布尺寸）：
 * - 参数化口径：无学生答案节/无教师节/单页无分页；宽恒 1440px（720 CSS×2）；
 *   内容高上限 1976 CSS（4096 像素高上限推导），超限返回显式禁用原因；
 * - 学生红线（纵深防御第二道，同 T6R.19 口径）：题面含答案标记/教师节标记
 *   → 拒绝生成（forbidden）。
 * DOM 栅格化适配器层（注入依赖）见 base-image-dom.test.ts。
 */

/** 学生装配载荷夹具（契约 AnnotationBasePreviewData 形状） */
function previewOf(overrides: Partial<AnnotationBasePreviewData> = {}): AnnotationBasePreviewData {
  return {
    base: {
      baseId: "11111111-1111-4111-8111-111111111111",
      state: "pending",
      stale: false,
      pixelWidth: null,
      pixelHeight: null,
    },
    baseRenderVersion: 1,
    maxWidthPx: 1440,
    questionRevisionId: "b-00000000-0000-4000-8000-000000000001",
    questionNo: 3,
    questionMd: "### 题目\n\n已知 $x+1=4$，求 $x$。\n\n- A. $2$\n- B. $3$\n",
    mediaSrcs: [],
    graphFigures: [],
    interactionNotes: [],
    ...overrides,
  } as AnnotationBasePreviewData;
}

describe("底图常量（宽 1440×高上限 4096 的 CSS 推导）", () => {
  it("宽恒 1440 像素 = 720 CSS × 像素比 2（契约 ANNOTATION_BASE_WIDTH_PX 单源）", () => {
    expect(ANNOTATION_BASE_WIDTH_PX).toBe(1440);
    expect(ANNOTATION_BASE_WIDTH_CSS).toBe(720);
  });

  it("内容高上限 1976 CSS = 4096/2 − 上下留白 36×2（推导不抄数）", () => {
    expect(ANNOTATION_BASE_PAGE_PADDING_CSS).toBe(36);
    expect(ANNOTATION_BASE_MAX_CONTENT_HEIGHT_CSS).toBe(1976);
  });
});

describe("buildAnnotationBaseSections（版式区块：参数化差异）", () => {
  it("页眉含题号与「题干标注底图」标识；正文为题面 markdown；无学生答案节/教师节", () => {
    const sections = buildAnnotationBaseSections(previewOf(), { now: new Date(0) });
    expect(sections.length).toBe(2);
    const header = sections[0];
    expect(header?.kind).toBe("header");
    if (header?.kind !== "header") return;
    expect(header.questionNo).toBe(3);
    expect(header.title).toContain("第 3 题");
    expect(header.note).toContain("不含参考答案");
    const markdown = sections[1];
    expect(markdown?.kind).toBe("markdown");
    if (markdown?.kind !== "markdown") return;
    expect(markdown.md).toContain("x+1=4");
    expect(markdown.md).not.toContain("学生答案");
    expect(markdown.md).not.toContain("**参考答案**");
  });

  it("生成时间文案固定 Asia/Shanghai 口径（CI=UTC 不漂移）", () => {
    const sections = buildAnnotationBaseSections(previewOf(), {
      now: new Date("2026-10-08T04:05:00Z"),
    });
    const header = sections[0];
    if (header?.kind !== "header") throw new Error("首块应为页眉");
    expect(header.generatedAtText).toBe("2026年10月8日 12:05");
  });

  it("题面为空时仍产页眉（空底图防御在 DOM 层；纯层如实建模）", () => {
    const sections = buildAnnotationBaseSections(
      previewOf({ questionMd: "  " }),
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]?.kind).toBe("header");
  });

  it("学生红线：题面含 [[答案]] 标记 → 抛错拒绝（不进版式模型）", () => {
    expect(() =>
      buildAnnotationBaseSections(previewOf({ questionMd: "填空：x=[[二]]。" })),
    ).toThrow(/答案标记/);
  });

  it("学生红线：题面混入教师节标记 → 抛错拒绝", () => {
    expect(() =>
      buildAnnotationBaseSections(
        previewOf({ questionMd: "题面。\n\n**参考答案**：B\n" }),
      ),
    ).toThrow(/教师域/);
  });
});

describe("planAnnotationBaseHeight（单页无分页）", () => {
  it("总高 ≤ 上限：单页计划成功（内容高=块高之和）", () => {
    const plan = planAnnotationBaseHeight([
      { id: "b0", heightPx: 300 },
      { id: "b1", heightPx: 500 },
    ]);
    expect(plan).toEqual({ ok: true, contentHeightCss: 800 });
  });

  it("总高超上限：显式禁用原因（含上限值与「标注」字样），不产出页计划", () => {
    const plan = planAnnotationBaseHeight([
      { id: "b0", heightPx: ANNOTATION_BASE_MAX_CONTENT_HEIGHT_CSS + 1 },
    ]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain(String(ANNOTATION_BASE_MAX_CONTENT_HEIGHT_CSS));
    expect(plan.reason).toContain("标注");
    expect(plan.reason).toContain("草稿");
  });
});

describe("annotationBaseCanvasPixelSize（画布像素预算）", () => {
  it("宽恒 1440；高 =（内容高＋上下留白）×2 向上取整", () => {
    expect(annotationBaseCanvasPixelSize(800)).toEqual({
      width: 1440,
      height: Math.ceil((800 + 72) * 2),
    });
  });

  it("内容高超上限（防御：plan 已拦截，此处兜底）→ 抛中文错误", () => {
    expect(() =>
      annotationBaseCanvasPixelSize(ANNOTATION_BASE_MAX_CONTENT_HEIGHT_CSS + 10),
    ).toThrow(/4096|超高/);
  });
});
