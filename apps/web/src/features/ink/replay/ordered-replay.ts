import type { AtramentReplayCanvas } from "./draw.ts";
import type { AtramentReplayModel } from "./model.ts";

/** 仅在时间顺序与绘制顺序一致时，已画的像素才可直接保留。 */
export function createOrderedReplay(data: AtramentReplayModel) {
  let previousStart = Number.NEGATIVE_INFINITY;
  let previousDuration = 0;
  for (const [index, slot] of data.slots.entries()) {
    const stroke = data.strokes[index];
    const end = slot.pointTimesMs.at(-1);
    if (end === undefined) continue;
    if (
      stroke?.tool !== "pen" ||
      stroke.rendering?.renderer === "freehand" ||
      !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(stroke.color) ||
      slot.startMs - previousStart < previousDuration
    )
      return null;
    previousStart = slot.startMs;
    previousDuration = end;
  }

  let completed = 0;
  let points = 0;
  let previousTime = Number.NEGATIVE_INFINITY;
  let previousCanvas: AtramentReplayCanvas | null = null;
  return (canvas: AtramentReplayCanvas, time: number): void => {
    const beforeCompleted = completed;
    const beforePoints = points;
    if (time < previousTime) {
      completed = 0;
      points = 0;
    }
    for (let slot = data.slots[completed]; slot; slot = data.slots[completed]) {
      const elapsed = time - slot.startMs;
      while (
        points < slot.pointTimesMs.length &&
        (slot.pointTimesMs[points] ?? Infinity) <= elapsed
      )
        points++;
      if (points < slot.pointTimesMs.length) break;
      completed++;
      points = 0;
    }
    previousTime = time;
    if (
      previousCanvas === canvas &&
      completed === beforeCompleted &&
      points === beforePoints
    )
      return;
    previousCanvas = canvas;
    canvas.drawOrdered(
      data.strokes,
      completed,
      points > 0 ? (data.strokes[completed] ?? null) : null,
      points,
    );
  };
}
