import { describe, expect, it } from "vitest";
import {
  boundsOverlap,
  expandBounds,
  pixelRectOf,
  repaintRect,
  repaintRegion,
} from "./region-redraw.ts";
import type { InkStroke } from "./types.ts";

describe("局部重画：区域换算", () => {
  it("坐标域里的区域换成位图像素矩形：向外取整，夹在画布内", () => {
    const canvas = { width: 800, height: 600 };
    // 每单位 0.8 像素：12.3→9.84、40.6→32.48
    expect(
      pixelRectOf(
        { minX: 12.3, minY: 12.3, maxX: 40.6, maxY: 40.6 },
        0.8,
        canvas,
      ),
    ).toEqual({ x: 9, y: 9, width: 24, height: 24 });
    // 伸出画布的部分截掉
    expect(
      pixelRectOf({ minX: -50, minY: 700, maxX: 2000, maxY: 760 }, 0.8, canvas),
    ).toEqual({ x: 0, y: 560, width: 800, height: 40 });
  });

  it("整块落在画布外，或换算比例不是正数：没有可画的矩形", () => {
    const canvas = { width: 800, height: 600 };
    expect(
      pixelRectOf({ minX: 1100, minY: 0, maxX: 1200, maxY: 10 }, 0.8, canvas),
    ).toBeNull();
    expect(
      pixelRectOf({ minX: 0, minY: -30, maxX: 10, maxY: -1 }, 0.8, canvas),
    ).toBeNull();
    expect(
      pixelRectOf({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0, canvas),
    ).toBeNull();
    expect(
      pixelRectOf({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, Number.NaN, canvas),
    ).toBeNull();
  });

  it("外扩与相交判断（贴边算相交）", () => {
    const box = { minX: 10, minY: 20, maxX: 30, maxY: 40 };
    expect(expandBounds(box, 5)).toEqual({
      minX: 5,
      minY: 15,
      maxX: 35,
      maxY: 45,
    });
    expect(boundsOverlap(box, { minX: 30, minY: 40, maxX: 50, maxY: 60 })).toBe(
      true,
    );
    expect(boundsOverlap(box, { minX: 31, minY: 0, maxX: 50, maxY: 60 })).toBe(
      false,
    );
    expect(boundsOverlap(box, { minX: 0, minY: 41, maxX: 50, maxY: 60 })).toBe(
      false,
    );
  });
});

describe("局部重画：只动矩形里的像素", () => {
  /** 记录调用顺序的 2d 上下文替身 */
  function recorder() {
    const calls: string[] = [];
    const log =
      (name: string) =>
      (...args: number[]) => {
        calls.push(`${name}(${args.join(",")})`);
      };
    const context = {
      save: log("save"),
      restore: log("restore"),
      setTransform: log("setTransform"),
      beginPath: log("beginPath"),
      rect: log("rect"),
      clip: log("clip"),
      clearRect: log("clearRect"),
    } as unknown as CanvasRenderingContext2D;
    return { calls, context };
  }

  it("先按像素对齐的矩形设裁剪区并清空，再画，最后恢复画笔状态", () => {
    const { calls, context } = recorder();
    repaintRect(context, { x: 9, y: 9, width: 24, height: 24 }, () => {
      calls.push("paint");
    });
    expect(calls).toEqual([
      "save()",
      "setTransform(1,0,0,1,0,0)",
      "beginPath()",
      "rect(9,9,24,24)",
      "clip()",
      "clearRect(9,9,24,24)",
      "paint",
      "restore()",
    ]);
  });

  it("画的过程抛错也恢复画笔状态（裁剪区不能留在画布上）", () => {
    const { calls, context } = recorder();
    expect(() =>
      repaintRect(context, { x: 0, y: 0, width: 1, height: 1 }, () => {
        throw new Error("画坏了");
      }),
    ).toThrow("画坏了");
    expect(calls.at(-1)).toBe("restore()");
  });

  /** 一条从 (x0, y) 到 (x1, y) 的横线，画得到的范围是包围盒外扩 6 */
  function item(name: string, x0: number, x1: number, y: number) {
    const stroke: InkStroke = {
      tool: "pen",
      color: "#1f2328",
      weight: 4,
      id: name,
      points: [
        { x: x0, y, p: 0.5, t: 0 },
        { x: x1, y, p: 0.5, t: 16 },
      ],
    };
    return {
      stroke,
      paintBounds: { minX: x0 - 6, minY: y - 6, maxX: x1 + 6, maxY: y + 6 },
    };
  }

  it("只重画碰到这一块的笔画，按原来的先后；清空范围含外扩并按像素取整", () => {
    const { calls, context } = recorder();
    const painted: string[] = [];
    const strokes = [
      item("far-left", 0, 40, 200),
      item("crossing", 50, 400, 205),
      item("far-below", 100, 300, 400),
      item("inside", 180, 220, 190),
      { ...item("empty", 0, 0, 0), paintBounds: null },
    ];
    // 每单位 1.5 像素、外扩 10：区域 [150,180]–[250,220] → 像素 [210,255]–[390,345]
    const rect = repaintRegion(
      {
        context,
        canvas: { width: 1500, height: 900 },
        pixelsPerUnit: 1.5,
        spread: 10,
      },
      { minX: 150, minY: 180, maxX: 250, maxY: 220 },
      strokes,
      ({ stroke }) => {
        painted.push(stroke.id ?? "");
      },
    );
    expect(rect).toEqual({ x: 210, y: 255, width: 180, height: 90 });
    expect(calls).toContain("clearRect(210,255,180,90)");
    expect(painted).toEqual(["crossing", "inside"]);
  });

  it("笔画只差外扩量就够得着这一块时也要带上（宁可多画）", () => {
    const { context } = recorder();
    const painted: string[] = [];
    // 区域外扩 10 后是 [140,170]–[260,230]；这一笔的范围右缘在 131，差 9
    repaintRegion(
      {
        context,
        canvas: { width: 1000, height: 1000 },
        pixelsPerUnit: 1,
        spread: 10,
      },
      { minX: 150, minY: 180, maxX: 250, maxY: 220 },
      [item("near", 60, 125, 200), item("out-of-reach", 60, 110, 200)],
      ({ stroke }) => {
        painted.push(stroke.id ?? "");
      },
    );
    expect(painted).toEqual(["near"]);
  });

  it("这一块整个在画布外：不清空、不重画", () => {
    const { calls, context } = recorder();
    const rect = repaintRegion(
      {
        context,
        canvas: { width: 100, height: 100 },
        pixelsPerUnit: 1,
        spread: 2,
      },
      { minX: 300, minY: 300, maxX: 340, maxY: 340 },
      [item("any", 0, 400, 320)],
      () => {
        throw new Error("不该重画");
      },
    );
    expect(rect).toBeNull();
    expect(calls).toEqual([]);
  });
});
