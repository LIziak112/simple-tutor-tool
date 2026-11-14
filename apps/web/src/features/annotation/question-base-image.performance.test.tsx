import type { AttemptQuestionPublic } from "@tutor/contract";
import { toBlob } from "html-to-image";
import { afterEach, expect, it, vi } from "vitest";
import { QuestionSurface } from "@/features/answering/QuestionSurface";
import { collectFontEmbedCss } from "@/features/notes/rasterize-utils";
import { render } from "@/test/render-with-portal";
import {
  awaitQuestionSurfaceReady,
  renderQuestionBaseImage,
} from "./question-base-image";

vi.mock("html-to-image", () => ({
  toBlob: vi.fn(async () => {
    const bytes = new Uint8Array(24);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const header = new DataView(bytes.buffer);
    header.setUint32(16, 600);
    header.setUint32(20, 400);
    return new Blob([bytes], { type: "image/png" });
  }),
}));
vi.mock("@/features/notes/rasterize-utils", async (original) => ({
  ...(await original<typeof import("@/features/notes/rasterize-utils")>()),
  collectFontEmbedCss: vi.fn(async () => ""),
  samplePngBlank: vi.fn(async () => false),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function frames() {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 1;
  });
}
it("布局稳定等待返回最后一帧快照，保留连续稳定检查", async () => {
  frames();
  const surface = document.createElement("div");
  const read = vi
    .spyOn(surface, "getBoundingClientRect")
    .mockReturnValueOnce(new DOMRect(0, 0, 290, 200))
    .mockReturnValue(new DOMRect(0, 0, 300, 200));
  const snapshot = await awaitQuestionSurfaceReady(surface);
  expect(snapshot.cssWidth).toBe(300);
  expect(read).toHaveBeenCalledTimes(5);
});
function mountedSurface() {
  frames();
  const style = document.createElement("div").style;
  for (const [key, value] of Object.entries({
    "font-family": "sans-serif",
    "font-size": "16px",
    "font-weight": "400",
    "line-height": "24px",
    "letter-spacing": "0px",
  }))
    style.setProperty(key, value);
  vi.spyOn(window, "getComputedStyle").mockReturnValue(style);
  const read = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 300, 200));
  const question: AttemptQuestionPublic = {
    id: "q",
    questionRevisionId: "11111111-1111-4111-8111-111111111111",
    type: "solve",
    stemMd: "公开题面",
    difficulty: 1,
    knowledge: [],
    hintCount: 0,
  };
  const view = render(<QuestionSurface question={question} mode="export" />);
  const reference = view.container.querySelector<HTMLElement>(
    '[data-slot="question-surface"]',
  );
  if (!reference) throw new Error("题面未挂载");
  return { read, question, reference };
}
it("底图复用稳定快照减少两次即时重复测量，保留最终真实题面检查", async () => {
  const { read, question, reference } = mountedSurface();
  await renderQuestionBaseImage(question, reference);
  expect(read.mock.contexts.filter((node) => node === reference)).toHaveLength(
    7,
  );
});
it("新底图使用 v4 整题协议，不生产图片控件清单", async () => {
  const { question, reference } = mountedSurface();
  const result = await renderQuestionBaseImage(question, reference);
  expect(result.layout).toMatchObject({
    renderVersion: 4,
    renderProfile: "whole-question-v1",
  });
  expect(result.layout).not.toHaveProperty("controls");
});
it("字体处理后发生取消时不再栅格化，并释放导出副本", async () => {
  const { question, reference } = mountedSurface();
  const controller = new AbortController();
  vi.mocked(toBlob).mockClear();
  vi.mocked(collectFontEmbedCss).mockImplementationOnce(async () => {
    controller.abort();
    return "";
  });
  await expect(
    renderQuestionBaseImage(question, reference, { signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(toBlob).not.toHaveBeenCalled();
  expect(document.querySelector('[data-slot="question-base-host"]')).toBeNull();
});
it("生成期间题面变化仍拒绝采用，不能以稳定快照跳过最终校验", async () => {
  const { read, question, reference } = mountedSurface();
  vi.mocked(collectFontEmbedCss).mockImplementationOnce(async () => {
    read.mockImplementation(function (this: HTMLElement) {
      return this === reference
        ? new DOMRect(0, 0, 310, 200)
        : new DOMRect(0, 0, 300, 200);
    });
    return "";
  });
  await expect(renderQuestionBaseImage(question, reference)).rejects.toThrow(
    "生成期间题面布局变化",
  );
});

it("排序题真实采集的公开节点通过布局契约", async () => {
  const { reference } = mountedSurface();
  const question: AttemptQuestionPublic = {
    id: "ordering",
    questionRevisionId: "11111111-1111-4111-8111-111111111111",
    type: "ordering",
    stemMd: "排序",
    difficulty: 1,
    knowledge: [],
    hintCount: 0,
    orderingItems: [
      { id: "it-1", text: "甲", fixedPosition: null },
      { id: "it-2", text: "乙", fixedPosition: null },
    ],
    sortableCount: 2,
  };
  const view = render(<QuestionSurface question={question} mode="export" />);
  const surface = view.container.querySelector<HTMLElement>(
    '[data-slot="question-surface"]',
  );
  if (!surface) throw new Error("题面未挂载");
  expect(reference).toBeDefined();
  const result = await renderQuestionBaseImage(question, surface);
  expect(
    result.layout.compatibility?.blocks.some(
      (block) => block.node === "options/item/0",
    ),
  ).toBe(true);
});

it("资源永久挂起时按时超时，取消时立即退出且迟到完成无效", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: pending },
  });
  const surface = document.createElement("div");
  const controller = new AbortController();
  const aborted = awaitQuestionSurfaceReady(
    surface,
    () => {},
    controller.signal,
  );
  controller.abort();
  await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
  finish();
  const never = new Promise<void>(() => {});
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: never },
  });
  const timed = awaitQuestionSurfaceReady(surface);
  const assertion = expect(timed).rejects.toThrow("超时");
  await vi.advanceTimersByTimeAsync(15_000);
  await assertion;
  Reflect.deleteProperty(document, "fonts");
  vi.useRealTimers();
});

it("配图解码挂起时仍可取消且不会继续测量", async () => {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  const surface = document.createElement("div");
  const image = document.createElement("img");
  image.loading = "lazy";
  let finish!: () => void;
  image.decode = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  surface.append(image);
  const controller = new AbortController();
  const result = awaitQuestionSurfaceReady(
    surface,
    () => {},
    controller.signal,
  );
  await Promise.resolve();
  expect(image.loading).toBe("eager");
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  finish();
  await Promise.resolve();
  Reflect.deleteProperty(document, "fonts");
});

it("旧排序按真实候选 DOM 的证据选择横排，均不符时保稿", async () => {
  const { question: base } = mountedSurface();
  const question: AttemptQuestionPublic = {
    ...base,
    type: "ordering",
    stemMd: "排序",
    orderingItems: [
      { id: "a", text: "甲", fixedPosition: null },
      { id: "b", text: "乙", fixedPosition: null },
    ],
    sortableCount: 2,
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const vertical = this.closest("li.flex-col") !== null;
      return new DOMRect(
        0,
        vertical && this.tagName === "P" ? 30 : 0,
        430,
        200,
      );
    },
  );
  const { QuestionRenderContext } = await import(
    "@/features/answering/question-render-context"
  );
  const {
    measureQuestionSurface,
    publicContentSignatureOf,
    resolveLegacyQuestionProfile,
  } = await import("./question-base-image");
  const { stableContentHash64 } = await import("@/lib/content-hash");
  const view = render(
    <QuestionRenderContext
      value={{ renderVersion: 2, legacyDirection: "horizontal" }}
    >
      <QuestionSurface question={question} mode="export" />
    </QuestionRenderContext>,
  );
  const surface = view.container.querySelector<HTMLElement>(
    '[data-slot="question-surface"]',
  );
  if (!surface) throw new Error("题面未挂载");
  const measured = measureQuestionSurface(surface);
  const layout = {
    renderVersion: 2 as const,
    styleVersion: 1 as const,
    questionRevisionId: question.questionRevisionId,
    cssWidth: 430,
    cssHeight: 200,
    pixelRatio: 2 as const,
    contentSignature: "a".repeat(64),
    geometrySignature: "b".repeat(64),
    fontSignature: "c".repeat(64),
    compatibility: {
      version: 1 as const,
      contentSignature: stableContentHash64(publicContentSignatureOf(question)),
      blocks: measured.blocks,
      fonts: measured.fonts,
      textRects: measured.textRects,
    },
  };
  await expect(
    resolveLegacyQuestionProfile(question, surface, layout),
  ).resolves.toBe("horizontal");
  const { compatibility: _compatibility, ...baseLayout } = layout;
  const hashLayout = {
    ...baseLayout,
    contentSignature: stableContentHash64({
      type: question.type,
      stemMd: question.stemMd,
      options: question.options ?? [],
    }),
    geometrySignature: stableContentHash64(
      measured.blocks.map(({ node: _node, ...block }) => block),
    ),
    fontSignature: stableContentHash64(measured.fonts),
  };
  await expect(
    resolveLegacyQuestionProfile(question, surface, hashLayout),
  ).resolves.toBe("horizontal");
  await expect(
    resolveLegacyQuestionProfile(question, surface, {
      ...layout,
      cssHeight: 300,
    }),
  ).resolves.toBeNull();
});
