import { describe, expect, it } from "vitest";
import {
  annotationSurfaceLayoutSchema,
  annotationUploadMetaSchema,
} from "./annotation.ts";

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
  it("v4 明确整题渲染配置与区域证据，不接受图片控件或未知配置", () => {
    const whole = {
      ...layout,
      renderVersion: 4,
      renderProfile: "whole-question-v1",
      compatibility: {
        version: 1,
        contentSignature: "d".repeat(64),
        blocks: [
          {
            tag: "DIV",
            node: "root",
            x: 0,
            y: 0,
            width: 300.5,
            height: 450.25,
          },
        ],
        fonts: [["sans-serif", "16px", "400", "28px", "normal"]],
        textRects: [],
      },
    };
    expect(annotationSurfaceLayoutSchema.parse(whole)).toEqual(whole);
    for (const change of [
      { controls: [] },
      { compatibility: undefined },
      { renderProfile: undefined },
      { renderProfile: "unknown" },
      { renderVersion: 99 },
    ]) {
      expect(
        annotationSurfaceLayoutSchema.safeParse({ ...whole, ...change })
          .success,
      ).toBe(false);
    }
  });
  it("上传能力只接受已知 v3/v4，缺省继续兼容旧协议", () => {
    const meta = {
      baseRevision: 0,
      mutationId: "11111111-1111-4111-8111-111111111111",
    };
    for (const protocolVersion of [undefined, 3, 4]) {
      expect(
        annotationUploadMetaSchema.safeParse({ ...meta, protocolVersion })
          .success,
      ).toBe(true);
    }
    expect(
      annotationUploadMetaSchema.safeParse({ ...meta, protocolVersion: 99 })
        .success,
    ).toBe(false);
  });
  it("v3 冻结表面只接受有限且不重复的已定位填空槽位", () => {
    const frozen = {
      ...layout,
      renderVersion: 3,
      controls: [
        {
          slotId: "slot-1",
          kind: "text",
          x: 30,
          y: 40,
          width: 112,
          height: 44,
        },
      ],
    };
    expect(annotationSurfaceLayoutSchema.parse(frozen)).toEqual(frozen);
    expect(
      annotationSurfaceLayoutSchema.parse({
        ...frozen,
        controls: [{ ...frozen.controls[0], slotId: "gap.alpha" }],
      }).renderVersion,
    ).toBe(3);
    for (const controls of [
      [],
      [frozen.controls[0], frozen.controls[0]],
      [{ ...frozen.controls[0], x: Infinity }],
      [{ ...frozen.controls[0], x: 290 }],
      [{ ...frozen.controls[0], kind: "unknown" }],
    ]) {
      expect(
        annotationSurfaceLayoutSchema.safeParse({ ...frozen, controls })
          .success,
      ).toBe(false);
    }
    expect(
      annotationSurfaceLayoutSchema.safeParse({
        ...frozen,
        controls: undefined,
      }).success,
    ).toBe(false);
    expect(
      annotationSurfaceLayoutSchema.safeParse({
        ...layout,
        controls: frozen.controls,
      }).success,
    ).toBe(false);
  });
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
