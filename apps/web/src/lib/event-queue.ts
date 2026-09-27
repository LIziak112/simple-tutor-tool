import type {
  AttemptEvent,
  LearningEvent,
  LectureEvent,
} from "@tutor/contract";
import { createStore, del, get, set } from "idb-keyval";
import { postAttemptEventsApi, postLectureEventsApi } from "./api";

/**
 * 学习痕迹事件队列（T2.10，架构 §5.5）：内存队列 + 每 5 秒批量 POST；
 * 页面隐藏时 navigator.sendBeacon 兜底（Blob application/json，同源自动带
 * 会话 Cookie）；离线（navigator.onLine / 发送失败）存 IndexedDB，恢复后补发。
 *
 * 职责边界：
 * - 本模块只负责「攒批 + 可靠送达」，不产生业务事件（埋点在调用方）；
 * - attempt scope 的队列额外自动注入 page_hidden / page_visible
 *   （visibilitychange 监听，对接入方透明；lecture scope 不注入——
 *   讲义端点契约只收 lecture_expand）；
 * - 前端不计算任何汇总值（activeSec 由服务端按原始事件计算，§5.5）。
 *
 * 可靠性细节：
 * - 单次上报 ≤200 条（契约上限）：攒够 200 立即触发一轮发送；发送时按
 *   200 切批，逐批送达；
 * - 离线/失败的事件整体写回 IndexedDB（替换式，不重复叠加），online
 *   事件触发补发；IndexedDB 不可用时留在内存队列（绝不丢已 track 的事件，
 *   除非页面被杀且存储也失败——双重兜底的极限场景）；
 * - 页面隐藏（visibilitychange=hidden / pagehide）时优先 sendBeacon
 *   （fire-and-forget，浏览器保证在页面卸载后发出）。
 *
 * 测试注入：send / beacon / intervalMs / store 均可替换（installEventStore
 * 换干净内存后端）；jsdom 无 indexedDB 时自动退化为内存实现（同 draft-store）。
 */

/** 队列归属：attempt 上下文（答题页）或讲义上下文（无 attemptId） */
export type EventScope =
  | { kind: "attempt"; attemptId: string }
  | { kind: "lecture" };

/** 底层键值存取的最小面（与 draft-store 的 KVBackend 同形；注入内存版便于单测） */
export interface EventStoreBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

/** 批量发送周期（毫秒，§5.5：每 5 秒） */
export const EVENT_FLUSH_INTERVAL_MS = 5000;

/** 单次上报上限（契约 LEARNING_EVENTS_BATCH_MAX 同值；本地再切一层防越限） */
const BATCH_MAX = 200;

const EVENT_DB = "tutor-events";
const EVENT_STORE = "pending";
const keyOf = (scope: EventScope): string =>
  scope.kind === "attempt"
    ? `events:attempt:${scope.attemptId}`
    : "events:lecture";

/** 内存后端（jsdom 自动回退与单测隔离用；不持久） */
export function memoryEventStore(): EventStoreBackend {
  const map = new Map<string, unknown>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    del: async (key) => {
      map.delete(key);
    },
  };
}

/** idb-keyval 后端（生产默认；专用 db/store 与草稿仓隔离） */
function idbEventStore(): EventStoreBackend {
  const store = createStore(EVENT_DB, EVENT_STORE);
  return {
    get: (key) => get(key, store),
    set: (key, value) => set(key, value, store),
    del: (key) => del(key, store),
  };
}

let activeStore: EventStoreBackend | null = null;

/** 测试注入后端（生产不调用；每个用例换 memoryEventStore 保证隔离） */
export function installEventStore(backend: EventStoreBackend): void {
  activeStore = backend;
}

function store(): EventStoreBackend {
  if (activeStore === null) {
    activeStore =
      typeof indexedDB === "undefined" ? memoryEventStore() : idbEventStore();
  }
  return activeStore;
}

/** scope → 上报 URL（fetch 与 sendBeacon 共用） */
function scopeUrl(scope: EventScope): string {
  return scope.kind === "attempt"
    ? `/api/student/attempts/${encodeURIComponent(scope.attemptId)}/events`
    : "/api/student/events";
}

/** 生产默认发送：走 hc 类型客户端（postAttemptEventsApi / postLectureEventsApi） */
function defaultSend(scope: EventScope) {
  return async (events: readonly LearningEvent[]): Promise<void> => {
    if (scope.kind === "attempt") {
      // scope 保证队列内全部为 attempt 事件（调用方只对 attempt scope track 这类事件）
      await postAttemptEventsApi(scope.attemptId, events as AttemptEvent[]);
      return;
    }
    await postLectureEventsApi(events as LectureEvent[]);
  };
}

/** 生产默认 beacon：Blob application/json（同源自动带会话 Cookie） */
function defaultBeacon(scope: EventScope) {
  return (events: readonly LearningEvent[]): boolean => {
    if (typeof navigator === "undefined" || navigator.sendBeacon === undefined)
      return false;
    const blob = new Blob([JSON.stringify({ events: [...events] })], {
      type: "application/json",
    });
    return navigator.sendBeacon(scopeUrl(scope), blob);
  };
}

/** 队列对外 API */
export interface EventQueueApi {
  /** 入队一条事件（clientTs 由调用方填 Date.now()） */
  track(event: LearningEvent): void;
  /** 立即批量发送（离线时写 IndexedDB；页面隐藏时走 sendBeacon） */
  flush(): Promise<void>;
  /** 停止队列：清定时器、移除监听、尽力最后一轮发送 */
  dispose(): void;
}

/** 创建选项（全部可注入，默认值即生产行为） */
export interface EventQueueOptions {
  scope: EventScope;
  /** 发送函数（抛错视为本批失败） */
  send?: (events: readonly LearningEvent[]) => Promise<void>;
  /** sendBeacon 实现（返回 false 视为失败）；传 null 显式禁用 */
  beacon?: ((events: readonly LearningEvent[]) => boolean) | null;
  /** 批量周期毫秒（默认 5000） */
  intervalMs?: number;
}

/**
 * 创建事件队列。副作用：setInterval、visibilitychange / pagehide /
 * online 监听（attempt scope 额外注入 page_hidden/page_visible 事件）。
 * 页面卸载/组件卸载时调用 dispose()。
 */
export function createEventQueue(options: EventQueueOptions): EventQueueApi {
  const { scope } = options;
  const intervalMs = options.intervalMs ?? EVENT_FLUSH_INTERVAL_MS;
  const send =
    options.send ??
    ((events: readonly LearningEvent[]) => defaultSend(scope)(events));
  const beacon =
    options.beacon === undefined ? defaultBeacon(scope) : options.beacon;

  /** 内存待发队列 */
  let queue: LearningEvent[] = [];
  /** 一轮发送进行中（并发触发只跑一轮，剩余等下一轮） */
  let flushing = false;
  const key = keyOf(scope);

  /** 读持久层（吞错：存储故障不阻塞发送链路） */
  async function loadPersisted(): Promise<LearningEvent[]> {
    try {
      const value = (await store().get(key)) as
        | { events?: unknown }
        | null
        | undefined;
      return Array.isArray(value?.events)
        ? (value.events as LearningEvent[])
        : [];
    } catch (err) {
      console.warn("事件离线仓读取失败（继续用内存队列）", err);
      return [];
    }
  }

  /** 写持久层（吞错但向上反馈：失败时调用方把事件留在内存） */
  async function persist(events: readonly LearningEvent[]): Promise<boolean> {
    try {
      await store().set(key, { events: [...events] });
      return true;
    } catch (err) {
      console.warn("事件离线仓写入失败（事件留在内存队列）", err);
      return false;
    }
  }

  async function clearPersisted(): Promise<void> {
    try {
      await store().del(key);
    } catch (err) {
      console.warn("事件离线仓清除失败（不影响发送）", err);
    }
  }

  async function flushNow(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      const persisted = await loadPersisted();
      const pending = [...persisted, ...queue];
      queue = [];
      if (pending.length === 0 && persisted.length === 0) return;
      // 离线（复用 T2.9 的 navigator.onLine 判定）：整体落 IndexedDB 等恢复
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        if (!(await persist(pending))) queue = pending;
        return;
      }
      // 页面隐藏（或即将卸载）→ sendBeacon 兜底；否则正常 POST
      const useBeacon =
        typeof document !== "undefined" &&
        document.visibilityState === "hidden";
      const failed: LearningEvent[] = [];
      for (let start = 0; start < pending.length; start += BATCH_MAX) {
        const chunk = pending.slice(start, start + BATCH_MAX);
        try {
          if (useBeacon) {
            if (beacon === null || !beacon(chunk)) failed.push(...chunk);
          } else {
            await send(chunk);
          }
        } catch (err) {
          console.warn("事件批量上报失败（已留待重发）", err);
          failed.push(...chunk);
        }
      }
      if (failed.length > 0) {
        // 失败批次写回离线仓；仓也不可用时留在内存
        if (!(await persist(failed))) queue = [...failed, ...queue];
      } else if (persisted.length > 0) {
        await clearPersisted();
      }
    } finally {
      flushing = false;
    }
  }

  const timer =
    typeof setInterval === "function"
      ? setInterval(() => void flushNow(), intervalMs)
      : null;

  function onVisibility(): void {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "hidden") {
      // attempt scope：隐藏即停表（服务端按事件序列扣减），并立刻兜底发送
      if (scope.kind === "attempt") {
        queue.push({ type: "page_hidden", clientTs: Date.now() });
      }
      void flushNow();
    } else if (
      document.visibilityState === "visible" &&
      scope.kind === "attempt"
    ) {
      queue.push({ type: "page_visible", clientTs: Date.now() });
    }
  }

  function onOnline(): void {
    void flushNow();
  }

  function onPageHide(): void {
    void flushNow();
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("pagehide", onPageHide);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
  }

  return {
    track(event: LearningEvent): void {
      queue.push(event);
      // 队列攒到单批上限立即触发（防下一次越过 200 被契约拒绝）
      if (queue.length >= BATCH_MAX) void flushNow();
    },
    flush: flushNow,
    dispose(): void {
      if (timer !== null) clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
        document.removeEventListener("pagehide", onPageHide);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
      }
      void flushNow();
    },
  };
}
