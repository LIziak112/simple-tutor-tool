import { inkDocSchema } from "@tutor/contract";
import { z } from "zod";

export type FeelLane = "baseline" | "responsive" | "freehand";
const paramsSchema = z.object({
  thinning: z.number().min(0).max(1),
  smoothing: z.number().min(0).max(1),
  streamline: z.number().min(0).max(1),
  sizeScale: z.number().min(0.5).max(2),
  prediction: z.boolean(),
  simulatePressure: z.boolean(),
});
const draftSchema = z.object({
  doc: inkDocSchema.refine(
    (doc) => doc.engine === "atrament",
    "实验稿必须是点序列",
  ),
  params: paramsSchema,
  smoothing: z.number().min(0).max(1.5),
});
export type FeelDraft = z.infer<typeof draftSchema>;
const key = (lane: FeelLane) => `ownclass:ink-feel:${lane}`;

/** 实验稿与正式作答仓完全隔离；失败由页面呈现，不吞掉配额错误。 */
export function readFeelDraft(lane: FeelLane): FeelDraft | null {
  const raw = localStorage.getItem(key(lane));
  return raw === null ? null : draftSchema.parse(JSON.parse(raw));
}
export function writeFeelDraft(lane: FeelLane, draft: FeelDraft): void {
  localStorage.setItem(key(lane), JSON.stringify(draftSchema.parse(draft)));
}
