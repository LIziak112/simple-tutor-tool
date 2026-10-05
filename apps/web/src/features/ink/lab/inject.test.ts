// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { InkEngine } from "../engine/index.ts";
import { INK_LOGICAL_WIDTH, type InkStroke } from "../engine/types.ts";
import { drivePointerEvents } from "./inject.ts";
import { buildSyntheticAtramentDoc } from "./synthetic-strokes.ts";

/**
 * 合成输入驱动器测试（T6R.1 simplify 下沉后补）：
 * - setTool 只在工具配置变化时下发（含首笔），同档连续笔画不重复下发；
 * - 坐标按 INK_LOGICAL_WIDTH 与画布 rect 等比换算（非硬编码 1000）；
 * - 进度回调按 progressEvery 节流（首笔与末笔必报）；
 * - 每笔完整 down/move…/up 序列、pointerType=pen。
 */

/** 极简引擎桩：只记录 setTool 调用（事件经真实 canvas dispatch） */
function fakeEngine(): { engine: InkEngine; setToolCalls: unknown[] } {
  const setToolCalls: unknown[] = [];
  const engine = {
    setTool: (tool: unknown) => setToolCalls.push(tool),
  } as unknown as InkEngine;
  return { engine, setToolCalls };
}

function penStrokeOf(color: string, weight: number): InkStroke {
  return {
    tool: "pen",
    color,
    weight,
    points: [
      { x: 100, y: 100, p: 0.5, t: 0 },
      { x: 200, y: 110, p: 0.5, t: 10 },
    ],
  };
}

function setupCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  return canvas;
}

describe("drivePointerEvents", () => {
  it("setTool 首笔下发、同配置连续笔画不重复、变化时再下发", async () => {
    const { engine, setToolCalls } = fakeEngine();
    const canvas = setupCanvas();
    const strokes: InkStroke[] = [
      penStrokeOf("#1f2328", 4),
      penStrokeOf("#1f2328", 4),
      penStrokeOf("#1d4ed8", 2.5),
      {
        tool: "highlighter",
        color: "rgba(250, 204, 21, 0.45)",
        weight: 16,
        points: [{ x: 1, y: 1, p: 0.5, t: 0 }],
      },
      penStrokeOf("#1f2328", 4),
    ];
    await drivePointerEvents(engine, canvas, strokes);
    expect(setToolCalls).toEqual([
      { type: "pen", color: "black", size: "medium" },
      { type: "pen", color: "blue", size: "thin" },
      { type: "highlighter" },
      { type: "pen", color: "black", size: "medium" },
    ]);
    canvas.remove();
  });

  it("坐标按画布宽度与 INK_LOGICAL_WIDTH 等比换算", async () => {
    const { engine } = fakeEngine();
    const canvas = setupCanvas();
    // jsdom 无真实布局：clientWidth=0，rect 宽以显式 mock 提供
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 20,
      width: 500,
      height: 720,
      right: 510,
      bottom: 740,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    } as DOMRect);
    const seen: { type: string; x: number; y: number }[] = [];
    canvas.addEventListener("pointerdown", (e) => {
      const pe = e as PointerEvent;
      seen.push({ type: pe.type, x: pe.clientX, y: pe.clientY });
    });
    await drivePointerEvents(engine, canvas, [penStrokeOf("#1f2328", 4)]);
    const scale = 500 / INK_LOGICAL_WIDTH;
    expect(seen[0]).toEqual({
      type: "pointerdown",
      x: 10 + 100 * scale,
      y: 20 + 100 * scale,
    });
    canvas.remove();
  });

  it("进度按 progressEvery 节流，首笔与末笔必报", async () => {
    const { engine } = fakeEngine();
    const canvas = setupCanvas();
    const doc = buildSyntheticAtramentDoc({
      seed: 7,
      strokeCount: 10,
      pointsPerStroke: 3,
    });
    const progress: string[] = [];
    await drivePointerEvents(engine, canvas, doc.data.strokes, {
      progressEvery: 4,
      onProgress: (done, total) => progress.push(`${done}/${total}`),
    });
    // 10 笔、节流 4：首笔(1)、4、8、末笔(10)
    expect(progress).toEqual(["1/10", "4/10", "8/10", "10/10"]);
    canvas.remove();
  });

  it("每笔派发完整 down + move… + up，pointerType=pen", async () => {
    const { engine } = fakeEngine();
    const canvas = setupCanvas();
    const types: string[] = [];
    const pointerTypes: string[] = [];
    for (const t of ["pointerdown", "pointermove", "pointerup"] as const) {
      canvas.addEventListener(t, (e) => {
        types.push(e.type);
        pointerTypes.push((e as PointerEvent).pointerType);
      });
    }
    await drivePointerEvents(engine, canvas, [penStrokeOf("#1f2328", 4)]);
    expect(types).toEqual(["pointerdown", "pointermove", "pointerup"]);
    expect(new Set(pointerTypes)).toEqual(new Set(["pen"]));
    canvas.remove();
  });
  it("整笔越界的笔画被计数为 droppedStrokes 并跳过派发", async () => {
    const { engine } = fakeEngine();
    const canvas = setupCanvas();
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 500,
      height: 300,
      right: 500,
      bottom: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    // 纸高 800、宽换算 500/1000=0.5 → CSS y 最大 400 > 300：底部笔画整笔越界
    const doc = buildSyntheticAtramentDoc({
      seed: 42,
      strokeCount: 40,
      pointsPerStroke: 4,
    });
    const before = doc.data.strokes.filter((st) => {
      const maxY = Math.max(...st.points.map((pt) => pt.y));
      const minY = Math.min(...st.points.map((pt) => pt.y));
      const maxX = Math.max(...st.points.map((pt) => pt.x));
      const minX = Math.min(...st.points.map((pt) => pt.x));
      return (
        (maxY * 500) / INK_LOGICAL_WIDTH < 0 ||
        (minY * 500) / INK_LOGICAL_WIDTH > 300 ||
        (maxX * 500) / INK_LOGICAL_WIDTH < 0 ||
        (minX * 500) / INK_LOGICAL_WIDTH > 500
      );
    }).length;
    const dispatchSpy = vi.fn();
    canvas.addEventListener("pointerdown", dispatchSpy);
    const result = await drivePointerEvents(engine, canvas, doc.data.strokes);
    expect(result.droppedStrokes).toBe(before);
    canvas.remove();
  });

  it("同配置连续笔画在节流边界重设工具（注入期工具栏被点击的自愈）", async () => {
    const { engine, setToolCalls } = fakeEngine();
    const canvas = setupCanvas();
    const doc = buildSyntheticAtramentDoc({
      seed: 2026,
      strokeCount: 60,
      pointsPerStroke: 3,
    });
    // progressEvery=10：边界笔（第 10/20/…笔索引 9/19/…）即使工具键未变也会重设
    await drivePointerEvents(engine, canvas, doc.data.strokes, {
      progressEvery: 10,
    });
    // 首笔 + 每个键变化 + 每个边界（含重叠）——至少多于纯键变化数
    expect(setToolCalls.length).toBeGreaterThanOrEqual(7);
    canvas.remove();
  });
});
