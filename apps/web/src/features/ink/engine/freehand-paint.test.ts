import { DEFAULT_INK_PROFILE_CONFIG, type InkRendering } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { paintFreehandRun, paintFreehandStroke } from "./freehand-paint";
import { INK_HIGHLIGHTER, type InkStroke } from "./types.ts";

/** 录制式桩：记下每次填充时的颜色，以及这次填充的路径里有几条闭合子路径 */
class RecordingContext {
  fillStyle = "";
  readonly fills: Array<{ style: string; subpaths: number }> = [];
  readonly ops: string[] = [];
  #subpaths = 0;
  save(): void {
    this.ops.push("save");
  }
  restore(): void {
    this.ops.push("restore");
  }
  setTransform(a: number): void {
    this.ops.push(`setTransform ${a}`);
  }
  beginPath(): void {
    this.#subpaths = 0;
  }
  moveTo(): void {
    this.#subpaths += 1;
  }
  quadraticCurveTo(): void {}
  closePath(): void {}
  fill(): void {
    this.fills.push({ style: this.fillStyle, subpaths: this.#subpaths });
  }
}

const asContext = (ctx: RecordingContext) =>
  ctx as unknown as CanvasRenderingContext2D;

const rendering: InkRendering = {
  renderer: "freehand",
  smoothing: DEFAULT_INK_PROFILE_CONFIG.smoothing,
  thinning: DEFAULT_INK_PROFILE_CONFIG.thinning,
  streamline: DEFAULT_INK_PROFILE_CONFIG.streamline,
  sizeScale: DEFAULT_INK_PROFILE_CONFIG.sizeScale,
  simulatePressure: DEFAULT_INK_PROFILE_CONFIG.simulatePressure,
};

function highlighter(fromX: number, toX: number): InkStroke {
  return {
    rendering,
    tool: "highlighter",
    color: INK_HIGHLIGHTER.color,
    weight: INK_HIGHLIGHTER.weight,
    points: Array.from({ length: 12 }, (_, i) => ({
      x: fromX + ((toX - fromX) * i) / 11,
      y: 100,
      p: 0.5,
      t: i * 8,
    })),
  };
}

describe("自然笔感的画法：轮廓填充", () => {
  it("一笔一个轮廓、填一次", () => {
    const ctx = new RecordingContext();
    paintFreehandStroke(asContext(ctx), 2, highlighter(100, 300), rendering);
    expect(ctx.fills).toEqual([{ style: INK_HIGHLIGHTER.color, subpaths: 1 }]);
    expect(ctx.ops).toEqual(["save", "setTransform 2", "restore"]);
  });

  it("没有点的笔画什么都不画，也不动画笔状态", () => {
    const ctx = new RecordingContext();
    paintFreehandStroke(
      asContext(ctx),
      1,
      { ...highlighter(100, 300), points: [] },
      rendering,
    );
    expect(ctx.fills).toEqual([]);
    expect(ctx.ops).toEqual([]);
  });

  it("一组笔画（同一笔切出来的荧光笔段）：各段的轮廓放进同一条路径、只填一次——重叠的地方不叠深", () => {
    const ctx = new RecordingContext();
    paintFreehandRun(
      asContext(ctx),
      2,
      [highlighter(100, 300), highlighter(290, 500), highlighter(480, 600)],
      rendering,
    );
    expect(ctx.fills).toEqual([{ style: INK_HIGHLIGHTER.color, subpaths: 3 }]);
    expect(ctx.ops).toEqual(["save", "setTransform 2", "restore"]);
  });

  it("组里没有点的笔画跳过", () => {
    const ctx = new RecordingContext();
    paintFreehandRun(
      asContext(ctx),
      1,
      [{ ...highlighter(100, 300), points: [] }, highlighter(290, 500)],
      rendering,
    );
    expect(ctx.fills).toEqual([{ style: INK_HIGHLIGHTER.color, subpaths: 1 }]);
  });
});
