import { describe, expect, it } from "vitest";
import { createEraseSession, strokePaintBounds } from "./erase-session.ts";
import type { InkStroke } from "./types.ts";

/** 一条 y 处从 x=100 到 x=500 的水平笔画，线宽 4 */
function line(y: number, id: string): InkStroke {
  return {
    tool: "pen",
    color: "#1f2328",
    weight: 4,
    id,
    startedAt: 1_700_000_000_000,
    points: [
      { x: 100, y, p: 0.5, t: 0 },
      { x: 300, y, p: 0.5, t: 40 },
      { x: 500, y, p: 0.5, t: 80 },
    ],
  };
}

function threeLines(): InkStroke[] {
  return [
    line(100, "stroke-aaaa"),
    line(200, "stroke-bbbb"),
    line(300, "stroke-cccc"),
  ];
}

/** 依次给出 piece-0001、piece-0002……方便断言 */
function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `piece-${String(n).padStart(4, "0")}`;
  };
}

const xs = (stroke: InkStroke) => stroke.points.map((point) => point.x);

describe("一笔画得到的范围", () => {
  it("包围盒外扩整个笔宽再加 2；自然笔感按倍率放大；没有点的笔画没有范围", () => {
    expect(strokePaintBounds(line(200, "stroke-aaaa"))).toEqual({
      minX: 94,
      minY: 194,
      maxX: 506,
      maxY: 206,
    });
    expect(
      strokePaintBounds({
        ...line(200, "stroke-aaaa"),
        rendering: {
          renderer: "freehand",
          smoothing: 0.3,
          thinning: 0.35,
          streamline: 0.15,
          sizeScale: 1.5,
          simulatePressure: false,
        },
      }),
    ).toEqual({ minX: 92, minY: 192, maxX: 508, maxY: 208 });
    expect(
      strokePaintBounds({ ...line(200, "stroke-aaaa"), points: [] }),
    ).toBeNull();
  });
});

describe("擦除会话：整笔模式", () => {
  it("碰到的整笔从画面上拿掉，收笔时给出被删下标；没碰到任何笔画没有结果", () => {
    const strokes = threeLines();
    const session = createEraseSession(strokes, "stroke");
    expect(session.sweep(300, 150, 14)).toBeNull();
    expect(session.result()).toBeNull();
    expect(session.visible().map((item) => item.stroke)).toEqual(strokes);

    // 竖着从 y=180 划到 y=320：第 2、3 笔
    const dirty = session.sweep(300, 320, 14, { x: 300, y: 180 });
    expect(dirty).toEqual({ minX: 94, minY: 194, maxX: 506, maxY: 306 });
    expect(session.visible()).toEqual([
      {
        stroke: strokes[0],
        source: 0,
        paintBounds: { minX: 94, minY: 94, maxX: 506, maxY: 106 },
      },
    ]);
    expect(session.result()).toEqual({ removed: [1, 2], added: [] });
    // 已经拿掉的笔画再划过不算变化
    expect(session.sweep(300, 320, 14, { x: 300, y: 180 })).toBeNull();
  });

  it("画面上留下的笔画就是原对象（不复制、id 不变）", () => {
    const strokes = threeLines();
    const session = createEraseSession(strokes, "stroke");
    session.sweep(300, 200, 14);
    expect(session.visible()[0]?.stroke).toBe(strokes[0]);
    expect(session.visible()[1]?.stroke).toBe(strokes[2]);
  });
});

describe("擦除会话：局部模式", () => {
  it("碰到的那一笔原位换成切剩的各段，其余笔画不动；段的 id 在收笔时铸造一次", () => {
    const strokes = threeLines();
    const session = createEraseSession(strokes, "partial", {
      mintId: counter(),
    });
    const dirty = session.sweep(300, 200, 14);
    expect(dirty).toEqual({ minX: 94, minY: 194, maxX: 506, maxY: 206 });

    const visible = session.visible();
    expect(visible.map((item) => item.source)).toEqual([0, 1, 1, 2]);
    expect(visible[0]?.stroke).toBe(strokes[0]);
    expect(visible[3]?.stroke).toBe(strokes[2]);
    expect(visible.slice(1, 3).map((item) => xs(item.stroke))).toEqual([
      [100, 284],
      [316, 500],
    ]);
    // 拖动途中的段还没有 id
    expect(visible[1]?.stroke.id).toBeUndefined();
    // 每一段带着自己画得到的范围（包围盒外扩一个笔宽再加 2）
    expect(visible.slice(1, 3).map((item) => item.paintBounds)).toEqual([
      { minX: 94, minY: 194, maxX: 290, maxY: 206 },
      { minX: 310, minY: 194, maxX: 506, maxY: 206 },
    ]);

    const result = session.result();
    expect(result?.removed).toEqual([1]);
    expect(
      result?.added.map(({ index, source, stroke }) => ({
        index,
        source,
        id: stroke.id,
        xs: xs(stroke),
      })),
    ).toEqual([
      { index: 1, source: 1, id: "piece-0001", xs: [100, 284] },
      { index: 2, source: 1, id: "piece-0002", xs: [316, 500] },
    ]);
    // 再取一次是同一份结果，不会重新铸造 id
    expect(session.result()).toBe(result);
  });

  it("同一次拖动里接着擦：在已经切开的段上继续切，原笔画只记一次", () => {
    const session = createEraseSession(threeLines(), "partial", {
      mintId: counter(),
    });
    session.sweep(200, 200, 14);
    session.sweep(400, 200, 14);
    expect(session.visible().map((item) => item.source)).toEqual([
      0, 1, 1, 1, 2,
    ]);
    const result = session.result();
    expect(result?.removed).toEqual([1]);
    expect(
      result?.added.map(({ index, stroke }) => [index, xs(stroke)]),
    ).toEqual([
      [1, [100, 184]],
      [2, [216, 300, 384]],
      [3, [416, 500]],
    ]);
    // 只为最后留下的三段铸造 id，中途被再次切开的段不占用
    expect(result?.added.map((item) => item.stroke.id)).toEqual([
      "piece-0001",
      "piece-0002",
      "piece-0003",
    ]);
  });

  it("把一笔擦得一段不剩：只有删除，没有新增", () => {
    const session = createEraseSession(threeLines(), "partial");
    session.sweep(300, 200, 14);
    expect(session.sweep(500, 200, 14, { x: 100, y: 200 })).toEqual({
      minX: 94,
      minY: 194,
      maxX: 506,
      maxY: 206,
    });
    expect(session.visible().map((item) => item.source)).toEqual([0, 2]);
    expect(session.result()).toEqual({ removed: [1], added: [] });
  });

  it("一次划过多笔：各切各的，新增下标按提交后的位置给出", () => {
    const session = createEraseSession(threeLines(), "partial", {
      mintId: counter(),
    });
    // 竖着从 y=80 划到 y=220：第 1、2 笔各被切开
    const dirty = session.sweep(300, 220, 14, { x: 300, y: 80 });
    expect(dirty).toEqual({ minX: 94, minY: 94, maxX: 506, maxY: 206 });
    const result = session.result();
    expect(result?.removed).toEqual([0, 1]);
    expect(result?.added.map(({ index, source }) => [index, source])).toEqual([
      [0, 0],
      [1, 0],
      [2, 1],
      [3, 1],
    ]);
  });

  it("没碰到任何笔画：没有脏区、没有结果", () => {
    const session = createEraseSession(threeLines(), "partial");
    expect(session.sweep(300, 150, 14)).toBeNull();
    expect(session.result()).toBeNull();
  });

  it("笔画数有上限时：切开会超限的那一笔改为整笔擦掉", () => {
    const session = createEraseSession(threeLines(), "partial", {
      maxStrokes: 3,
    });
    session.sweep(300, 200, 14);
    expect(session.visible().map((item) => item.source)).toEqual([0, 2]);
    expect(session.result()).toEqual({ removed: [1], added: [] });

    // 上限够用时照常切开
    const roomy = createEraseSession(threeLines(), "partial", {
      maxStrokes: 4,
    });
    roomy.sweep(300, 200, 14);
    expect(roomy.visible()).toHaveLength(4);
    // 再切一刀会到 5 笔：被切的那一段整段擦掉
    roomy.sweep(200, 200, 14);
    expect(roomy.visible().map((item) => xs(item.stroke))).toEqual([
      [100, 300, 500],
      [316, 500],
      [100, 300, 500],
    ]);
  });

  it("会话开始后外面的数组再变也不影响它（按开始那一刻的笔画算）", () => {
    const strokes = threeLines();
    const session = createEraseSession(strokes, "partial");
    strokes.pop();
    session.sweep(300, 300, 14);
    expect(session.result()?.removed).toEqual([2]);
  });
});
