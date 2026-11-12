import { expect, it } from "vitest";
import type { InkStroke } from "../engine/types";
import { type AtramentReplayModel, frameAt } from "./model.ts";
import { createOrderedReplay } from "./ordered-replay.ts";

it("拉伸时序的浮点边界由完整帧保留同时出现的下一笔", () => {
  const point = { x: 10, y: 10, p: 0.5, t: 0 };
  const stroke: InkStroke = {
    tool: "pen",
    color: "#000000",
    weight: 2,
    points: [point, point],
  };
  const data: AtramentReplayModel = {
    engine: "atrament",
    strokes: [stroke, stroke],
    durationMs: 2000,
    slots: [
      { startMs: 571.4285714285714, pointTimesMs: [0, 1428.5714285714287] },
      { startMs: 2000, pointTimesMs: [0, 0] },
    ],
    contentHeight: 400,
    timing: "real",
    pauses: [],
    deletedSlots: [],
  };
  expect(frameAt(data, 2000)).toEqual({
    engine: "atrament",
    visiblePoints: [1, 2],
  });
  expect(createOrderedReplay(data)).toBeNull();
});
