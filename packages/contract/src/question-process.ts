import { z } from "zod";
import { questionPublicSchema } from "./content.ts";
import { studentAnswerSchema } from "./grading.ts";
import {
  inkExcalidrawDataSchema,
  inkStrokeIdSchema,
  inkStrokeSchema,
} from "./ink.ts";
import { noteBackgroundSchema } from "./note.ts";

export const QUESTION_PROCESS_RETENTION_DAYS = 30;
export const QUESTION_PROCESS_MAX_BATCH_BYTES = 2 * 1024 * 1024;
export const QUESTION_PROCESS_MAX_QUESTION_BYTES = 8 * 1024 * 1024;
export const QUESTION_PROCESS_MAX_EVENTS = 2500;

const index = z.number().int().min(0).max(100_000);
const layer = z.enum(["annotation", "scratch", "answer"]);
export const questionProcessFinishSchema = z.enum([
  "up",
  "cancel",
  "lostpointercapture",
  "blur",
  "layoutchange",
  "superseded",
]);
const stroke = inkStrokeSchema
  .extend({
    id: inkStrokeIdSchema,
    points: inkStrokeSchema.shape.points.min(1).max(10_000),
  })
  .strict();
const frame = z.strictObject({
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  background: noteBackgroundSchema.optional(),
  baseId: z.uuid().optional(),
  baseFingerprint: z
    .string()
    .max(32)
    .regex(/^[a-f0-9]+-[a-f0-9]+-[a-f0-9]+$/)
    .optional(),
  baseHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const surface = frame.extend({
  strokes: z.array(stroke).max(4000),
  legacy: inkExcalidrawDataSchema.optional(),
});
const order = {
  seq: index,
  at: z.number().int().nonnegative().max(604_800_000),
};
const requestId = z.string().min(1).max(64);

export const questionProcessEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...order,
    kind: z.literal("start"),
    answer: studentAnswerSchema.nullable(),
    hints: z.array(index).max(100),
    layers: z.strictObject({
      annotation: surface.optional(),
      scratch: surface.optional(),
      answer: surface.optional(),
    }),
  }),
  z.strictObject({ ...order, kind: z.literal("surface"), layer, surface }),
  z.strictObject({
    ...order,
    kind: z.literal("ink"),
    layer,
    operation: z.enum(["stroke", "erase", "undo", "redo", "clear"]),
    frame: frame.optional(),
    finish: questionProcessFinishSchema.optional(),
    removed: z.array(inkStrokeIdSchema).max(4000),
    added: z.array(z.strictObject({ index, stroke })).max(4000),
  }),
  z.strictObject({
    ...order,
    kind: z.literal("answer"),
    answer: studentAnswerSchema.nullable(),
  }),
  z.strictObject({
    ...order,
    kind: z.literal("hint"),
    action: z.enum(["request", "received", "failed", "shown"]),
    requestId,
    index,
  }),
  z.strictObject({
    ...order,
    kind: z.literal("boundary"),
    reason: z.enum([
      "offline",
      "online",
      "hidden",
      "visible",
      "closed",
      "interrupted",
    ]),
  }),
]);

export const questionProcessBatchSchema = z
  .strictObject({
    version: z.literal(1),
    recordingId: z.uuid(),
    questionId: z.string().min(1).max(512),
    revisionId: z.string().min(1).max(100),
    segmentId: z.uuid(),
    startedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    events: z.array(questionProcessEventSchema).min(1).max(64),
  })
  .superRefine(({ events }, ctx) => {
    for (const [i, event] of events.entries()) {
      const prev = events[i - 1];
      if (
        (event.kind === "start") !== (event.seq === 0) ||
        (prev && (event.seq !== prev.seq + 1 || event.at < prev.at))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["events", i],
          message: "采集段事件顺序无效",
        });
      }
    }
  });

export const questionProcessStatusSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("unavailable") }),
  z.strictObject({ state: z.literal("available") }),
  z.strictObject({ state: z.literal("closed") }),
  z.strictObject({
    state: z.literal("active"),
    recordingId: z.uuid(),
    expiresAt: z.string(),
    canCapture: z.boolean(),
  }),
]);
export const questionProcessReadSchema = z.strictObject({
  question: questionPublicSchema,
  segments: z.array(
    z.strictObject({
      id: z.uuid(),
      startedAt: z.number().int(),
      events: z.array(questionProcessEventSchema),
      gap: z.boolean(),
    }),
  ),
});
export type QuestionProcessEvent = z.infer<typeof questionProcessEventSchema>;
export type QuestionProcessEventInput = QuestionProcessEvent extends infer E
  ? E extends QuestionProcessEvent
    ? Omit<E, "seq" | "at">
    : never
  : never;
export type QuestionProcessBatch = z.infer<typeof questionProcessBatchSchema>;
export type QuestionProcessStatus = z.infer<typeof questionProcessStatusSchema>;
export type QuestionProcessRead = z.infer<typeof questionProcessReadSchema>;
export type QuestionProcessLayer = z.infer<typeof layer>;
export type QuestionProcessFinish = z.infer<typeof questionProcessFinishSchema>;
export type QuestionProcessSurface = z.infer<typeof surface>;
export type QuestionProcessStroke = z.infer<typeof stroke>;
