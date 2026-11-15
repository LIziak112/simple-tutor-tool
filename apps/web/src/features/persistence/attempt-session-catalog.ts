import type { AttemptOpenedQuery, AttemptSummary } from "@tutor/contract";
import { createStore, del, get, set, update } from "idb-keyval";
import {
  currentDraftSession,
  getDraftSessionEpoch,
  type KVBackend,
  memoryBackend,
} from "./draft-store";

/** 只存来源和版本凭据；正文继续由既有本机草稿仓保存。 */
export interface LocalAttemptSession {
  attempt: AttemptSummary;
  questions: Record<string, number | null>;
  questionRevisions?: Record<string, string>;
  materials?: string[];
  migratedTo?: string;
  notice?: string;
  preservedAttemptId?: string;
  quarantined?: boolean;
}
let storage: KVBackend | undefined;
function backend(): KVBackend {
  if (storage) return storage;
  if (typeof indexedDB === "undefined") {
    storage = memoryBackend();
    return storage;
  }
  const store = createStore("tutor-attempt-sessions", "sessions");
  storage = {
    get: (key) => get(key, store),
    set: (key, value) => set(key, value, store),
    del: (key) => del(key, store),
    update: (key, change) => update(key, change, store),
  };
  return storage;
}
export function installAttemptSessionBackend(value: KVBackend): void {
  storage = value;
}
function keyOf(): string | null {
  const session = currentDraftSession();
  return session ? JSON.stringify([session.origin, session.studentId]) : null;
}
export async function readLocalAttemptSessions(): Promise<
  Record<string, LocalAttemptSession>
> {
  const key = keyOf();
  const epoch = getDraftSessionEpoch();
  if (!key) return {};
  const value = await backend().get(key);
  if (epoch !== getDraftSessionEpoch())
    throw new Error("作答会话已切换，请重新打开练习");
  return (value ?? {}) as Record<string, LocalAttemptSession>;
}
let tail = Promise.resolve();
export async function saveLocalAttemptSession(
  value: LocalAttemptSession,
): Promise<void> {
  const key = keyOf();
  const epoch = getDraftSessionEpoch();
  if (!key) return;
  const store = backend();
  const write = async () => {
    if (epoch !== getDraftSessionEpoch()) return;
    if (store.update) {
      await store.update(key, (raw) => {
        const current = (raw ?? {}) as Record<string, LocalAttemptSession>;
        return {
          ...current,
          [value.attempt.id]: { ...current[value.attempt.id], ...value },
        };
      });
      return;
    }
    const current = ((await store.get(key)) ?? {}) as Record<
      string,
      LocalAttemptSession
    >;
    if (epoch !== getDraftSessionEpoch()) return;
    await store.set(key, { ...current, [value.attempt.id]: value });
  };
  const task = tail.then(write, write);
  tail = task.catch(() => {});
  await task;
}
export function localAttemptSource(
  attempt: AttemptSummary,
): AttemptOpenedQuery | null {
  switch (attempt.sourceType) {
    case "course":
      return {
        sourceType: "course",
        courseId: attempt.courseId,
        unitId: attempt.unitId,
      };
    case "assignment":
      return { sourceType: "assignment", assignmentId: attempt.assignmentId };
    case "lesson":
      return {
        sourceType: "lesson",
        lectureId: attempt.lectureId,
        ...(attempt.courseId ? { courseId: attempt.courseId } : {}),
      };
    default:
      return null;
  }
}
export function sameAttemptSource(
  a: AttemptSummary,
  b: AttemptSummary,
): boolean {
  return (
    JSON.stringify(localAttemptSource(a)) ===
      JSON.stringify(localAttemptSource(b)) && a.sourceType !== "wrong"
  );
}
