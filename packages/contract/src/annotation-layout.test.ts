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
