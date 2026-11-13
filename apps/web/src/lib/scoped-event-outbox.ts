import {
  type AttemptEvent,
  type LearningEvent,
  type LectureEvent,
  learningEventBatchDataSchema,
} from "@tutor/contract";
import { ApiError, api, callApi } from "./api";
import type { EventScope, EventStoreBackend } from "./event-queue";
import { randomUuid } from "./uuid";

export interface EventOwner {
  origin: string;
  studentId: string;
}

interface OutboxEntry {
  events: LearningEvent[];
  viewId: string;
  eventIds: string[];
}

export function createScopedEventOutbox({
  scope,
  owner,
  store,
  isCurrent,
  send,
  beacon,
}: {
  scope: EventScope;
  owner: EventOwner;
  store: () => EventStoreBackend;
  isCurrent: () => boolean;
  send?:
    | ((events: readonly LearningEvent[], viewId: string) => Promise<void>)
    | undefined;
  beacon?:
    | ((events: readonly LearningEvent[], viewId: string) => boolean)
    | null
    | undefined;
}) {
  const scopeId = scope.kind === "attempt" ? scope.attemptId : scope.lectureId;
  const prefix = `events:v2:${JSON.stringify([owner.origin, owner.studentId, scope.kind, scopeId])}:`;
  const path =
    scope.kind === "attempt"
      ? `/api/student/attempts/${encodeURIComponent(scopeId)}/events/deliver`
      : "/api/student/events/deliver";
  // 每次落盘建新键；其他标签页删已确认的旧键时不会擦掉本页新增的事件。
  const inMemory = new Map<string, OutboxEntry>();
  let staging = Promise.resolve();
  let draining = false;
  let denied = false;

  const envelope = (entry: OutboxEntry) => {
    const delivery = { ownerId: owner.studentId, eventIds: entry.eventIds };
    return scope.kind === "attempt"
      ? {
          events: entry.events as AttemptEvent[],
          viewId: entry.viewId,
          delivery,
        }
      : {
          events: entry.events as LectureEvent[],
          delivery: { ...delivery, lectureId: scopeId },
        };
  };

  async function acknowledge(entry: OutboxEntry): Promise<boolean> {
    if (send) {
      await send(entry.events, entry.viewId);
      return true;
    }
    const init = { signal: AbortSignal.timeout(30_000) };
    const body = envelope(entry);
    const args = { param: { id: scopeId }, json: body };
    const result = learningEventBatchDataSchema.parse(
      await ("viewId" in body && body.viewId !== undefined
        ? callApi(() =>
            api.api.student.attempts[":id"].events.deliver.$post(args, {
              init,
            }),
          )
        : callApi(() =>
            api.api.student.events.deliver.$post({ json: body }, { init }),
          )),
    );
    const acknowledged = new Set(result.acknowledgedIds);
    return entry.eventIds.every((id) => acknowledged.has(id));
  }

  async function drain(): Promise<void> {
    if (draining || denied || !isCurrent() || !navigator.onLine) return;
    draining = true;
    try {
      const backend = store();
      const entries = new Map(inMemory);
      try {
        for (const key of await backend.keys(prefix)) {
          const value = (await backend.get(key)) as OutboxEntry | undefined;
          if (value?.events && value.eventIds?.length === value.events.length)
            entries.set(key, value);
        }
      } catch (error) {
        console.warn("事件离线仓读取失败（保留积压）", error);
      }
      for (const [key, entry] of entries) {
        if (!isCurrent()) break;
        try {
          if (document.visibilityState === "hidden" && !inMemory.has(key)) {
            if (beacon) beacon(entry.events, entry.viewId);
            else if (beacon === undefined)
              navigator.sendBeacon?.(
                path,
                new Blob([JSON.stringify(envelope(entry))], {
                  type: "application/json",
                }),
              );
            continue;
          }
          if (!(await acknowledge(entry))) continue;
        } catch (error) {
          if (
            error instanceof ApiError &&
            ((error.status === 403 && error.code !== "EVENT_ACCOUNT_CHANGED") ||
              error.code === "EVENT_TARGET_UNAVAILABLE" ||
              error.code === "ATTEMPT_ABANDONED")
          ) {
            // 键只属于当前账号和当前练习/讲义，其他范围仍可补发。
            denied = true;
            for (const pendingKey of entries.keys()) {
              inMemory.delete(pendingKey);
              await backend.del(pendingKey).catch(() => undefined);
            }
            break;
          }
          console.warn("事件批量上报失败（已留待重发）", error);
          continue;
        }
        inMemory.delete(key);
        await backend
          .del(key)
          .catch((error) => console.warn("清除已确认事件失败", error));
      }
    } finally {
      draining = false;
    }
  }

  function flush(batches: LearningEvent[][], viewId: string): Promise<void> {
    staging = staging.then(async () => {
      if (denied) return;
      for (const events of batches) {
        const key = `${prefix}${randomUuid()}`;
        inMemory.set(key, {
          events,
          viewId,
          eventIds: events.map(() => randomUuid()),
        });
      }
      for (const [key, entry] of inMemory) {
        try {
          await store().set(key, entry);
          inMemory.delete(key);
        } catch (error) {
          console.warn("事件离线仓写入失败（事件留在内存队列）", error);
        }
      }
    });
    return staging.then(drain);
  }
  return { flush, isDenied: () => denied };
}
