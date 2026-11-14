import { DEFAULT_INK_PROFILE_CONFIG } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProgrammaticAtrament,
  paintOnePathOnAtrament,
  replayAtramentStrokes,
} from "./atrament-replay.ts";
import * as freehandPaint from "./freehand-paint";
import { INK_HIGHLIGHTER, INK_PEN_COLORS, type InkStroke } from "./types.ts";

/** 录制式 2d 上下文桩：记下每次描边时的样式、线宽、变换比例和路径 */
class RecordingContext {
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 1;
  lineCap = "";
  lineJoin = "";
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  scale = 1;
  readonly strokes: Array<{
    style: string;
    lineWidth: number;
    scale: number;
    path: Array<[string, ...number[]]>;
  }> = [];
  #path: Array<[string, ...number[]]> = [];
  #saved: number[] = [];
  beginPath(): void {
    this.#path = [];
  }
  moveTo(x: number, y: number): void {
    this.#path.push(["moveTo", x, y]);
  }
  lineTo(x: number, y: number): void {
    this.#path.push(["lineTo", x, y]);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.#path.push(["quadraticCurveTo", cx, cy, x, y]);
  }
  closePath(): void {}
  stroke(): void {
    this.strokes.push({
      style: String(this.strokeStyle),
      lineWidth: this.lineWidth,
      scale: this.scale,
      path: this.#path,
    });
  }
  clearRect(): void {}
  save(): void {
    this.#saved.push(this.scale);
  }
  restore(): void {
    this.scale = this.#saved.pop() ?? 1;
  }
  setTransform(a: number): void {
    this.scale = a;
  }
}

const contexts = new WeakMap<HTMLCanvasElement, RecordingContext>();
let getContextSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(function (this: HTMLCanvasElement) {
      let ctx = contexts.get(this);
      if (!ctx) {
        ctx = new RecordingContext();
        contexts.set(this, ctx);
      }
      return ctx as unknown as CanvasRenderingContext2D;
    });
});

afterEach(() => {
  getContextSpy.mockRestore();
});

/** 位图 1000 宽、CSS 500 宽（dpr 2）的画布 */
function canvasOf(cssWidth = 500, bitmapWidth = 1000) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmapWidth;
  canvas.height = bitmapWidth;
  Object.defineProperty(canvas, "offsetWidth", { value: cssWidth });
  Object.defineProperty(canvas, "offsetHeight", { value: cssWidth });
  const atrament = createProgrammaticAtrament(canvas);
  const ctx = contexts.get(canvas);
  if (!ctx) throw new Error("画布上下文未创建");
  return { canvas, atrament, ctx };
}

const points = [
  { x: 100, y: 100, p: 0.5, t: 0 },
  { x: 300, y: 100, p: 0.9, t: 8 },
  { x: 100, y: 108, p: 0.2, t: 16 },
  { x: 300, y: 116, p: 0.5, t: 24 },
];
const highlighter: InkStroke = {
  tool: "highlighter",
  color: INK_HIGHLIGHTER.color,
  weight: INK_HIGHLIGHTER.weight,
  points,
};
const pen: InkStroke = {
  tool: "pen",
  color: INK_PEN_COLORS.black,
  weight: 4,
  points,
};

describe("replayAtramentStrokes：只有一笔时，荧光笔整笔一次描边", () => {
  it("来回重叠、带压感的一笔只描一次，线宽不随压感变", () => {
    const { atrament, ctx } = canvasOf();
    replayAtramentStrokes(atrament, 500, [highlighter]);
    expect(ctx.strokes).toHaveLength(1);
    expect(ctx.strokes[0]).toMatchObject({
      style: INK_HIGHLIGHTER.color,
      lineWidth: INK_HIGHLIGHTER.weight,
    });
  });

  it("路径用逻辑坐标，位图比例 = 位图宽 / 逻辑宽（与 atrament 的换算同一口径）", () => {
    const { atrament, ctx } = canvasOf(500, 1000);
    replayAtramentStrokes(atrament, 500, [highlighter]);
    expect(ctx.strokes[0]?.scale).toBe(1);
    expect(ctx.strokes[0]?.path[0]).toEqual(["moveTo", 100, 100]);
    expect(ctx.strokes[0]?.path.at(-1)).toEqual(["lineTo", 300, 116]);

    // 派生图：位图 480 宽、CSS 1000 宽（css 坐标即逻辑坐标）
    const thumbnail = canvasOf(1000, 480);
    replayAtramentStrokes(thumbnail.atrament, 1000, [highlighter]);
    expect(thumbnail.ctx.strokes[0]?.scale).toBe(0.48);
  });

  it("画完不改动 atrament 画布上原有的变换", () => {
    const { atrament, ctx } = canvasOf();
    replayAtramentStrokes(atrament, 500, [highlighter]);
    expect(ctx.scale).toBe(1);
  });

  it("笔仍然逐段描边（线宽随压感变化），不受影响", () => {
    const { atrament, ctx } = canvasOf();
    replayAtramentStrokes(atrament, 500, [pen]);
    expect(ctx.strokes).toHaveLength(points.length);
    expect(new Set(ctx.strokes.map((s) => s.style))).toEqual(
      new Set([INK_PEN_COLORS.black]),
    );
    expect(new Set(ctx.strokes.map((s) => s.lineWidth)).size).toBeGreaterThan(
      1,
    );
  });

  it("自然笔感的荧光笔保持轮廓填充的画法", () => {
    const paint = vi
      .spyOn(freehandPaint, "paintFreehandStroke")
      .mockImplementation(() => {});
    try {
      // 位图 900 宽、CSS 300 宽（dpr 3）：比例与成组时取自同一处换算
      const { atrament, ctx } = canvasOf(300, 900);
      const stroke: InkStroke = {
        ...highlighter,
        rendering: { ...DEFAULT_INK_PROFILE_CONFIG, renderer: "freehand" },
      };
      replayAtramentStrokes(atrament, 300, [stroke]);
      expect(paint).toHaveBeenCalledOnce();
      expect(paint.mock.calls[0]?.slice(1)).toEqual([
        (900 / 300) * (300 / 1000),
        stroke,
        stroke.rendering,
      ]);
      expect(ctx.strokes).toHaveLength(0);
    } finally {
      paint.mockRestore();
    }
  });
});

describe("replayAtramentStrokes：按顺序重放一串笔画", () => {
  /** 一笔荧光笔被局部橡皮切成的两段（提交后各有自己的 id，带着同一个记号） */
  const pieces: InkStroke[] = [
    {
      ...highlighter,
      id: "piece-0001",
      cutFrom: "stroke-0001",
      points: points.slice(0, 2),
    },
    {
      ...highlighter,
      id: "piece-0002",
      cutFrom: "stroke-0001",
      points: points.slice(2),
    },
  ];

  it("同一笔切出来的荧光笔各段合在一起只描一次：一条路径里两条子路径", () => {
    const { atrament, ctx } = canvasOf();
    replayAtramentStrokes(atrament, 500, pieces);
    expect(ctx.strokes).toHaveLength(1);
    expect(ctx.strokes[0]).toMatchObject({
      style: INK_HIGHLIGHTER.color,
      lineWidth: INK_HIGHLIGHTER.weight,
      scale: 1,
    });
    expect(ctx.strokes[0]?.path.filter(([name]) => name === "moveTo")).toEqual([
      ["moveTo", 100, 100],
      ["moveTo", 100, 108],
    ]);
  });

  it("没被切过的两笔荧光笔各描各的（两笔之间重叠照旧叠深）", () => {
    const { atrament, ctx } = canvasOf();
    replayAtramentStrokes(atrament, 500, [highlighter, highlighter]);
    expect(ctx.strokes).toHaveLength(2);
  });

  it("中间隔着别的笔画：按绘制顺序分开画，先后不乱", () => {
    const { atrament, ctx } = canvasOf();
    const [first, second] = pieces;
    if (!first || !second) throw new Error("缺少切段");
    replayAtramentStrokes(atrament, 500, [first, pen, second]);
    expect(ctx.strokes.map((s) => s.style)).toEqual([
      INK_HIGHLIGHTER.color,
      ...points.map(() => INK_PEN_COLORS.black),
      INK_HIGHLIGHTER.color,
    ]);
  });

  it("自然笔感的荧光笔段：各段的轮廓一起填一次", () => {
    const paintRun = vi
      .spyOn(freehandPaint, "paintFreehandRun")
      .mockImplementation(() => {});
    try {
      const { atrament, ctx } = canvasOf(500, 1000);
      const rendering = {
        ...DEFAULT_INK_PROFILE_CONFIG,
        renderer: "freehand",
      } as const;
      const freehandPieces = pieces.map((piece) => ({ ...piece, rendering }));
      replayAtramentStrokes(atrament, 500, freehandPieces);
      expect(paintRun).toHaveBeenCalledOnce();
      // 位图 1000 宽对逻辑宽 1000：比例 1
      expect(paintRun.mock.calls[0]?.slice(1)).toEqual([
        1,
        freehandPieces,
        rendering,
      ]);
      expect(ctx.strokes).toHaveLength(0);
    } finally {
      paintRun.mockRestore();
    }
  });

  it("不认识的 atrament 实例（没有登记画布）：退回逐笔画，不丢笔画", () => {
    const calls: string[] = [];
    const stranger = {
      beginStroke: () => calls.push("begin"),
      draw: (x: number, y: number) => ({ x, y }),
      endStroke: () => calls.push("end"),
    } as unknown as Parameters<typeof replayAtramentStrokes>[0];
    replayAtramentStrokes(stranger, 500, pieces);
    expect(calls).toEqual(["begin", "end", "begin", "end"]);
  });
});

describe("paintOnePathOnAtrament", () => {
  it("按「一个单位合多少 CSS 像素」换算：圈画的底图像素域同样适用", () => {
    // 底图 1440 宽，画布位图同为 1440，CSS 显示成 720 宽 → 每底图像素 0.5 CSS 像素
    const { atrament, ctx } = canvasOf(720, 1440);
    expect(paintOnePathOnAtrament(atrament, 0.5, highlighter)).toBe(true);
    expect(ctx.strokes).toHaveLength(1);
    expect(ctx.strokes[0]?.scale).toBe(1);
  });

  it("不是整笔一条路径的笔画不处理，交回调用方逐段画", () => {
    const { atrament, ctx } = canvasOf();
    expect(paintOnePathOnAtrament(atrament, 0.5, pen)).toBe(false);
    expect(ctx.strokes).toHaveLength(0);
  });

  it("不认识的 atrament 实例（没有登记画布）不处理", () => {
    const stranger = {} as Parameters<typeof paintOnePathOnAtrament>[0];
    expect(paintOnePathOnAtrament(stranger, 0.5, highlighter)).toBe(false);
  });
});
