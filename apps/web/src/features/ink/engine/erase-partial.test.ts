import { describe, expect, it } from "vitest";
import { splitStrokeByEraser } from "./erase-partial.ts";
import type { InkStroke } from "./types.ts";

/** 一条从 (100,100) 到 (500,100) 的水平笔画，线宽 4（半宽 2） */
function hStroke(extra: Partial<InkStroke> = {}): InkStroke {
  return {
    tool: "pen",
    color: "#1f2328",
    weight: 4,
    points: [
      { x: 100, y: 100, p: 0.5, t: 0 },
      { x: 200, y: 100, p: 0.5, t: 20 },
      { x: 300, y: 100, p: 0.5, t: 40 },
      { x: 500, y: 100, p: 0.5, t: 80 },
    ],
    ...extra,
  };
}

const xs = (stroke: InkStroke) => stroke.points.map((point) => point.x);

describe("局部橡皮：把一笔里被扫过的部分切掉", () => {
  it("没碰到返回 null（原笔画一个字节不动）", () => {
    const stroke = hStroke();
    // 半径 14 + 半笔宽 2 = 16：离中线 17 碰不到
    expect(splitStrokeByEraser(stroke, { x: 300, y: 117 }, 14)).toBeNull();
    // 包围盒外
    expect(splitStrokeByEraser(stroke, { x: 700, y: 400 }, 14)).toBeNull();
    // 轨迹从旁边掠过也不算
    expect(
      splitStrokeByEraser(stroke, { x: 600, y: 60 }, 14, { x: 0, y: 60 }),
    ).toBeNull();
  });

  it("点在中间：切成两段，切口落在橡皮圈（含半笔宽）边上，坐标、压感、时间按比例插值", () => {
    const stroke = hStroke({
      id: "stroke-0001",
      startedAt: 1_700_000_000_000,
      pointer: "pen",
    });
    const pieces = splitStrokeByEraser(stroke, { x: 300, y: 100 }, 14);
    expect(pieces).toEqual([
      {
        tool: "pen",
        color: "#1f2328",
        weight: 4,
        startedAt: 1_700_000_000_000,
        pointer: "pen",
        points: [
          { x: 100, y: 100, p: 0.5, t: 0 },
          { x: 200, y: 100, p: 0.5, t: 20 },
          // 200→300 这一段走到 84% 处
          { x: 284, y: 100, p: 0.5, t: 37 },
        ],
      },
      {
        tool: "pen",
        color: "#1f2328",
        weight: 4,
        // 第二段从原笔画第 43 毫秒处开始：时刻顺延，段内时间从 0 起算
        startedAt: 1_700_000_000_043,
        pointer: "pen",
        points: [
          { x: 316, y: 100, p: 0.5, t: 0 },
          { x: 500, y: 100, p: 0.5, t: 37 },
        ],
      },
    ]);
    // 切出来的段不带 id：由提交的一方铸造
    expect(pieces?.every((piece) => !("id" in piece))).toBe(true);
    // 原笔画没被改动
    expect(stroke).toEqual(
      hStroke({
        id: "stroke-0001",
        startedAt: 1_700_000_000_000,
        pointer: "pen",
      }),
    );
  });

  it("橡皮划过去：按整条轨迹扫过的区域切，不只看落点", () => {
    // 竖着划过 x=250
    const across = splitStrokeByEraser(hStroke(), { x: 250, y: 140 }, 14, {
      x: 250,
      y: 60,
    });
    expect(across?.map(xs)).toEqual([
      [100, 200, 234],
      [266, 300, 500],
    ]);
    // 沿着笔画划 150→450：中间整段擦掉，两头各留一截
    const along = splitStrokeByEraser(hStroke(), { x: 450, y: 100 }, 14, {
      x: 150,
      y: 100,
    });
    expect(along?.map(xs)).toEqual([
      [100, 134],
      [466, 500],
    ]);
  });

  it("擦掉开头或结尾：只剩一段；开头被擦时段内时间重新从 0 起算", () => {
    const head = splitStrokeByEraser(hStroke(), { x: 100, y: 100 }, 14);
    expect(head).toHaveLength(1);
    expect(head?.[0]?.points).toEqual([
      { x: 116, y: 100, p: 0.5, t: 0 },
      { x: 200, y: 100, p: 0.5, t: 17 },
      { x: 300, y: 100, p: 0.5, t: 37 },
      { x: 500, y: 100, p: 0.5, t: 77 },
    ]);
    const tail = splitStrokeByEraser(hStroke(), { x: 500, y: 100 }, 14);
    expect(tail?.map(xs)).toEqual([[100, 200, 300, 484]]);
  });

  it("整笔都在橡皮扫过的范围里：一段不剩", () => {
    expect(
      splitStrokeByEraser(hStroke(), { x: 500, y: 100 }, 14, {
        x: 100,
        y: 100,
      }),
    ).toEqual([]);
  });

  it("一个点的笔画：碰到就没了，没碰到不动", () => {
    const dot = hStroke({ points: [{ x: 100, y: 100, p: 0.5, t: 0 }] });
    expect(splitStrokeByEraser(dot, { x: 110, y: 100 }, 14)).toEqual([]);
    expect(splitStrokeByEraser(dot, { x: 117, y: 100 }, 14)).toBeNull();
    expect(
      splitStrokeByEraser(hStroke({ points: [] }), { x: 100, y: 100 }, 14),
    ).toBeNull();
  });

  it("一笔多次穿过橡皮圈：每次穿过各切一刀", () => {
    // 之字形：三次经过 y=100、x=300 附近
    const zigzag = hStroke({
      points: [
        { x: 300, y: 0, p: 0.5, t: 0 },
        { x: 300, y: 200, p: 0.5, t: 100 },
        { x: 340, y: 200, p: 0.5, t: 120 },
        { x: 340, y: 0, p: 0.5, t: 220 },
      ],
    });
    const pieces = splitStrokeByEraser(zigzag, { x: 320, y: 100 }, 20);
    // 圈心 (320,100)，够得着的距离 22：两条竖线各离圈心 20，被切掉 |y-100| ≤ √(22²-20²)
    const half = Math.sqrt(22 * 22 - 20 * 20);
    expect(pieces).toHaveLength(3);
    expect(pieces?.[0]?.points.at(-1)?.y).toBeCloseTo(100 - half, 1);
    expect(pieces?.[1]?.points[0]?.y).toBeCloseTo(100 + half, 1);
    expect(pieces?.[1]?.points.at(-1)?.y).toBeCloseTo(100 + half, 1);
    expect(pieces?.[2]?.points[0]?.y).toBeCloseTo(100 - half, 1);
    expect(pieces?.[2]?.points.at(-1)).toMatchObject({ x: 340, y: 0 });
  });

  it("压感在切口处按比例插值，坐标保留两位小数", () => {
    const stroke = hStroke({
      points: [
        { x: 0, y: 0, p: 0.2, t: 0 },
        { x: 300, y: 400, p: 0.8, t: 100 },
      ],
    });
    // 圈心在线段中点 (150,200)，够得着 12+2=14：沿线各 14 → 参数 0.5 ± 14/500
    const pieces = splitStrokeByEraser(stroke, { x: 150, y: 200 }, 12);
    expect(pieces).toHaveLength(2);
    const cut = pieces?.[0]?.points.at(-1);
    expect(cut).toEqual({ x: 141.6, y: 188.8, p: 0.4832, t: 47 });
    expect(pieces?.[1]?.points[0]).toEqual({
      x: 158.4,
      y: 211.2,
      p: 0.5168,
      t: 0,
    });
  });

  it("够得着的距离计入半笔宽：粗荧光笔离得远一些也擦得到；自然笔感按笔宽倍率", () => {
    const highlighter = hStroke({
      tool: "highlighter",
      color: "rgba(250, 204, 21, 0.45)",
      weight: 26,
    });
    // 14 + 13 = 27
    expect(
      splitStrokeByEraser(highlighter, { x: 300, y: 126 }, 14)?.length,
    ).toBe(2);
    expect(splitStrokeByEraser(highlighter, { x: 300, y: 128 }, 14)).toBeNull();
    const freehand = hStroke({
      rendering: {
        renderer: "freehand",
        sizeScale: 3,
        smoothing: 0.5,
        thinning: 0,
        streamline: 0,
        simulatePressure: false,
      },
    });
    // 14 + 4×3/2 = 20
    expect(splitStrokeByEraser(freehand, { x: 300, y: 119 }, 14)?.length).toBe(
      2,
    );
    expect(splitStrokeByEraser(freehand, { x: 300, y: 121 }, 14)).toBeNull();
  });

  it("切剩的碎屑（比半笔宽还短）不留；够长的一截留下", () => {
    const short = (weight: number) =>
      hStroke({
        weight,
        points: [
          { x: 290, y: 100, p: 0.5, t: 0 },
          { x: 320, y: 100, p: 0.5, t: 30 },
        ],
      });
    // 线宽 4：擦掉 284–316，剩 316–320 长 4，留下
    expect(
      splitStrokeByEraser(short(4), { x: 300, y: 100 }, 14)?.map(xs),
    ).toEqual([[316, 320]]);
    // 线宽 10：擦掉 281–319，剩 1，比半笔宽 5 短，不留
    expect(splitStrokeByEraser(short(10), { x: 300, y: 100 }, 14)).toEqual([]);
  });

  it("刚好擦着边（接触长度为零）不算碰到", () => {
    expect(splitStrokeByEraser(hStroke(), { x: 300, y: 116 }, 14)).toBeNull();
  });

  it("重复的采样点（零长度线段）不影响切分", () => {
    const stroke = hStroke({
      points: [
        { x: 100, y: 100, p: 0.5, t: 0 },
        { x: 300, y: 100, p: 0.5, t: 40 },
        { x: 300, y: 100, p: 0.5, t: 45 },
        { x: 500, y: 100, p: 0.5, t: 80 },
      ],
    });
    expect(
      splitStrokeByEraser(stroke, { x: 300, y: 100 }, 14)?.map(xs),
    ).toEqual([
      [100, 284],
      [316, 500],
    ]);
  });
});
