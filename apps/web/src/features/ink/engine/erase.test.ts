import { describe, expect, it } from "vitest";
import { eraseHit, strokeHit } from "./erase.ts";
import type { InkStroke } from "./types.ts";

/** 一条从 (100,100) 到 (500,100) 的水平笔画（逻辑坐标） */
function hStroke(): InkStroke {
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
  };
}

describe("整笔橡皮命中检测", () => {
  it("落在笔画段中间命中（点到线段的距离）", () => {
    const s = hStroke();
    // (250,100) 在 (200,100)-(300,100) 段上
    expect(strokeHit(s, 250, 100, 14)).toBe(true);
    // 距离 12 < 半径 14 → 命中
    expect(strokeHit(s, 250, 112, 14)).toBe(true);
    // 距离 15 > 半径 → 不命中
    expect(strokeHit(s, 250, 115, 14)).toBe(false);
  });

  it("端点附近命中；远离不命中", () => {
    const s = hStroke();
    expect(strokeHit(s, 100, 100, 14)).toBe(true); // 起点
    expect(strokeHit(s, 500, 108, 14)).toBe(true); // 终点附近
    expect(strokeHit(s, 50, 100, 14)).toBe(false); // 起点左侧 50
    expect(strokeHit(s, 250, 300, 14)).toBe(false); // 远离
  });

  it("包围盒外扩（粗筛）不误伤：偏出 pad 之外直接不命中", () => {
    const s = hStroke();
    // x 在段范围外但 y 相同
    expect(strokeHit(s, 50, 100, 14)).toBe(false);
    expect(strokeHit(s, 600, 100, 14)).toBe(false);
  });

  it("单点笔画按点判定", () => {
    const dot: InkStroke = {
      tool: "pen",
      color: "#000",
      weight: 4,
      points: [{ x: 300, y: 200, p: 0.5, t: 0 }],
    };
    expect(strokeHit(dot, 305, 200, 14)).toBe(true);
    expect(strokeHit(dot, 320, 200, 14)).toBe(false);
  });

  it("eraseHit 返回全部命中笔画的下标（升序）", () => {
    const strokes = [
      hStroke(), // y=100
      { ...hStroke(), points: hStroke().points.map((p) => ({ ...p, y: 300 })) }, // y=300
    ];
    // 检测点在两笔之间，半径只够到第一笔
    expect(eraseHit(strokes, 250, 112, 14)).toEqual([0]);
    // 半径大到同时覆盖两笔
    expect(eraseHit(strokes, 250, 200, 120)).toEqual([0, 1]);
    // 都不命中
    expect(eraseHit(strokes, 900, 900, 14)).toEqual([]);
  });
});
