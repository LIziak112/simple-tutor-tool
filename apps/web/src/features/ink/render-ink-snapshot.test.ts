import type { InkDoc } from "@tutor/contract";
import { expect, it, vi } from "vitest";
import { renderNotePage } from "@/features/notes/render-note";
import { planInkSnapshot, renderInkSnapshot } from "./render-ink-snapshot";

vi.mock("@/features/notes/render-note", () => ({
  renderNotePage: vi.fn(async (_doc, page) => ({
    ...page,
    blob: new Blob(["固定稿"], { type: "image/png" }),
  })),
}));
const doc: Extract<InkDoc, { engine: "atrament" }> = {
  engine: "atrament",
  version: 1,
  updatedAt: 1,
  data: {
    width: 1000,
    strokes: [
      {
        tool: "pen",
        color: "#000",
        weight: 4,
        points: [{ x: 20, y: 5000, p: 0.5, t: 0 }],
      },
    ],
  },
};
it("完整覆盖长稿且约束图片尺寸，不裁掉末尾笔画", () => {
  const plan = planInkSnapshot(doc);
  expect(plan.crop.height).toBeGreaterThan(5000);
  expect(plan.pixelHeight).toBeLessThanOrEqual(4096);
  expect(plan.pixelWidth).toBeLessThan(1000);
  expect(() =>
    planInkSnapshot({
      ...doc,
      data: {
        width: 1000,
        strokes: [
          {
            tool: "pen",
            color: "#000",
            weight: 4,
            points: [{ x: 1, y: 20000, p: 0.5, t: 0 }],
          },
        ],
      },
    }),
  ).toThrow("纸面过长");
});
it("重绘传入固定稿与白底，不访问活画布", async () => {
  await renderInkSnapshot(doc);
  expect(renderNotePage).toHaveBeenCalledWith(
    expect.objectContaining({ ink: doc.data, background: "white" }),
    planInkSnapshot(doc),
  );
});
