import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InkStroke } from "../engine/types";
import { createAtramentReplayCanvas } from "./draw";

const { beginStroke, draw, endStroke } = vi.hoisted(() => ({
  beginStroke: vi.fn(),
  draw: vi.fn((x: number, y: number) => ({ x, y })),
  endStroke: vi.fn(),
}));
vi.mock("../engine/atrament-adapter.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../engine/atrament-adapter.ts")>()),
  createProgrammaticAtrament: () => ({
    beginStroke,
    draw,
    endStroke,
    destroy: vi.fn(),
  }),
}));

const clearRect = vi.fn();
const point = { x: 20, y: 20, p: 0.5, t: 0 };
const stroke = (): InkStroke => ({
  tool: "pen",
  color: "#000000",
  weight: 4,
  points: [{ ...point }],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    clearRect,
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => vi.restoreAllMocks());

it("运笔只绘制新增采样，收笔补齐末点且不重画旧笔", () => {
  const canvas = createAtramentReplayCanvas(document.createElement("div"));
  const old = [stroke(), stroke()];
  const active = stroke();
  canvas.drawOrdered(old, old.length, active, 1);
  expect(clearRect).toHaveBeenCalledTimes(1);
  expect(draw).toHaveBeenCalledTimes(3);

  active.points.push({ ...point, x: 40 });
  canvas.drawOrdered(old, old.length, active, 2);
  active.points.push({ ...point, x: 80 });
  const committed = [...old, active];
  canvas.drawOrdered(committed, committed.length, null, 0);
  canvas.drawOrdered(committed, committed.length, null, 0);
  expect(clearRect).toHaveBeenCalledTimes(1);
  expect(draw).toHaveBeenCalledTimes(5);
  expect(endStroke).toHaveBeenCalledTimes(3);
  canvas.destroy();
});

it("丢弃在途笔和擦除旧笔后按现存矢量重新绘制", () => {
  const canvas = createAtramentReplayCanvas(document.createElement("div"));
  const old = [stroke(), stroke()];
  canvas.drawOrdered(old, 2, stroke(), 1);
  canvas.drawOrdered(old, 2, null, 0);
  canvas.drawOrdered(old.slice(1), 1, null, 0);
  expect(clearRect).toHaveBeenCalledTimes(3);
  expect(draw).toHaveBeenCalledTimes(6);
  canvas.destroy();
});
