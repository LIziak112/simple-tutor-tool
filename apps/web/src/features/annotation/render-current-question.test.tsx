import type {
  AnnotationSurfaceLayout,
  AttemptQuestionPublic,
} from "@tutor/contract";
import { stableContentHash64 } from "@tutor/contract";
import { toBlob } from "html-to-image";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuestionSurface } from "@/features/answering/QuestionSurface";
import { collectFontEmbedCss } from "@/features/notes/rasterize-utils";
import { render } from "@/test/render-with-portal";
import {
  measureQuestionSurface,
  publicContentSignatureOf,
} from "./question-base-image";
import { renderCurrentQuestionImage } from "./render-current-question";

const ink = vi.hoisted(() => ({
  destroy: vi.fn(),
  replay: vi.fn(),
  encode: vi.fn(),
}));
vi.mock("@/features/ink/engine/atrament-adapter", () => ({
  createProgrammaticAtrament: () => ({ destroy: ink.destroy }),
}));
vi.mock("@/features/ink/engine/canvas-png", () => ({
  canvasToPngBlob: ink.encode,
}));
vi.mock("./annotation-surface", () => ({ replayAnnotationStroke: ink.replay }));
vi.mock("html-to-image", () => ({ toBlob: vi.fn() }));
vi.mock("@/features/notes/rasterize-utils", async (original) => ({
  ...(await original<typeof import("@/features/notes/rasterize-utils")>()),
  collectFontEmbedCss: vi.fn(async () => ""),
  samplePngBlank: vi.fn(async () => false),
}));
const question: AttemptQuestionPublic = {
  id: "q",
  questionRevisionId: "revision",
  type: "fill",
  stemMd: "计算 [[]]",
  difficulty: 1,
  knowledge: [],
  hintCount: 0,
};
function png(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([bytes], { type: "image/png" });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 1;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 300, 200),
  );
  vi.mocked(toBlob).mockImplementation(async (_node, options) =>
    png(Number(options?.width) * 2, Number(options?.height) * 2),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("没有活题面也从公开模型渲染唯一真实填空，并保留本人答案", async () => {
  let captured = "";
  vi.mocked(toBlob).mockImplementationOnce(async (node) => {
    expect(node.style.position).not.toBe("fixed");
    const inputs = node.querySelectorAll("input");
    expect(inputs).toHaveLength(1);
    captured = inputs[0]?.value ?? "";
    return png(1440, 400);
  });
  await renderCurrentQuestionImage(question, {
    answer: { kind: "fill", values: ["测试中文"] },
  });
  expect(captured).toBe("测试中文");
  expect(
    document.querySelector('[data-slot="current-question-export-host"]'),
  ).toBeNull();
});
it("原始 v3 控件只读保留，当前导出使用原生输入和原布局核验", async () => {
  const mounted = render(<QuestionSurface question={question} mode="export" />);
  const reference = mounted.container.querySelector<HTMLElement>(
    '[data-slot="question-surface"]',
  );
  if (!reference) throw new Error("缺少题面");
  const geometry = measureQuestionSurface(reference);
  const layout: AnnotationSurfaceLayout = {
    renderVersion: 3,
    questionRevisionId: "revision",
    cssWidth: 300,
    cssHeight: 200,
    pixelRatio: 2,
    styleVersion: 1,
    contentSignature: "a".repeat(64),
    geometrySignature: "b".repeat(64),
    fontSignature: "c".repeat(64),
    compatibility: {
      version: 1,
      contentSignature: stableContentHash64(publicContentSignatureOf(question)),
      blocks: geometry.blocks,
      fonts: geometry.fonts,
      textRects: geometry.textRects,
    },
    controls: [
      {
        slotId: "old-slot",
        kind: "text",
        x: 10,
        y: 10,
        width: 100,
        height: 44,
      },
    ],
  };
  const original = JSON.stringify(layout);
  vi.mocked(toBlob).mockImplementationOnce(async (node) => {
    expect(node.querySelectorAll("input")).toHaveLength(1);
    expect(node.querySelector("input")?.value).toBe("本人值");
    return png(600, 400);
  });
  await renderCurrentQuestionImage(question, {
    layout,
    reference,
    answer: { kind: "fill", values: ["本人值"] },
  });
  expect(JSON.stringify(layout)).toBe(original);
});
it("不同题目版本不能借当前截图绕过原稿身份", async () => {
  await expect(
    renderCurrentQuestionImage(question, {
      layout: {
        renderVersion: 2,
        questionRevisionId: "different",
        cssWidth: 300,
        cssHeight: 200,
        pixelRatio: 2,
        styleVersion: 1,
        contentSignature: "a".repeat(64),
        geometrySignature: "b".repeat(64),
        fontSignature: "c".repeat(64),
      },
    }),
  ).rejects.toThrow(/版本/);
  expect(toBlob).not.toHaveBeenCalled();
});
it("题面包含答案标记时仍拒绝，不能把当前图入口变成秘密出口", async () => {
  await expect(
    renderCurrentQuestionImage({ ...question, stemMd: "答案 [[秘密值]]" }, {}),
  ).rejects.toThrow(/答案/);
  expect(toBlob).not.toHaveBeenCalled();
});
it("字体处理期间会话失效后不栅格化，并释放副本", async () => {
  let cancelled = false;
  vi.mocked(collectFontEmbedCss).mockImplementationOnce(async () => {
    cancelled = true;
    return "";
  });
  await expect(
    renderCurrentQuestionImage(question, { shouldAbort: () => cancelled }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(toBlob).not.toHaveBeenCalled();
  expect(
    document.querySelector('[data-slot="current-question-export-host"]'),
  ).toBeNull();
});
it("长本人正文完整附在题面之后，公开模型不承载正文", async () => {
  const body = "这是一份完整的本人正文".repeat(12);
  vi.mocked(toBlob).mockImplementationOnce(async (node) => {
    expect(node.textContent).toContain(body);
    expect(
      node.querySelector('[data-slot="question-surface"]')?.textContent,
    ).not.toContain(body);
    return png(1440, 400);
  });
  await renderCurrentQuestionImage(
    { ...question, type: "response", stemMd: "公开写作要求" },
    { answer: { kind: "response", body } },
  );
});
it("已有DOM被隐藏而无法量宽时仍使用默认逻辑宽导出", async () => {
  const hidden = document.createElement("div");
  hidden.getBoundingClientRect = () => new DOMRect();
  await renderCurrentQuestionImage(question, { reference: hidden });
  expect(toBlob).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ width: 720 }),
  );
});
it("分数逻辑高度向上取整输出像素，不因原生canvas取整丢掉末行", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 300, 200.21875),
  );
  vi.mocked(toBlob).mockImplementationOnce(async (_node, options) =>
    png(
      Number(options?.canvasWidth ?? options?.width) * 2,
      Number(options?.canvasHeight ?? options?.height) * 2,
    ),
  );
  await renderCurrentQuestionImage(question);
  expect(toBlob).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ canvasHeight: 200.5 }),
  );
});
it("叠墨沿用原始点和宽度比例，不把附加答案区域变成新稿域", async () => {
  const mounted = render(<QuestionSurface question={question} mode="export" />);
  const reference = mounted.container.querySelector<HTMLElement>(
    '[data-slot="question-surface"]',
  );
  if (!reference) throw new Error("缺少题面");
  const measured = measureQuestionSurface(reference);
  const layout: AnnotationSurfaceLayout = {
    renderVersion: 4,
    renderProfile: "whole-question-v1",
    questionRevisionId: "revision",
    cssWidth: 300,
    cssHeight: 200,
    pixelRatio: 2,
    styleVersion: 1,
    contentSignature: "a".repeat(64),
    geometrySignature: "b".repeat(64),
    fontSignature: "c".repeat(64),
    compatibility: {
      version: 1,
      contentSignature: stableContentHash64(publicContentSignatureOf(question)),
      blocks: measured.blocks,
      fonts: measured.fonts,
      textRects: measured.textRects,
    },
  };
  const stroke = {
    tool: "pen" as const,
    color: "red",
    weight: 3,
    points: [{ x: 20, y: 30, p: 0.5, t: 0 }],
  };
  const doc = {
    version: 1 as const,
    baseWidth: 600,
    baseHeight: 400,
    strokes: [stroke],
  };
  const original = JSON.stringify(doc);
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = async () => {};
    },
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:current");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  ink.encode.mockResolvedValue(png(600, 400));
  await renderCurrentQuestionImage(question, { layout, doc, reference });
  expect(ink.replay).toHaveBeenCalledWith(expect.anything(), 0.5, stroke);
  expect(JSON.stringify(doc)).toBe(original);
  expect(ink.destroy).toHaveBeenCalledOnce();
});
