import type { AnnotationBaseRef, AnnotationDoc } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportAnnotationComposite,
  exportAnnotationCompositeSource,
  ongoingAnnotationFilename,
} from "./annotation-composite";

/**
 * T6R.20 标注合成图（annotation-composite）单测：canvas 直绘成功、底图
 * 缺失拒绝（绝不导出孤立的圈）、非 ready/无 URL 前置拒绝、编码产物校验。
 * 依赖注入（图片加载器/编码器）+ canvas 上下文桩（手法同 atrament-adapter
 * 测试；像素一致性属 E2E/真机口径）。
 */

class StubContext {
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 1;
  lineCap = "";
  lineJoin = "";
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  beginPath(): void {}
  moveTo(): void {}
  quadraticCurveTo(): void {}
  closePath(): void {}
  stroke(): void {}
  fillRect(): void {}
  clearRect(): void {}
  save(): void {}
  restore(): void {}
  setTransform(): void {}
  drawImage(): void {}
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
function fakePngBlob(bytes = 128): Blob {
  const arr = new Uint8Array(bytes);
  arr.set(PNG_MAGIC, 0);
  for (let i = 8; i < bytes; i += 1) arr[i] = (i * 31) & 0xff;
  return new Blob([arr], { type: "image/png" });
}

const READY_BASE: AnnotationBaseRef = {
  baseId: "11111111-1111-4111-8111-111111111111",
  state: "ready",
  stale: false,
  pixelWidth: 1440,
  pixelHeight: 900,
  downloadUrl: "/api/student/attempts/a1/annotation-base/b1/image.png",
};

const DOC: AnnotationDoc = {
  version: 1,
  baseWidth: 1440,
  baseHeight: 900,
  strokes: [
    {
      tool: "pen",
      color: "#dc2626",
      weight: 5.76,
      points: [
        { x: 100, y: 100, p: 0.5, t: 0 },
        { x: 200, y: 140, p: 0.5, t: 40 },
      ],
    },
  ],
};

let getContextSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(
      () => new StubContext() as unknown as CanvasRenderingContext2D,
    );
});
afterEach(() => {
  getContextSpy.mockRestore();
});

describe("exportAnnotationComposite（canvas 直绘）", () => {
  it("原位标画导出按原CSS尺寸重放，像素尺寸保持底图尺寸", async () => {
    let size: string[] = [];
    const result = await exportAnnotationCompositeSource(
      {
        downloadUrl: "blob:local",
        pixelWidth: 1440,
        pixelHeight: 900,
        cssWidth: 720,
      },
      DOC,
      {
        loadImage: async () => new Image(),
        encodePng: async (canvas) => {
          size = [
            canvas.style.width,
            canvas.style.height,
            String(canvas.width),
            String(canvas.height),
          ];
          return fakePngBlob();
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(size).toEqual(["720px", "450px", "1440", "900"]);
  });
  it("本机PNG源不需要服务器baseId，尺寸匹配才导出且下载名包含作业题号", async () => {
    const loadImage = vi.fn(async () => new Image());
    const source = {
      downloadUrl: "blob:local",
      pixelWidth: 1440,
      pixelHeight: 900,
    };
    expect(
      (
        await exportAnnotationCompositeSource(source, DOC, {
          loadImage,
          encodePng: async () => fakePngBlob(),
        })
      ).ok,
    ).toBe(true);
    loadImage.mockClear();
    expect(
      (
        await exportAnnotationCompositeSource(
          { ...source, pixelWidth: 900 },
          DOC,
          { loadImage },
        )
      ).ok,
    ).toBe(false);
    expect(loadImage).not.toHaveBeenCalled();
    expect(ongoingAnnotationFilename("练习/六:乘法", 8)).toBe(
      "练习_六_乘法-第8题-标画.png",
    );
  });
  it("成功：底图加载 + drawImage + 笔迹重放 → 单张 PNG", async () => {
    const result = await exportAnnotationComposite(READY_BASE, DOC, {
      loadImage: async () => new Image(),
      encodePng: async () => fakePngBlob(),
    });
    expect(result.ok).toBe(true);
  });

  it("底图加载失败：kind=base-missing、拒绝合成（不导出孤立的圈）", async () => {
    const result = await exportAnnotationComposite(READY_BASE, DOC, {
      loadImage: () => Promise.reject(new Error("404")),
      encodePng: async () => fakePngBlob(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("base-missing");
    expect(result.error.message).toContain("底图");
  });

  it("base 非 ready/无 URL：直接拒绝（不调图片加载）", async () => {
    const loadImage = vi.fn(async () => new Image());
    const result = await exportAnnotationComposite(
      { ...READY_BASE, state: "pending", pixelWidth: null, pixelHeight: null },
      DOC,
      { loadImage, encodePng: async () => fakePngBlob() },
    );
    expect(result.ok).toBe(false);
    expect(loadImage).not.toHaveBeenCalled();
  });

  it("编码产物为空 Blob：kind=encode（PNG 魔数校验已随审查修复 10 删除，原生 toBlob 保证类型）", async () => {
    const result = await exportAnnotationComposite(READY_BASE, DOC, {
      loadImage: async () => new Image(),
      encodePng: async () => new Blob([], { type: "image/png" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("encode");
  });
});
