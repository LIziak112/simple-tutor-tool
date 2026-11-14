import { describe, expect, it } from "vitest";
import {
  isOnePathStroke,
  onePathSvg,
  paintOnePathStroke,
  traceOnePath,
} from "./highlighter-paint.ts";
import { INK_HIGHLIGHTER, type InkStroke } from "./types.ts";

type Op = [name: string, ...args: number[]];

/** 录制式桩：只记路径指令与描边/填充时的画笔状态 */
class RecordingContext {
  strokeStyle = "";
  fillStyle = "";
  lineWidth = 1;
  lineCap = "butt";
  lineJoin = "miter";
  readonly ops: Op[] = [];
  readonly paints: Array<{
    kind: "stroke" | "fill";
    style: string;
    lineWidth: number;
    lineCap: string;
    lineJoin: string;
  }> = [];
  save(): void {
    this.ops.push(["save"]);
  }
  restore(): void {
    this.ops.push(["restore"]);
  }
  setTransform(...m: number[]): void {
    this.ops.push(["setTransform", ...m]);
  }
  beginPath(): void {
    this.ops.push(["beginPath"]);
  }
  moveTo(x: number, y: number): void {
    this.ops.push(["moveTo", x, y]);
  }
  lineTo(x: number, y: number): void {
    this.ops.push(["lineTo", x, y]);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.ops.push(["quadraticCurveTo", cx, cy, x, y]);
  }
  arc(x: number, y: number, r: number, a0: number, a1: number): void {
    this.ops.push(["arc", x, y, r, a0, a1]);
  }
  #paint(kind: "stroke" | "fill"): void {
    this.paints.push({
      kind,
      style: kind === "stroke" ? this.strokeStyle : this.fillStyle,
      lineWidth: this.lineWidth,
      lineCap: this.lineCap,
      lineJoin: this.lineJoin,
    });
  }
  stroke(): void {
    this.#paint("stroke");
  }
  fill(): void {
    this.#paint("fill");
  }
}

const asContext = (ctx: RecordingContext) =>
  ctx as unknown as CanvasRenderingContext2D;

const pts = (...xy: Array<[number, number]>) =>
  xy.map(([x, y], i) => ({ x, y, p: 0.5, t: i * 8 }));

const highlighter = (
  points: InkStroke["points"],
  over: Partial<InkStroke> = {},
): InkStroke => ({
  tool: "highlighter",
  color: INK_HIGHLIGHTER.color,
  weight: INK_HIGHLIGHTER.weight,
  points,
  ...over,
});

/** 只留路径指令（去掉 save/restore/setTransform/beginPath） */
function traced(points: InkStroke["points"], count?: number): Op[] {
  const ctx = new RecordingContext();
  traceOnePath(ctx, points, count);
  return ctx.ops;
}

describe("isOnePathStroke：哪些笔画整笔一条路径", () => {
  it("荧光笔是；笔不是", () => {
    expect(isOnePathStroke(highlighter(pts([0, 0])))).toBe(true);
    expect(isOnePathStroke(highlighter(pts([0, 0]), { tool: "pen" }))).toBe(
      false,
    );
  });

  it("带标准笔感参数的荧光笔仍是；自然笔感的荧光笔走轮廓填充，不是", () => {
    const rendering = {
      renderer: "atrament" as const,
      smoothing: 0.35,
      thinning: 0.35,
      streamline: 0.15,
      sizeScale: 1,
      simulatePressure: false,
    };
    expect(isOnePathStroke(highlighter(pts([0, 0]), { rendering }))).toBe(true);
    expect(
      isOnePathStroke(
        highlighter(pts([0, 0]), {
          rendering: { ...rendering, renderer: "freehand" },
        }),
      ),
    ).toBe(false);
  });
});

describe("traceOnePath：点序列 → 一条连续路径", () => {
  it("没有点：不出指令，返回 none", () => {
    const ctx = new RecordingContext();
    expect(traceOnePath(ctx, [])).toBe("none");
    expect(ctx.ops).toEqual([]);
  });

  it("单点：原地一条零长线（圆头下是一个圆点），返回 dot", () => {
    const ctx = new RecordingContext();
    expect(traceOnePath(ctx, pts([10, 20]))).toBe("dot");
    expect(ctx.ops).toEqual([
      ["moveTo", 10, 20],
      ["lineTo", 10, 20],
    ]);
  });

  it("全部重合的多个点等同单点", () => {
    const ctx = new RecordingContext();
    expect(traceOnePath(ctx, pts([10, 20], [10, 20], [10, 20]))).toBe("dot");
    expect(ctx.ops).toEqual([
      ["moveTo", 10, 20],
      ["lineTo", 10, 20],
    ]);
  });

  it("两点：一条直线，起止都落在真实采样点上", () => {
    const ctx = new RecordingContext();
    expect(traceOnePath(ctx, pts([0, 0], [10, 4]))).toBe("path");
    expect(ctx.ops).toEqual([
      ["moveTo", 0, 0],
      ["lineTo", 10, 4],
    ]);
  });

  it("三点以上：采样点作控制点、相邻中点作端点，首尾各补一段直线到真实端点", () => {
    expect(traced(pts([0, 0], [10, 0], [10, 10], [20, 10]))).toEqual([
      ["moveTo", 0, 0],
      ["lineTo", 5, 0],
      ["quadraticCurveTo", 10, 0, 10, 5],
      ["quadraticCurveTo", 10, 10, 15, 10],
      ["lineTo", 20, 10],
    ]);
  });

  it("连续重复的采样点只算一次（停笔不动不产生退化线段）", () => {
    expect(traced(pts([0, 0], [0, 0], [10, 0], [10, 0], [10, 10]))).toEqual(
      traced(pts([0, 0], [10, 0], [10, 10])),
    );
  });

  it("count 只画前若干个点（回放按时间截断）", () => {
    const all = pts([0, 0], [10, 0], [10, 10], [20, 10]);
    expect(traced(all, 2)).toEqual(traced(all.slice(0, 2)));
    expect(traced(all, 0)).toEqual([]);
    expect(traced(all, 99)).toEqual(traced(all));
  });
});

describe("onePathSvg：同一条路径写成 SVG 路径数据", () => {
  it("与画布指令逐条对应", () => {
    expect(onePathSvg(pts([0, 0], [10, 0], [10, 10], [20, 10]))).toBe(
      "M0 0L5 0Q10 0 10 5Q10 10 15 10L20 10",
    );
  });

  it("单点是零长线；没有点是空串", () => {
    expect(onePathSvg(pts([10.5, 20.25]))).toBe("M10.5 20.25L10.5 20.25");
    expect(onePathSvg([])).toBe("");
  });

  it("中点最多三位小数，不带浮点尾数", () => {
    expect(onePathSvg(pts([0.01, 0.02], [0.02, 0.05], [0.07, 0.11]))).toBe(
      "M0.01 0.02L0.015 0.035Q0.02 0.05 0.045 0.08L0.07 0.11",
    );
  });
});

describe("paintOnePathStroke：整笔一次描边", () => {
  it("来回重叠的一笔也只描一次：透明度处处相同，接头和重叠处不叠深", () => {
    const ctx = new RecordingContext();
    paintOnePathStroke(
      asContext(ctx),
      2,
      highlighter(pts([0, 0], [100, 0], [0, 4], [100, 8], [0, 12])),
    );
    expect(ctx.paints).toEqual([
      {
        kind: "stroke",
        style: INK_HIGHLIGHTER.color,
        lineWidth: INK_HIGHLIGHTER.weight,
        lineCap: "round",
        lineJoin: "round",
      },
    ]);
  });

  it("坐标与线宽都用笔画自己的单位，缩放交给变换；画完还原画笔状态", () => {
    const ctx = new RecordingContext();
    paintOnePathStroke(asContext(ctx), 1.5, highlighter(pts([0, 0], [10, 4])));
    expect(ctx.ops).toEqual([
      ["save"],
      ["setTransform", 1.5, 0, 0, 1.5, 0, 0],
      ["beginPath"],
      ["moveTo", 0, 0],
      ["lineTo", 10, 4],
      ["restore"],
    ]);
  });

  it("轻点一下：填一个直径等于线宽的圆点（不依赖零长线的圆头是否栅格化）", () => {
    const ctx = new RecordingContext();
    paintOnePathStroke(asContext(ctx), 1, highlighter(pts([30, 40])));
    expect(ctx.ops).toEqual([
      ["save"],
      ["setTransform", 1, 0, 0, 1, 0, 0],
      ["beginPath"],
      ["arc", 30, 40, INK_HIGHLIGHTER.weight / 2, 0, Math.PI * 2],
      ["restore"],
    ]);
    expect(ctx.paints).toEqual([
      expect.objectContaining({ kind: "fill", style: INK_HIGHLIGHTER.color }),
    ]);
  });

  it("没有点：什么都不画", () => {
    const ctx = new RecordingContext();
    paintOnePathStroke(asContext(ctx), 1, highlighter([]));
    expect(ctx.ops).toEqual([]);
    expect(ctx.paints).toEqual([]);
  });

  it("count 只画前若干个点", () => {
    const ctx = new RecordingContext();
    const stroke = highlighter(pts([0, 0], [10, 0], [10, 10], [20, 10]));
    paintOnePathStroke(asContext(ctx), 1, stroke, 2);
    expect(ctx.ops).toEqual([
      ["save"],
      ["setTransform", 1, 0, 0, 1, 0, 0],
      ["beginPath"],
      ["moveTo", 0, 0],
      ["lineTo", 10, 0],
      ["restore"],
    ]);
  });
});
