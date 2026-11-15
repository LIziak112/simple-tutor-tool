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
import { ApiError } from "@/lib/api-response";

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
type SyncStatus = "saving" | "pending" | "synced" | "failed" | "inactive";
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
  canCapture?: () => boolean;
  inactiveReason?: () => string | undefined;
  onHintShown?: (questionId: string, index: number) => Promise<void>;
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
      a?.legacy === b?.legacy &&
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
  // 开放批次可在本机按 firstSeq 覆写；封批后不再修改，保证重传幂等。
  readonly #open = new Map<
    string,
    { key: string; entry: Pending; bytes: number; createdAt: number }
  >();
  readonly #rejected = new Set<string>();
  readonly #text = new Map<
    string,
    { answer: StudentAnswer; timer: ReturnType<typeof setTimeout> }
  >();
  #generation = 0;
  readonly #abort = new AbortController();

  #local = Promise.resolve();
  #sending = false;
  #sync: SyncStatus = "pending";
  #inactiveReason = "";
  #droppedEvents = 0;
  #interrupted = false;
  getInactiveReason = () => this.#inactiveReason;
  getDroppedEvents = () => this.#droppedEvents;
  invalidate(reason: string) {
    if (this.#inactiveReason === reason) return;
    const wasInactive = this.#sync === "inactive";
    this.#inactiveReason = reason;
    if (wasInactive) for (const listener of this.#listeners) listener();
    this.#interrupted = true;
    this.#tracks.clear();
    this.#local = this.#local.then(() => {
      this.#open.clear();
    });
    this.#status("inactive");
  }
  resume(expectedReason: string) {
    if (
      this.#inactiveReason !== expectedReason ||
      this.#abort.signal.aborted ||
      !this.options.current() ||
      this.options.canCapture?.() === false ||
      Date.now() >= Date.parse(this.options.expiresAt)
    )
      return;
    this.#inactiveReason = "";
    this.#status("pending");
    this.scheduleUpload(0);
  }
  #drop(reason: string) {
    this.#droppedEvents++;
    this.invalidate(reason);
    return undefined;
  }
  readonly #listeners = new Set<() => void>();

  getStatus = () => this.#sync;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #status(value: SyncStatus) {
    if (this.#inactiveReason) value = "inactive";
    if (this.#sync === value) return;
    this.#sync = value;
    for (const listener of this.#listeners) listener();
  }
  #lostEvents = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly options: Options) {}

  #ensure(questionId: string, inkStartedAt?: number) {
    if (this.#abort.signal.aborted) return this.#drop("录制器已关闭");
    if (!this.options.current()) return this.#drop("会话已变化");
    if (this.options.canCapture?.() === false)
      return this.#drop(this.options.inactiveReason?.() ?? "当前材料不可编辑");
    if (Date.now() >= Date.parse(this.options.expiresAt))
      return this.#drop("过程记录已过期");
    if (!this.options.revision(questionId)) return this.#drop("题目版本不可用");
    let track = this.#tracks.get(questionId);
    if (track) return track;
    this.#inactiveReason = "";
    let snapshot: Snapshot;
    try {
      snapshot = this.options.snapshot(questionId);
    } catch {
      this.#lostEvents = true;
      this.#status("failed");
      return undefined;
    }
    const now = Date.now();
    const startedAt =
      inkStartedAt !== undefined ? Math.min(now, inkStartedAt) : now;
    track = {
      id: randomUuid(),
      seq: 0,
      bytes: 0,
      startedAt,
      startClock: performance.now() - (now - startedAt),
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
    if (this.#interrupted)
      this.#append(questionId, track, {
        kind: "boundary",
        reason: "interrupted",
      });
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
    if (this.options.onHintShown) {
      const failed = () => {
        this.#lostEvents = true;
        this.#status("failed");
      };
      try {
        // 立即更新视口事实；持久化仍接入本机队列，供flush/close等待。
        const persisted = this.options
          .onHintShown(questionId, index)
          .catch(failed);
        this.#local = this.#local.then(() => persisted);
      } catch {
        failed();
      }
    }
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

  surface(
    questionId: string,
    layer: QuestionProcessLayer,
    surface: ProcessSurface,
  ) {
    this.commitText(questionId);
    const track = this.#ensure(questionId);
    if (!track) return;
    track.layers = { ...track.layers, [layer]: surface };
    this.#append(
      questionId,
      track,
      { kind: "surface", layer, surface },
      { [layer]: surface },
    );
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
    const track = this.#ensure(
      questionId,
      operation === "stroke" ? after.strokes.at(-1)?.startedAt : undefined,
    );
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
    if (!revisionId) return this.#drop("题目版本不可用");
    if (track.stopped) return;
    if (track.seq >= QUESTION_PROCESS_MAX_EVENTS) {
      track.stopped = true;
      this.#lostEvents = true;
      this.#status("failed");
      return;
    }
    this.#generation += 1;
    const seq = track.seq++;
    const at =
      input.kind === "start"
        ? 0
        : Math.max(0, Math.round(performance.now() - track.startClock));
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
          const { annotation, scratch, answer } = layers ?? {};
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
            ...(answer ? { answer: strip(answer) } : {}),
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
        let open = this.#open.get(questionId);
        const metadata = {
          version: 1,
          recordingId: this.options.recordingId,
          questionId,
          revisionId,
          segmentId: track.id,
          startedAt: track.startedAt,
        };
        const sizeOf = (value: unknown) =>
          new TextEncoder().encode(JSON.stringify(value)).byteLength;
        let batch = questionProcessBatchSchema.parse({
          ...metadata,
          events: [...(open?.entry.batch.events ?? []), event],
        });
        let bytes = sizeOf(batch);
        if (
          open &&
          (bytes >= 1.5 * 1024 * 1024 || Date.now() - open.createdAt >= 1000)
        ) {
          this.#open.delete(questionId);
          open = undefined;
          batch = questionProcessBatchSchema.parse({
            ...metadata,
            events: [event],
          });
          bytes = sizeOf(batch);
        }
        const increase = bytes - (open?.bytes ?? 0);
        if (
          bytes > QUESTION_PROCESS_MAX_BATCH_BYTES ||
          track.bytes + increase > QUESTION_PROCESS_MAX_QUESTION_BYTES
        ) {
          track.stopped = true;
          throw new Error("过程记录已达到容量上限");
        }
        track.bytes += increase;
        const batchKey = open?.key ?? key;
        const entry = { batch, expiresAt: this.options.expiresAt };
        this.#open.set(questionId, {
          key: batchKey,
          entry,
          bytes,
          createdAt: open?.createdAt ?? Date.now(),
        });
        this.#pending.set(batchKey, entry);
        const seal =
          batch.events.length >= 64 ||
          bytes >= 1.5 * 1024 * 1024 ||
          (event.kind === "boundary" &&
            ["offline", "hidden", "closed"].includes(event.reason));
        if (seal) this.#open.delete(questionId);
        try {
          await this.#persist();
          this.#status(this.#lostEvents ? "failed" : "pending");
          this.scheduleUpload(seal ? 0 : 1000);
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
      const persisted = this.#local.then(() => {
        this.#open.clear();
        return this.#persist();
      });
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
      // 同一段必须按 firstSeq 上传；首批失败后不越过缺口。
      rows.sort(([a], [b]) => a.localeCompare(b));
      for (let i = 0; i < rows.length; i += 1) {
        if (this.#abort.signal.aborted || !this.options.current()) return;
        const results = await Promise.allSettled(
          rows.slice(i, i + 1).map(async ([key, raw]) => {
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
    this.#open.clear();
    const prefix = `${JSON.stringify([
      this.options.prefix,
      this.options.recordingId,
    ]).slice(0, -1)},`;
    const rows = await this.options.store.getAll(prefix);
    await Promise.all(rows.map(([key]) => this.options.store.del(key)));
  }
}
