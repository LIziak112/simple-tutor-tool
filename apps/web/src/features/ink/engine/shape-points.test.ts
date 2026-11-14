import { describe, expect, it } from "vitest";
import {
  SHAPE_MAX_POINTS,
  SHAPE_MIN_SPAN,
  SHAPE_PRESSURE,
  SHAPE_SPACING,
  shapeOutline,
  shapeSpan,
  shapeStrokePoints,
  shapeVertexPoints,
  snapShapeEnd,
} from "./shape-points.ts";
import type { InkStrokePoint } from "./types.ts";

type XY = { x: number; y: number };

const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);

/** 相邻两点的距离（重复的点距离为 0） */
function gaps(points: readonly XY[]): number[] {
  return points.slice(1).map((p, i) => dist(p, points[i] as XY));
}

/** 点到线段的距离 */
function toSegment(p: XY, a: XY, b: XY): number {
  const length = dist(a, b);
  if (length === 0) return dist(p, a);
  const along =
    ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length ** 2;
  const k = Math.min(1, Math.max(0, along));
  return dist(p, { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
}

/** 点到折线的距离 */
function toPolyline(p: XY, vertices: readonly XY[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < vertices.length; i++) {
    best = Math.min(
      best,
      toSegment(p, vertices[i - 1] as XY, vertices[i] as XY),
    );
  }
  return best;
}

function strokeOf(
  shape: Parameters<typeof shapeOutline>[0],
  from: XY,
  to: XY,
  durationMs = 600,
  weight = 4,
  unit = 1,
): InkStrokePoint[] {
  return shapeStrokePoints(
    shapeOutline(shape, from, to, weight, unit),
    durationMs,
    unit,
  );
}

describe("直线类图形的终点吸附", () => {
  const from = { x: 100, y: 100 };

  it("接近水平或竖直（5° 以内）时吸附到正水平、正竖直", () => {
    // tan 5° ≈ 0.0875：300 长的线，偏 20 在 5° 以内
    expect(snapShapeEnd("line", from, { x: 400, y: 120 })).toEqual({
      x: 400,
      y: 100,
    });
    expect(snapShapeEnd("arrow", from, { x: 90, y: 400 })).toEqual({
      x: 100,
      y: 400,
    });
    // 往左、往上画同样吸附
    expect(snapShapeEnd("line", { x: 400, y: 100 }, { x: 100, y: 85 })).toEqual(
      { x: 100, y: 100 },
    );
  });

  it("偏得多了不吸附，按拖到的位置画", () => {
    const to = { x: 400, y: 140 };
    expect(snapShapeEnd("line", from, to)).toEqual(to);
  });

  it("矩形和椭圆不吸附", () => {
    const to = { x: 400, y: 104 };
    expect(snapShapeEnd("rect", from, to)).toEqual(to);
    expect(snapShapeEnd("ellipse", from, to)).toEqual(to);
  });
});

describe("图形的骨架", () => {
  it("直线：起点、终点两个顶点", () => {
    const outline = shapeOutline(
      "line",
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      4,
    );
    expect(outline.points).toEqual([
      { x: 10, y: 20 },
      { x: 110, y: 20 },
    ]);
    expect(outline.cornered).toBe(true);
  });

  it("矩形：从落笔的角出发绕一圈回到原处", () => {
    const outline = shapeOutline(
      "rect",
      { x: 10, y: 20 },
      { x: 110, y: 80 },
      4,
    );
    expect(outline.points).toEqual([
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 80 },
      { x: 10, y: 80 },
      { x: 10, y: 20 },
    ]);
  });

  it("箭头：一笔画完——杆、一侧箭翼、回到箭尖、另一侧箭翼", () => {
    const from = { x: 100, y: 100 };
    const to = { x: 400, y: 100 };
    const { points } = shapeOutline("arrow", from, to, 4);
    expect(points).toHaveLength(5);
    const [start, tip, wingA, back, wingB] = points as [XY, XY, XY, XY, XY];
    expect(start).toEqual(from);
    expect(tip).toEqual(to);
    expect(back).toEqual(to);
    // 两翼等长、关于杆对称、都在箭尖后面
    expect(dist(wingA, tip)).toBeCloseTo(dist(wingB, tip), 6);
    expect(wingA.x).toBeCloseTo(wingB.x, 6);
    expect(wingA.y - 100).toBeCloseTo(-(wingB.y - 100), 6);
    expect(wingA.x).toBeLessThan(tip.x);
    // 箭翼与杆的夹角约 28°
    const angle = Math.atan2(Math.abs(wingA.y - tip.y), tip.x - wingA.x);
    expect((angle * 180) / Math.PI).toBeCloseTo(28, 0);
  });

  it("箭翼的长短跟线宽走，杆太短时不超过杆长的一半", () => {
    const from = { x: 100, y: 100 };
    const wing = (to: XY, weight: number) => {
      const { points } = shapeOutline("arrow", from, to, weight);
      return dist(points[2] as XY, points[1] as XY);
    };
    expect(wing({ x: 500, y: 100 }, 9)).toBeGreaterThan(
      wing({ x: 500, y: 100 }, 2.5),
    );
    // 细笔也有个看得见的箭头：不短于 14 个逻辑单位
    expect(wing({ x: 500, y: 100 }, 1.5)).toBeCloseTo(14, 6);
    // 杆只有 20 长：箭翼不超过一半
    expect(wing({ x: 120, y: 100 }, 9)).toBeCloseTo(10, 6);
  });

  it("椭圆：内接于拖出的矩形，首尾相接，没有硬拐角", () => {
    const from = { x: 100, y: 200 };
    const to = { x: 500, y: 400 };
    const outline = shapeOutline("ellipse", from, to, 4);
    expect(outline.cornered).toBe(false);
    expect(outline.points.at(0)).toEqual(outline.points.at(-1));
    for (const p of outline.points) {
      const value = ((p.x - 300) / 200) ** 2 + ((p.y - 300) / 100) ** 2;
      expect(value).toBeCloseTo(1, 6);
    }
    const xs = outline.points.map((p) => p.x);
    const ys = outline.points.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(100, 6);
    expect(Math.max(...xs)).toBeCloseTo(500, 6);
    expect(Math.min(...ys)).toBeCloseTo(200, 6);
    expect(Math.max(...ys)).toBeCloseTo(400, 6);
  });
});

describe("骨架加密成落库的点列", () => {
  it("直线：等距加密，起点起、终点止，终点补一个重复点", () => {
    const from = { x: 100, y: 100 };
    const to = { x: 400, y: 100 };
    const points = strokeOf("line", from, to);
    expect(points[0]).toMatchObject(from);
    expect(points.at(-1)).toMatchObject(to);
    expect(points.at(-2)).toMatchObject(to);
    for (const p of points) expect(p.y).toBe(100);
    const steps = gaps(points).slice(0, -1);
    for (const gap of steps) {
      expect(gap).toBeGreaterThan(SHAPE_SPACING * 0.6);
      expect(gap).toBeLessThanOrEqual(SHAPE_SPACING * 1.01);
    }
  });

  it("压感恒定，而且不是 0.5（atrament 把 0.5 当作没有压感，改按速度变粗细，直线上会一节一节的）", () => {
    expect(SHAPE_PRESSURE).not.toBe(0.5);
    // 离 0.5 很近：按压感算出的线宽与标称线宽的差别看不出来
    expect(Math.abs(SHAPE_PRESSURE - 0.5)).toBeLessThan(0.02);
    for (const shape of ["line", "arrow", "rect", "ellipse"] as const) {
      const points = strokeOf(shape, { x: 0, y: 0 }, { x: 400, y: 200 }, 800);
      expect(points.every((p) => p.p === SHAPE_PRESSURE)).toBe(true);
    }
  });

  it("时间从 0 到拖动时长，按路程分配、不回退、都是整数", () => {
    const points = strokeOf("line", { x: 0, y: 0 }, { x: 400, y: 0 }, 800);
    expect(points[0]?.t).toBe(0);
    expect(points.at(-1)?.t).toBe(800);
    for (let i = 1; i < points.length; i++) {
      expect(points[i]?.t).toBeGreaterThanOrEqual(points[i - 1]?.t ?? 0);
      expect(Number.isInteger(points[i]?.t)).toBe(true);
    }
    // 路程走到一半，时间也到一半
    const middle = points.find((p) => p.x >= 200);
    expect(middle?.t).toBeGreaterThanOrEqual(380);
    expect(middle?.t).toBeLessThanOrEqual(420);
  });

  it("没有时长（一下就抬笔）时所有点的时间都是 0", () => {
    const points = strokeOf("line", { x: 0, y: 0 }, { x: 80, y: 0 }, 0);
    expect(points.every((p) => p.t === 0)).toBe(true);
  });

  it("矩形：点都在四条边上，每个角各补一个重复点，回到起点收尾", () => {
    const from = { x: 100, y: 100 };
    const to = { x: 300, y: 220 };
    const outline = shapeOutline("rect", from, to, 4);
    const points = shapeStrokePoints(outline, 600);
    for (const p of points) {
      expect(toPolyline(p, outline.points)).toBeLessThan(0.011);
    }
    expect(points[0]).toMatchObject(from);
    expect(points.at(-1)).toMatchObject(from);
    const corners = [
      { x: 300, y: 100 },
      { x: 300, y: 220 },
      { x: 100, y: 220 },
      { x: 100, y: 100 },
    ];
    for (const corner of corners) {
      const index = points.findIndex(
        (p, i) => i > 0 && p.x === corner.x && p.y === corner.y,
      );
      expect(index).toBeGreaterThan(0);
      expect(points[index + 1]).toMatchObject(corner);
    }
  });

  it("箭头：点都在骨架上，箭尖经过两次", () => {
    const outline = shapeOutline(
      "arrow",
      { x: 100, y: 300 },
      { x: 400, y: 120 },
      4,
    );
    const points = shapeStrokePoints(outline, 500);
    for (const p of points) {
      expect(toPolyline(p, outline.points)).toBeLessThan(0.011);
    }
    const tip = { x: 400, y: 120 };
    const visits = points.filter((p) => p.x === tip.x && p.y === tip.y);
    // 到箭尖（连同补的一个点）两个，从箭翼折回来又两个
    expect(visits).toHaveLength(4);
  });

  it("椭圆：点都在椭圆上，间距均匀，首尾相接", () => {
    const from = { x: 100, y: 200 };
    const to = { x: 500, y: 400 };
    const points = strokeOf("ellipse", from, to);
    for (const p of points) {
      const value = ((p.x - 300) / 200) ** 2 + ((p.y - 300) / 100) ** 2;
      // 96 边形上的点：离椭圆不超过 0.1 个单位
      expect(Math.abs(Math.sqrt(value) - 1) * 100).toBeLessThan(0.1);
    }
    expect(points.at(-1)).toMatchObject({ x: points[0]?.x, y: points[0]?.y });
    const steps = gaps(points).slice(0, -1);
    for (const gap of steps) {
      expect(gap).toBeGreaterThan(SHAPE_SPACING * 0.8);
      expect(gap).toBeLessThan(SHAPE_SPACING * 1.2);
    }
  });

  it("很大的图形把间距放大，一笔不超过点数上限", () => {
    const points = strokeOf("rect", { x: 0, y: 0 }, { x: 1000, y: 3000 });
    expect(points.length).toBeLessThanOrEqual(SHAPE_MAX_POINTS);
    expect(points.length).toBeGreaterThan(SHAPE_MAX_POINTS * 0.9);
    const ellipse = strokeOf("ellipse", { x: 0, y: 0 }, { x: 1000, y: 3000 });
    expect(ellipse.length).toBeLessThanOrEqual(SHAPE_MAX_POINTS);
  });

  it("坐标保留两位小数", () => {
    const points = strokeOf(
      "line",
      { x: 0.123, y: 0.456 },
      { x: 77.777, y: 9 },
    );
    for (const p of points) {
      expect(Math.round(p.x * 100) / 100).toBe(p.x);
      expect(Math.round(p.y * 100) / 100).toBe(p.y);
    }
  });

  it("坐标单位不是逻辑单位时（圈画的底图像素），间距与箭头大小按比例换算", () => {
    const unit = 1.44;
    const logical = strokeOf("line", { x: 0, y: 0 }, { x: 400, y: 0 });
    const scaled = strokeOf(
      "line",
      { x: 0, y: 0 },
      { x: 400 * unit, y: 0 },
      600,
      4 * unit,
      unit,
    );
    expect(scaled).toHaveLength(logical.length);
    const wing = (u: number) => {
      const { points } = shapeOutline(
        "arrow",
        { x: 0, y: 0 },
        { x: 600 * u, y: 0 },
        1.5 * u,
        u,
      );
      return dist(points[2] as XY, points[1] as XY);
    };
    expect(wing(unit)).toBeCloseTo(wing(1) * unit, 6);
  });
});

describe("只取顶点的点列（整笔一条路径的笔）", () => {
  it("直线就是起止两个点：时间为 0 和拖动时长，坐标两位小数", () => {
    const outline = shapeOutline(
      "line",
      { x: 10.004, y: 20 },
      { x: 310, y: 20 },
      16,
    );
    expect(shapeVertexPoints(outline, 420.6)).toEqual([
      { x: 10, y: 20, p: SHAPE_PRESSURE, t: 0 },
      { x: 310, y: 20, p: SHAPE_PRESSURE, t: 421 },
    ]);
  });

  it("多个顶点时时间按路程分配", () => {
    const outline = shapeOutline("rect", { x: 0, y: 0 }, { x: 100, y: 100 }, 4);
    expect(shapeVertexPoints(outline, 400).map((p) => p.t)).toEqual([
      0, 100, 200, 300, 400,
    ]);
  });
});

describe("拖出的大小", () => {
  it("shapeSpan 是起止点的直线距离；不到 SHAPE_MIN_SPAN 不算一个图形", () => {
    expect(shapeSpan({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(SHAPE_MIN_SPAN).toBeGreaterThan(5);
  });
});
