import {
  annotationPngFingerprint,
  QUESTION_PROCESS_MAX_BATCH_BYTES,
  QUESTION_PROCESS_MAX_EVENTS,
  QUESTION_PROCESS_MAX_QUESTION_BYTES,
  type QuestionProcessBatch,
  type QuestionProcessEvent,
  type QuestionProcessEventInput,
  type QuestionProcessLayer,
  type QuestionProcessSurface,
  questionProcessBatchSchema,
  type StudentAnswer,
} from "@tutor/contract";
import { ApiError } from "@/lib/api";
import type { KVStoreBackend } from "@/lib/kv-backend";
import { randomUuid } from "@/lib/uuid";

type Start = Extract<QuestionProcessEventInput, { kind: "start" }>;
type Ink = Extract<QuestionProcessEventInput, { kind: "ink" }>;
export type ProcessSurface = QuestionProcessSurface & {
  png?: Blob | undefined;
};
type Snapshot = Omit<Start, "kind" | "layers"> & {
  layers: Partial<Record<QuestionProcessLayer, ProcessSurface>>;
};
interface Track {
  id: string;
  seq: number;
  bytes: number;
  startedAt: number;
  startClock: number;
  answer: StudentAnswer | null;
  hintRequests: Map<number, string>;
  shownHints: Set<number>;
  layers: Snapshot["layers"];
  stopped: boolean;
}
type SyncStatus = "saving" | "pending" | "synced" | "failed";
interface Pending {
  batch: QuestionProcessBatch;
  expiresAt: string;
}
interface Options {
  attemptId: string;
  recordingId: string;
  expiresAt: string;
  prefix: string;
  store: KVStoreBackend;
  revision: (questionId: string) => string | undefined;
  snapshot: (questionId: string) => Snapshot;
  current: () => boolean;
  upload: (batch: QuestionProcessBatch, signal: AbortSignal) => Promise<number>;
}

function sameSurface(
  a: ProcessSurface | undefined,
  b: ProcessSurface | undefined,
) {
  return (
    a === b ||
    (a?.width === b?.width &&
      a?.height === b?.height &&
      a?.background === b?.background &&
      (!a?.png || !b?.png || a.png === b.png) &&
      (!a?.baseId || !b?.baseId || a.baseId === b.baseId) &&
      a?.strokes.length === b?.strokes.length &&
      a?.strokes.every((stroke, i) => stroke.id === b?.strokes[i]?.id))
  );
}

export class QuestionProcessRecorder {
  readonly #tracks = new Map<string, Track>();
  readonly #hashes = new WeakMap<
    Blob,
    Promise<{ baseHash?: string; baseFingerprint?: string }>
  >();
  readonly #pending = new Map<string, Pending>();
  readonly #rejected = new Set<string>();
  readonly #text = new Map<
    string,
    { answer: StudentAnswer; timer: ReturnType<typeof setTimeout> }
  >();
  #generation = 0;
  readonly #abort = new AbortController();

  #local = Promise.resolve();
  #sending = false;
  #sync: SyncStatus = "synced";
  readonly #listeners = new Set<() => void>();

  getStatus = () => this.#sync;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #status(value: SyncStatus) {
    if (this.#sync === value) return;
    this.#sync = value;
    for (const listener of this.#listeners) listener();
  }
  #lostEvents = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly options: Options) {}

  #ensure(questionId: string) {
    if (
      this.#abort.signal.aborted ||
      !this.options.current() ||
      Date.now() >= Date.parse(this.options.expiresAt)
    )
      return undefined;
    let track = this.#tracks.get(questionId);
    if (track) return track;
    if (!this.options.revision(questionId)) return undefined;
    let snapshot: Snapshot;
    try {
      snapshot = this.options.snapshot(questionId);
    } catch {
      this.#lostEvents = true;
      this.#status("failed");
      return undefined;
    }
    track = {
      id: randomUuid(),
      seq: 0,
      bytes: 0,
      startedAt: Date.now(),
      startClock: performance.now(),
      answer: snapshot.answer,
      hintRequests: new Map(),
      shownHints: new Set(snapshot.hints),
      layers: snapshot.layers,
      stopped: false,
    };
    this.#tracks.set(questionId, track);
    this.#append(
      questionId,
      track,
      { kind: "start", ...snapshot },
      snapshot.layers,
    );
    return track;
  }

  begin(questionId: string) {
    this.#ensure(questionId);
  }

  textAnswer(questionId: string, answer: StudentAnswer) {
    if (!this.#ensure(questionId)) return;
    clearTimeout(this.#text.get(questionId)?.timer);
    this.#text.set(questionId, {
      answer,
      timer: setTimeout(() => this.commitText(questionId), 500),
    });
  }

  commitText(questionId?: string) {
    if (questionId === undefined) {
      for (const id of this.#text.keys()) this.commitText(id);
      return;
    }
    const pending = this.#text.get(questionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#text.delete(questionId);
    this.event(questionId, { kind: "answer", answer: pending.answer });
  }

  showHint(questionId: string, index: number) {
    const track = this.#ensure(questionId);
    if (!track || track.shownHints.has(index)) return;
    track.shownHints.add(index);
    this.event(questionId, {
      kind: "hint",
      action: "shown",
      requestId: track.hintRequests.get(index) ?? `restored-${index}`,
      index,
    });
  }

  event(questionId: string, input: QuestionProcessEventInput) {
    this.commitText(questionId);
    const track = this.#ensure(questionId);
    if (!track) return;
    if (input.kind === "answer") {
      if (JSON.stringify(track.answer) === JSON.stringify(input.answer)) return;
      track.answer = input.answer;
    }
    if (input.kind === "hint" && input.action === "received")
      track.hintRequests.set(input.index, input.requestId);
    this.#append(questionId, track, input);
  }

  ink(
    questionId: string,
    layer: QuestionProcessLayer,
    operation: Ink["operation"],
    before: ProcessSurface | undefined,
    after: ProcessSurface,
    finish?: Ink["finish"],
  ) {
    this.commitText(questionId);
    const track = this.#ensure(questionId);
    if (!track) return;
    if (
      !sameSurface(track.layers[layer], before) &&
      before &&
      (track.layers[layer] || before.strokes.length > 0)
    ) {
      this.#append(questionId, track, {
        kind: "boundary",
        reason: "interrupted",
      });
      this.#append(
        questionId,
        track,
        { kind: "surface", layer, surface: before },
        { [layer]: before },
      );
    }
    const previous = before?.strokes ?? [];
    const previousIds = new Set(previous.map((stroke) => stroke.id));
    const nextIds = new Set(after.strokes.map((stroke) => stroke.id));
    const removed = previous
      .filter((stroke) => !nextIds.has(stroke.id))
      .map((stroke) => stroke.id);
    const added = after.strokes.flatMap((stroke, index) =>
      previousIds.has(stroke.id) ? [] : [{ index, stroke }],
    );
    if (removed.length === 0 && added.length === 0) return;
    track.layers = { ...track.layers, [layer]: after };
    const { strokes: _strokes, png: _png, ...frame } = after;
    this.#append(
      questionId,
      track,
      {
        kind: "ink",
        layer,
        operation,
        removed,
        added,
        frame,
        ...(finish ? { finish } : {}),
      },
      { [layer]: after },
    );
  }

  boundary(
    reason: Extract<QuestionProcessEventInput, { kind: "boundary" }>["reason"],
  ) {
    this.commitText();
    for (const [questionId, track] of this.#tracks) {
      this.#append(questionId, track, { kind: "boundary", reason });
    }
  }

  #hash(png: Blob) {
    let hash = this.#hashes.get(png);
    if (!hash) {
      hash = (async () => {
        const data = await png.arrayBuffer();
        if (!crypto.subtle)
          return {
            baseFingerprint: annotationPngFingerprint(new Uint8Array(data)),
          };
        const bytes = await crypto.subtle.digest("SHA-256", data);
        return {
          baseHash: Array.from(new Uint8Array(bytes), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
        };
      })().catch(() => ({}));
      this.#hashes.set(png, hash);
    }
    return hash;
  }

  #append(
    questionId: string,
    track: Track,
    input: QuestionProcessEventInput,
    layers?: Snapshot["layers"],
  ) {
    const revisionId = this.options.revision(questionId);
    if (!revisionId || track.stopped) return;
    if (track.seq >= QUESTION_PROCESS_MAX_EVENTS) {
      track.stopped = true;
      this.#lostEvents = true;
      this.#status("failed");
      return;
    }
    this.#generation += 1;
    const seq = track.seq++;
    const at = Math.max(0, Math.round(performance.now() - track.startClock));
    const key = JSON.stringify([
      this.options.prefix,
      this.options.recordingId,
      questionId,
      track.id,
      String(seq).padStart(6, "0"),
    ]);
    this.#status(this.#lostEvents ? "failed" : "saving");
    this.#local = this.#local
      .then(async () => {
        const png = layers?.annotation?.png;
        const baseIdentity = png ? await this.#hash(png) : undefined;
        const event = { ...input, seq, at } satisfies QuestionProcessEvent;
        if (event.kind === "start") {
          const { annotation, scratch } = layers ?? {};
          const strip = ({ png: _png, ...surface }: ProcessSurface) => surface;
          event.layers = {
            ...(annotation
              ? {
                  annotation: {
                    ...strip(annotation),
                    ...baseIdentity,
                  },
                }
              : {}),
            ...(scratch ? { scratch: strip(scratch) } : {}),
          };
        } else if (event.kind === "surface") {
          const surface = layers?.[event.layer];
          if (surface) {
            const { png: _png, ...rest } = surface;
            event.surface = { ...rest, ...baseIdentity };
          }
        } else if (event.kind === "ink" && event.frame && baseIdentity) {
          event.frame = { ...event.frame, ...baseIdentity };
        }
        const batch = questionProcessBatchSchema.parse({
          version: 1,
          recordingId: this.options.recordingId,
          questionId,
          revisionId,
          segmentId: track.id,
          startedAt: track.startedAt,
          events: [event],
        });
        const bytes = new TextEncoder().encode(
          JSON.stringify(batch),
        ).byteLength;
        if (
          bytes > QUESTION_PROCESS_MAX_BATCH_BYTES ||
          track.bytes + bytes > QUESTION_PROCESS_MAX_QUESTION_BYTES
        ) {
          track.stopped = true;
          throw new Error("过程记录已达到容量上限");
        }
        track.bytes += bytes;
        this.#pending.set(key, { batch, expiresAt: this.options.expiresAt });
        try {
          await this.#persist();
          this.#status(this.#lostEvents ? "failed" : "pending");
          this.scheduleUpload();
        } catch {
          this.#status("failed");
          this.scheduleUpload(5000);
        }
      })
      .catch(() => {
        this.#lostEvents = true;
        this.#status("failed");
      });
  }

  async #persist() {
    for (const [key, entry] of this.#pending) {
      await this.options.store.set(key, entry);
      this.#pending.delete(key);
    }
  }

  scheduleUpload(delay = 250) {
    if (this.#abort.signal.aborted) return;
    if (this.#retryTimer !== undefined) {
      if (delay !== 0) return;
      clearTimeout(this.#retryTimer);
    }
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.flush();
    }, delay);
  }

  async flush() {
    if (this.#abort.signal.aborted || !this.options.current()) return;
    if (this.#sending) {
      this.scheduleUpload();
      return;
    }
    this.#sending = true;
    const generation = this.#generation;
    try {
      // 与新事件串行落盘，防止晚到的写入恢复已确认的批次。
      const persisted = this.#local.then(() => this.#persist());
      this.#local = persisted.catch(() => {});
      await persisted;
      const prefix = `${JSON.stringify([
        this.options.prefix,
        this.options.recordingId,
      ]).slice(0, -1)},`;
      const rows = (await this.options.store.getAll(prefix)).filter(
        ([key]) => !this.#rejected.has(key),
      );
      if (!navigator.onLine && rows.length > 0) {
        if (generation === this.#generation)
          this.#status(
            this.#lostEvents || this.#rejected.size ? "failed" : "pending",
          );
        return;
      }
      for (let i = 0; i < rows.length; i += 4) {
        if (this.#abort.signal.aborted || !this.options.current()) return;
        const results = await Promise.allSettled(
          rows.slice(i, i + 4).map(async ([key, raw]) => {
            if (typeof raw !== "object" || raw === null) {
              this.#rejected.add(key);
              return;
            }
            const pending = raw as Partial<Pending>;
            if (
              typeof pending.expiresAt !== "string" ||
              pending.expiresAt !== this.options.expiresAt
            )
              throw new Error("过程批次身份无效");
            const batch = questionProcessBatchSchema.parse(pending.batch);
            if (batch.recordingId !== this.options.recordingId)
              throw new Error("过程批次归属无效");
            let acceptedThrough: number;
            try {
              acceptedThrough = await this.options.upload(
                batch,
                this.#abort.signal,
              );
            } catch (error) {
              if (
                error instanceof ApiError &&
                [400, 403, 404, 409, 413].includes(error.status)
              ) {
                this.#rejected.add(key);
                return;
              }
              throw error;
            }
            if (acceptedThrough !== batch.events.at(-1)?.seq)
              throw new Error("过程回执序号不符");
            await this.options.store.del(key);
          }),
        );
        if (results.some((result) => result.status === "rejected"))
          throw new Error("过程尚未同步");
      }
      if (generation === this.#generation)
        this.#status(
          this.#lostEvents || this.#rejected.size ? "failed" : "synced",
        );
      else this.scheduleUpload();
    } catch {
      if (!this.#abort.signal.aborted) {
        this.#status("failed");
        this.scheduleUpload(5000);
      }
    } finally {
      this.#sending = false;
    }
  }

  close() {
    if (this.#abort.signal.aborted) return this.#local;
    this.boundary("closed");
    this.#abort.abort();
    clearTimeout(this.#retryTimer);
    return this.#local;
  }

  async discard() {
    await this.close();
    this.#pending.clear();
    const prefix = `${JSON.stringify([
      this.options.prefix,
      this.options.recordingId,
    ]).slice(0, -1)},`;
    const rows = await this.options.store.getAll(prefix);
    await Promise.all(rows.map(([key]) => this.options.store.del(key)));
  }
}
