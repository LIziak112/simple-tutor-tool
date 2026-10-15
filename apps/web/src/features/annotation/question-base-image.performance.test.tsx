import { render } from "@testing-library/react";
import type { AttemptQuestionPublic } from "@tutor/contract";
import { toBlob } from "html-to-image";
import { afterEach, expect, it, vi } from "vitest";
import { QuestionSurface } from "@/features/attempt/QuestionSurface";
import { collectFontEmbedCss } from "@/features/notes/rasterize-utils";
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
