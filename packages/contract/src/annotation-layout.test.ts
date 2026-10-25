import { describe, expect, it } from "vitest";
import { annotationSurfaceLayoutSchema } from "./annotation.ts";

const layout = {
  renderVersion: 2,
  questionRevisionId: "public-revision",
  cssWidth: 300.5,
  cssHeight: 450.25,
  pixelRatio: 2,
  styleVersion: 1,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
};
describe("原位题面布局契约", () => {
  it("可选兼容证据保留旧签名，并限制几何数量、坐标与字体长度", () => {
    const compatibility = {
      version: 1,
      contentSignature: "d".repeat(64),
      blocks: [{ tag: "P", x: 0, y: 0, width: 300, height: 28 }],
      fonts: [["geist variable,sans-serif", "16px", "400", "28px", "normal"]],
      textRects: [{ x: 0, y: 2, width: 100, height: 22 }],
    };
    expect(
      annotationSurfaceLayoutSchema.parse({ ...layout, compatibility }),
    ).toEqual({ ...layout, compatibility });
    for (const change of [
      { version: 2 },
      { blocks: Array(2049).fill(compatibility.blocks[0]) },
      { textRects: [{ x: Infinity, y: 0, width: 1, height: 1 }] },
      { fonts: [["x".repeat(257), "16px", "400", "28px", "normal"]] },
      { fonts: [] },
    ]) {
      expect(
        annotationSurfaceLayoutSchema.safeParse({
          ...layout,
          compatibility: { ...compatibility, ...change },
        }).success,
      ).toBe(false);
    }
  });
  it("接受分数CSS尺寸，但保留固定像素比与版本", () => {
    expect(annotationSurfaceLayoutSchema.parse(layout)).toEqual(layout);
    expect(
      annotationSurfaceLayoutSchema.safeParse({ ...layout, pixelRatio: 3 })
        .success,
    ).toBe(false);
    expect(
      annotationSurfaceLayoutSchema.safeParse({ ...layout, renderVersion: 1 })
        .success,
    ).toBe(false);
  });
  it("拒绝无限值、超限尺寸、秘密hash字段", () => {
    for (const invalid of [
      { cssWidth: Infinity },
      { cssHeight: 2049 },
      { cssWidth: 0 },
      { geometrySignature: "invalid" },
      { snapshotHash: "d".repeat(64) },
    ]) {
      expect(
        annotationSurfaceLayoutSchema.safeParse({ ...layout, ...invalid })
          .success,
      ).toBe(false);
    }
  });
});
