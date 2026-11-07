import type {
  QuestionProcessBatch,
  QuestionProcessStroke,
} from "@tutor/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryKVBackend } from "@/lib/kv-backend";
import { type ProcessSurface, QuestionProcessRecorder } from "./recorder";
import { frameAt } from "./replay";

const stroke: QuestionProcessStroke = {
  id: "test-stroke",
  tool: "pen",
  weight: 2,
  color: "#222",
  points: [
    { x: 40, y: 60, t: 0, p: 0.5 },
    { x: 80, y: 60, t: 15, p: 0.5 },
  ],
};
const ink: ProcessSurface = { width: 1000, height: 800, strokes: [stroke] };
const empty: ProcessSurface = { ...ink, strokes: [] };
const active = "863de11a-f212-46e1-b876-d3a29e07df55";

afterEach(() => vi.restoreAllMocks());

describe("单题过程待传队列", () => {
  it("本机写盘失败时不上报，恢复后按原顺序补传", async () => {
    const backend = memoryKVBackend();
    const uploads: QuestionProcessBatch[] = [];
    let blocked = true;
    const recorder = new QuestionProcessRecorder({
      attemptId: "attempt",
      recordingId: active,
      expiresAt: "2099-01-01T00:00:00.000Z",
      prefix: "本次会话",
      store: {
        ...backend,
        set: async (key, value) => {
          if (blocked) throw new DOMException("磁盘已满", "QuotaExceededError");
          await backend.set(key, value);
        },
      },
      revision: () => "revision",
      current: () => true,
      snapshot: () => ({ answer: null, hints: [], layers: {} }),
      upload: async (batch) => {
        uploads.push(batch);
        return batch.events.at(-1)?.seq ?? -1;
      },
    });
    try {
      recorder.ink("q", "annotation", "stroke", undefined, ink, "up");
      await recorder.flush();
      expect(recorder.getStatus()).toBe("failed");
      expect(uploads).toHaveLength(0);

      blocked = false;
      await recorder.flush();
      expect(
        uploads.flatMap((batch) => batch.events).map((event) => event.seq),
      ).toEqual([0, 1]);
      expect(await backend.getAll("")).toEqual([]);
      expect(recorder.getStatus()).toBe("synced");

      recorder.ink("q", "scratch", "stroke", undefined, ink, "up");
      recorder.ink("q", "annotation", "erase", ink, empty, "up");
      recorder.ink("q", "annotation", "undo", empty, ink);
      recorder.ink("q", "scratch", "clear", ink, empty);
      recorder.ink("q", "scratch", "undo", empty, ink);
      recorder.ink("q", "scratch", "undo", ink, ink);
      await recorder.flush();
      const events = uploads.flatMap((batch) => batch.events);
      expect(
        events.flatMap((event) =>
          event.kind === "ink" ? [`${event.layer}:${event.operation}`] : [],
        ),
      ).toEqual([
        "annotation:stroke",
        "scratch:stroke",
        "annotation:erase",
        "annotation:undo",
        "scratch:clear",
        "scratch:undo",
      ]);
      const countsAt = (seq: number) => {
        const frame = frameAt(events, Infinity, seq);
        return [
          frame?.layers.annotation?.strokes.length,
          frame?.layers.scratch?.strokes.length,
        ];
      };
      expect(countsAt(3)).toEqual([0, 1]);
      expect(countsAt(4)).toEqual([1, 1]);
      expect(countsAt(5)).toEqual([1, 0]);
      expect(countsAt(6)).toEqual([1, 1]);
    } finally {
      await recorder.close();
    }
  });

  it("离线保存后可由新会话续传，丢回执保留原批次", async () => {
    const store = memoryKVBackend();
    const network = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const uploads: QuestionProcessBatch[] = [];
    let drop = true;
    const options = {
      attemptId: "attempt",
      recordingId: active,
      expiresAt: "2099-01-01T00:00:00.000Z",
      prefix: "本次会话",
      store,
      revision: () => "revision",
      current: () => true,
      snapshot: () => ({ answer: null, hints: [], layers: {} }),
      upload: async (batch: QuestionProcessBatch) => {
        uploads.push(batch);
        if (drop) throw new Error("丢失确认");
        return batch.events.at(-1)?.seq ?? -1;
      },
    };
    const original = new QuestionProcessRecorder(options);
    original.ink("q", "scratch", "stroke", undefined, ink, "cancel");
    original.ink("q", "scratch", "erase", ink, empty);
    original.ink("q", "scratch", "undo", empty, ink);
    original.ink("q", "scratch", "redo", ink, empty);
    await original.flush();
    expect(uploads).toHaveLength(0);
    expect((await store.getAll("")).length).toBe(5);
    await original.close();

    network.mockReturnValue(true);
    const recovered = new QuestionProcessRecorder(options);
    try {
      await recovered.flush();
      expect(uploads).toHaveLength(4);
      const previous = uploads[0];
      drop = false;
      await recovered.flush();
      expect(uploads[4]).toEqual(previous);
      expect((await store.getAll("")).length).toBe(0);
      const all = uploads.slice(4).flatMap((batch) => batch.events);
      expect(all.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(all[1]).toMatchObject({ operation: "stroke", finish: "cancel" });
      expect(all[2]).toMatchObject({
        operation: "erase",
        removed: [stroke.id],
      });
      expect(all[3]).toMatchObject({
        operation: "undo",
        added: [{ index: 0, stroke }],
      });
      expect(all[4]).toMatchObject({ operation: "redo", removed: [stroke.id] });
    } finally {
      recovered.close();
    }
  });
});
