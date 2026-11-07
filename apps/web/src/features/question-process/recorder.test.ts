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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("单题过程待传队列", () => {
  it("会话失效、过期、缺版本、已关闭均显式失效并计数丢弃", async () => {
    for (const cause of ["session", "expired", "revision", "closed"]) {
      const upload = vi.fn(
        async (batch: QuestionProcessBatch) => batch.events.at(-1)?.seq ?? -1,
      );
      const recorder = new QuestionProcessRecorder({
        attemptId: "attempt",
        recordingId: active,
        expiresAt:
          cause === "expired"
            ? "2000-01-01T00:00:00.000Z"
            : "2099-01-01T00:00:00.000Z",
        prefix: cause,
        store: memoryKVBackend(),
        revision: () => (cause === "revision" ? undefined : "revision"),
        current: () => cause !== "session",
        snapshot: () => ({ answer: null, hints: [], layers: {} }),
        upload,
      });
      if (cause === "closed") await recorder.close();
      recorder.event("q", {
        kind: "answer",
        answer: { kind: "choice", index: 1 },
      });
      await recorder.flush();
      expect(upload).not.toHaveBeenCalled();
      expect(recorder.getStatus()).toBe("inactive");
      expect(recorder.getInactiveReason()).not.toBe("");
      expect(recorder.getDroppedEvents()).toBe(1);
      await recorder.close();
    }
  });

  it("材料不可编辑时不再显示已同步，恢复以新快照和中断边界续录", async () => {
    const uploads: QuestionProcessBatch[] = [];
    let ready = true;
    const recorder = new QuestionProcessRecorder({
      attemptId: "attempt",
      recordingId: active,
      expiresAt: "2099-01-01T00:00:00.000Z",
      prefix: "recovery",
      store: memoryKVBackend(),
      revision: () => "revision",
      current: () => true,
      canCapture: () => ready,
      inactiveReason: () => "材料正在恢复，暂不可编辑",
      snapshot: () => ({ answer: null, hints: [], layers: {} }),
      upload: async (batch) => {
        uploads.push(batch);
        return batch.events.at(-1)?.seq ?? -1;
      },
    });
    recorder.begin("q");
    ready = false;
    recorder.event("q", {
      kind: "answer",
      answer: { kind: "choice", index: 1 },
    });
    expect(recorder.getStatus()).toBe("inactive");
    expect(recorder.getInactiveReason()).toContain("材料正在恢复");
    ready = true;
    recorder.resume("材料正在恢复，暂不可编辑");
    expect(recorder.getInactiveReason()).toBe("");
    expect(recorder.getStatus()).not.toBe("inactive");
    recorder.event("q", {
      kind: "answer",
      answer: { kind: "choice", index: 0 },
    });
    await recorder.flush();
    expect(recorder.getStatus()).toBe("synced");
    expect(new Set(uploads.map((batch) => batch.segmentId)).size).toBe(2);
    expect(
      uploads
        .flatMap((batch) => batch.events)
        .filter((event) => event.kind === "boundary"),
    ).toEqual([expect.objectContaining({ reason: "interrupted" })]);
    expect(
      uploads
        .flatMap((batch) => batch.events)
        .filter((event) => event.kind === "answer"),
    ).toEqual([
      expect.objectContaining({ answer: { kind: "choice", index: 0 } }),
    ]);
    await recorder.close();
  });

  it("连续20笔合为最多两个上传批次，序号连续", async () => {
    const uploads: QuestionProcessBatch[] = [];
    const recorder = new QuestionProcessRecorder({
      attemptId: "attempt",
      recordingId: active,
      expiresAt: "2099-01-01T00:00:00.000Z",
      prefix: "batch-test",
      store: memoryKVBackend(),
      revision: () => "revision",
      current: () => true,
      snapshot: () => ({ answer: null, hints: [], layers: {} }),
      upload: async (batch) => {
        uploads.push(batch);
        return batch.events.at(-1)?.seq ?? -1;
      },
    });
    let before = empty;
    for (let i = 0; i < 20; i++) {
      const after = {
        ...ink,
        strokes: [...before.strokes, { ...stroke, id: `stroke-${i}` }],
      };
      recorder.ink("q", "scratch", "stroke", before, after, "up");
      before = after;
    }
    await recorder.flush();
    expect(uploads.length).toBeLessThanOrEqual(2);
    expect(
      uploads.flatMap((batch) => batch.events).map((event) => event.seq),
    ).toEqual(Array.from({ length: 21 }, (_, i) => i));
    await recorder.close();
  });

  it("达到64事件封批，flush保持同段顺序", async () => {
    const uploads: QuestionProcessBatch[] = [];
    const recorder = new QuestionProcessRecorder({
      attemptId: "attempt",
      recordingId: active,
      expiresAt: "2099-01-01T00:00:00.000Z",
      prefix: "64-events",
      store: memoryKVBackend(),
      revision: () => "revision",
      current: () => true,
      snapshot: () => ({ answer: null, hints: [], layers: {} }),
      upload: async (batch) => {
        uploads.push(batch);
        return batch.events.at(-1)?.seq ?? -1;
      },
    });
    for (let i = 0; i < 70; i++)
      recorder.event("q", {
        kind: "answer",
        answer: { kind: "choice", index: i % 2 },
      });
    await recorder.flush();
    expect(uploads.map((batch) => batch.events.length)).toEqual([64, 7]);
    expect(
      uploads.flatMap((batch) => batch.events).map((event) => event.seq),
    ).toEqual(Array.from({ length: 71 }, (_, i) => i));
    await recorder.close();
  });

  it("开放批次立即落盘，1秒后上传；飞行中的批次不被新事件改写", async () => {
    vi.useFakeTimers();
    const store = memoryKVBackend();
    const uploads: QuestionProcessBatch[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recorder = new QuestionProcessRecorder({
      attemptId: "attempt",
      recordingId: active,
      expiresAt: "2099-01-01T00:00:00.000Z",
      prefix: "timer",
      store,
      revision: () => "revision",
      current: () => true,
      snapshot: () => ({ answer: null, hints: [], layers: {} }),
      upload: async (batch) => {
        uploads.push(batch);
        if (uploads.length === 1) await gate;
        return batch.events.at(-1)?.seq ?? -1;
      },
    });
    recorder.event("q", {
      kind: "answer",
      answer: { kind: "choice", index: 0 },
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(await store.getAll("")).toHaveLength(1);
    expect(uploads).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(uploads).toHaveLength(1);
    recorder.event("q", {
      kind: "answer",
      answer: { kind: "choice", index: 1 },
    });
    expect(uploads[0]?.events.map((event) => event.seq)).toEqual([0, 1]);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    await recorder.flush();
    expect(
      uploads.map((batch) => batch.events.map((event) => event.seq)),
    ).toEqual([[0, 1], [2]]);
    await recorder.close();
  });

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
    expect((await store.getAll("")).length).toBe(1);
    await original.close();

    network.mockReturnValue(true);
    const recovered = new QuestionProcessRecorder(options);
    try {
      await recovered.flush();
      expect(uploads).toHaveLength(1);
      const previous = uploads[0];
      drop = false;
      await recovered.flush();
      expect(uploads[1]).toEqual(previous);
      expect((await store.getAll("")).length).toBe(0);
      const all = uploads.slice(1).flatMap((batch) => batch.events);
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

it("材料不可编辑仍续传已落盘批次，结果页新实例也能补传", async () => {
  const store = memoryKVBackend();
  const network = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const uploads: QuestionProcessBatch[] = [];
  const options = {
    attemptId: "attempt",
    recordingId: active,
    expiresAt: "2099-01-01T00:00:00.000Z",
    prefix: "late-upload",
    store,
    revision: () => "revision",
    current: () => true,
    canCapture: () => false,
    snapshot: () => ({ answer: null, hints: [], layers: {} }),
    upload: async (batch: QuestionProcessBatch) => {
      uploads.push(batch);
      return batch.events.at(-1)?.seq ?? -1;
    },
  };
  const original = new QuestionProcessRecorder({
    ...options,
    canCapture: () => true,
  });
  original.event("q", { kind: "answer", answer: { kind: "choice", index: 1 } });
  await original.close();
  network.mockReturnValue(true);
  const review = new QuestionProcessRecorder(options);
  await review.flush();
  expect(
    uploads.flatMap((batch) => batch.events).map((event) => event.kind),
  ).toEqual(["start", "answer", "boundary"]);
  expect(await store.getAll("")).toEqual([]);
  review.event("q", { kind: "answer", answer: { kind: "choice", index: 0 } });
  expect(review.getStatus()).toBe("inactive");
  expect(review.getDroppedEvents()).toBe(1);
  await review.close();
});
