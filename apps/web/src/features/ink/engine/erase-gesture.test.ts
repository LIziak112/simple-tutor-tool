import { describe, expect, it, vi } from "vitest";
import { createEraseGesture, type EraseGestureHost } from "./erase-gesture.ts";
import type { EraseVisible } from "./erase-session.ts";
import type { RepaintTarget } from "./region-redraw.ts";
import type { InkStroke } from "./types.ts";

/** 一条 y 处从 x=100 到 x=500 的水平笔画，线宽 4 */
function line(y: number, id: string): InkStroke {
  return {
    tool: "pen",
    color: "#1f2328",
    weight: 4,
    id,
    points: [
      { x: 100, y, p: 0.5, t: 0 },
      { x: 300, y, p: 0.5, t: 40 },
      { x: 500, y, p: 0.5, t: 80 },
    ],
  };
}

/** 只记调用的 2d 上下文 */
function fakeContext() {
  const clearRect = vi.fn();
  const context = {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    clearRect,
  } as unknown as CanvasRenderingContext2D;
  return { context, clearRect };
}

function harness(options: { target?: "canvas" | "none" } = {}) {
  const { context, clearRect } = fakeContext();
  /** 每次局部重画交给画法的那一批笔画（各笔记成它的 x 坐标串） */
  const painted: string[][] = [];
  const ring = { showRing: vi.fn(), hideRing: vi.fn() };
  const redraw = vi.fn();
  const target: RepaintTarget = {
    context,
    canvas: { width: 1000, height: 600 },
    pixelsPerUnit: 1,
    spread: 10,
  };
  const host: EraseGestureHost = {
    repaintTarget: () => (options.target === "none" ? null : target),
    paint: (items: readonly EraseVisible[]) => {
      painted.push(
        items.map((item) =>
          item.stroke.points.map((point) => point.x).join("-"),
        ),
      );
    },
    redraw,
    ring: () => ring,
  };
  return {
    gesture: createEraseGesture(host),
    painted,
    ring,
    redraw,
    clearRect,
  };
}

const strokes = () => [
  line(100, "stroke-aaaa"),
  line(200, "stroke-bbbb"),
  line(500, "stroke-cccc"),
];

describe("擦除手势", () => {
  it("橡皮没落下时：经过落点不做任何事，抬起没有结果", () => {
    const h = harness();
    expect(h.gesture.active).toBe(false);
    expect(h.gesture.visible()).toBeNull();
    h.gesture.through([{ x: 300, y: 200, radius: 14 }]);
    expect(h.ring.showRing).not.toHaveBeenCalled();
    expect(h.clearRect).not.toHaveBeenCalled();
    expect(h.gesture.end()).toBeNull();
  });

  it("落下并擦到笔画：只重画改动的那一块里的笔画，橡皮圈显示在落点", () => {
    const h = harness();
    h.gesture.begin(
      [
        line(180, "stroke-near"),
        line(200, "stroke-bbbb"),
        line(500, "stroke-cccc"),
      ],
      "partial",
    );
    expect(h.gesture.active).toBe(true);
    h.gesture.through([{ x: 300, y: 200, radius: 14 }]);
    // 第 2 笔被切成两段；第 1 笔没被擦到，但画在这一块里，跟着重画；第 3 笔很远不画。
    // 这一块里的笔画一次交齐（同一笔切出来的荧光笔段要合在一起上色）
    expect(h.painted).toEqual([["100-300-500", "100-284", "316-500"]]);
    // 脏区 = 第 2 笔的范围 [94,194]–[506,206] 再外扩 10
    expect(h.clearRect).toHaveBeenCalledExactlyOnceWith(84, 184, 432, 32);
    expect(h.redraw).not.toHaveBeenCalled();
    expect(h.ring.showRing).toHaveBeenLastCalledWith(300, 200, 14);
    expect(h.gesture.visible()).toHaveLength(4);
  });

  it("一批落点之间按线段扫过，一批只重画一次；没擦到东西不重画，但橡皮圈照样跟着走", () => {
    const h = harness();
    h.gesture.begin(strokes(), "stroke");
    h.gesture.through([{ x: 300, y: 50, radius: 14 }]);
    expect(h.clearRect).not.toHaveBeenCalled();
    expect(h.ring.showRing).toHaveBeenLastCalledWith(300, 50, 14);
    // 从 y=50 一路划到 y=250：两个落点都不在笔画上，但连线穿过第 1、2 笔
    h.gesture.through([
      { x: 300, y: 150, radius: 14 },
      { x: 300, y: 250, radius: 14 },
    ]);
    expect(h.clearRect).toHaveBeenCalledTimes(1);
    expect(h.ring.showRing).toHaveBeenLastCalledWith(300, 250, 14);
    expect(h.gesture.end()).toEqual({ removed: [0, 1], added: [] });
  });

  it("橡皮圈可以另给位置（画布和笔画不同坐标域时）", () => {
    const h = harness();
    h.gesture.begin(strokes(), "stroke");
    h.gesture.through([{ x: 300, y: 200, radius: 14 }], {
      x: 375,
      y: 250,
      radius: 17.5,
    });
    expect(h.ring.showRing).toHaveBeenLastCalledWith(375, 250, 17.5);
  });

  it("做不了局部重画时整张重画", () => {
    const h = harness({ target: "none" });
    h.gesture.begin(strokes(), "stroke");
    h.gesture.through([{ x: 300, y: 200, radius: 14 }]);
    expect(h.redraw).toHaveBeenCalledTimes(1);
    expect(h.clearRect).not.toHaveBeenCalled();
    expect(h.painted).toEqual([]);
  });

  it("抬起：给出要提交的改动，收起橡皮圈；之后回到没落下的状态", () => {
    const h = harness();
    h.gesture.begin(strokes(), "partial", { mintId: () => "piece-0001" });
    h.gesture.through([{ x: 500, y: 200, radius: 14 }]);
    const result = h.gesture.end();
    expect(result?.removed).toEqual([1]);
    expect(
      result?.added.map(({ index, stroke }) => [index, stroke.id]),
    ).toEqual([[1, "piece-0001"]]);
    expect(h.ring.hideRing).toHaveBeenCalledTimes(1);
    expect(h.gesture.active).toBe(false);
    expect(h.gesture.visible()).toBeNull();
    expect(h.gesture.end()).toBeNull();
  });

  it("重新落下是一次新的擦除：不接着上一次的落点连线", () => {
    const h = harness();
    h.gesture.begin(strokes(), "stroke");
    h.gesture.through([{ x: 300, y: 50, radius: 14 }]);
    h.gesture.end();
    h.gesture.begin(strokes(), "stroke");
    // 若从上一次的 (300,50) 连过来会扫到第 1、2 笔；新的一次只是在 y=350 点一下
    h.gesture.through([{ x: 300, y: 350, radius: 14 }]);
    expect(h.gesture.end()).toBeNull();
  });

  it("笔画数上限照传给会话：切开会超限的那一笔整笔擦掉", () => {
    const h = harness();
    h.gesture.begin(strokes(), "partial", { maxStrokes: 3 });
    h.gesture.through([{ x: 300, y: 200, radius: 14 }]);
    expect(h.gesture.end()).toEqual({ removed: [1], added: [] });
  });
});
