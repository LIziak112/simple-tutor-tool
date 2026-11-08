import { z } from "zod";
import type { KVStoreBackend } from "@/lib/kv-backend";

const seenSchema = z.record(z.string(), z.number().int().min(0).array());
/** 与待发批次使用不同命名空间；随同账号、作答及录制隔离和删除。 */
export class ProcessShownHints {
  readonly key: string;
  #seen: Record<string, number[]> = {};
  #loaded: Promise<void> | undefined;
  #writing = Promise.resolve();
  constructor(
    readonly store: KVStoreBackend,
    prefix: string,
    recordingId: string,
  ) {
    this.key = JSON.stringify([prefix, "shown", recordingId]);
  }
  load() {
    this.#loaded ??= this.store
      .get(this.key)
      .then((raw) => {
        this.#seen = raw === undefined ? {} : seenSchema.parse(raw);
      })
      .catch((error) => {
        this.#loaded = undefined;
        throw error;
      });
    return this.#loaded;
  }
  read(questionId: string, unlocked: readonly number[]) {
    return (this.#seen[questionId] ?? []).filter((index) =>
      unlocked.includes(index),
    );
  }
  add(questionId: string, index: number) {
    const seen = this.#seen[questionId] ?? [];
    if (seen.includes(index)) return this.#writing;
    this.#seen = { ...this.#seen, [questionId]: [...seen, index] };
    const snapshot = this.#seen;
    this.#writing = this.#writing
      .catch(() => {})
      .then(() => this.store.set(this.key, snapshot));
    return this.#writing;
  }
}
