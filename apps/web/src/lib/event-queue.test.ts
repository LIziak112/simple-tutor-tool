import type { LearningEvent } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEventQueue,
  type EventQueueApi,
  type EventStoreBackend,
  installEventStore,
} from "./event-queue";

/**
 * 事件队列单测（T2.10，§5.5 全部机制）：
 * - 5 秒定时批量触发（fake timers）；
 * - 攒够 200 条立即触发、按 200 切批；
 * - 页面隐藏 → sendBeacon 兜底（mock navigator.sendBeacon）+ 自动注入
 *   page_hidden / page_visible（仅 attempt scope）；
 * - 离线（navigator.onLine=false / 发送抛错）→ 写 IndexedDB（注入内存后端），
 *   online 恢复后连同积压一起补发；
 * - dispose 尽力最后一轮发送；lecture scope 不注入 page_* 事件。
 * API 层（postAttemptEventsApi 等）已 mock——网络行为不在本文件范围。
 */

vi.mock("./api", () => ({
  postAttemptEventsApi: vi.fn().mockRejectedValue(new Error("不应直接调用")),
  postLectureEventsApi: vi.fn().mockRejectedValue(new Error("不应直接调用")),
}));

/** 构造最小合法事件 */
function ev(type: string, extra: Record<string, unknown> = {}): LearningEvent {
  return { type, clientTs: 1_769_000_000_000, ...extra } as LearningEvent;
}

/** 带检视的内存后端（dump 只看 attempt:att-1 键） */
function memoryStore(): EventStoreBackend & {
  dump(): { events: LearningEvent[] } | undefined;
} {
  const map = new Map<string, unknown>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    del: async (key) => {
      map.delete(key);
    },
    dump: () => map.get("events:attempt:att-1") as
      | { events: LearningEvent[] }
      | undefined,
  };
}

/** navigator.onLine / sendBeacon 的可控替身 */
function mockNavigator(onLine: boolean) {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => onLine,
  });
}

/** jsdom 的 visibilityState 只读：defineProperty 覆盖 */
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

let queue: EventQueueApi | null = null;

function makeQueue(
  overrides: Partial<Parameters<typeof createEventQueue>[0]> = {},
): EventQueueApi {
  const q = createEventQueue({
    scope: { kind: "attempt", attemptId: "att-1" },
    ...overrides,
  });
  queue = q;
  return q;
}

beforeEach(() => {
  vi.useFakeTimers();
  installEventStore(memoryStore());
  mockNavigator(true);
  setVisibility("visible");
});

afterEach(() => {
  queue?.dispose();
  queue = null;
  vi.useRealTimers();
});

describe("定时批量", () => {
  it("5 秒触发一轮批量 POST；不足 5 秒不发包", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const q = makeQueue({ send });
    q.track(ev("attempt_start"));
    q.track(ev("question_view", { questionId: "q1" }));
    await vi.advanceTimersByTimeAsync(4999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    const batch = send.mock.calls[0]?.[0] as LearningEvent[];
    expect(batch.length).toBe(2);
    expect(batch[0]?.type).toBe("attempt_start");
  });

  it("攒够 200 条立即触发；超过 200 按 200 切批", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const q = makeQueue({ send });
    for (let i = 0; i < 205; i++) {
      q.track(ev("question_view", { questionId: `q${i % 8}` }));
    }
    await vi.runOnlyPendingTimersAsync();
    // 200 条触发一次 + dispose/后续触发余下 5 条
    const sizes = send.mock.calls.map(
      (call) => (call[0] as LearningEvent[]).length,
    );
    expect(sizes[0]).toBe(200);
    expect(sizes.reduce((sum, n) => sum + n, 0)).toBeGreaterThanOrEqual(205);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(200);
  });
});

describe("sendBeacon 兜底（页面隐藏）", () => {
  it("visibilitychange → hidden：自动注入 page_hidden 并改走 sendBeacon", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const beacon = vi.fn((_events: readonly LearningEvent[]) => true);
    const q = makeQueue({ send, beacon });
    q.track(ev("question_focus", { questionId: "q1" }));
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.runOnlyPendingTimersAsync();
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    const batch = beacon.mock.calls[0]?.[0] as LearningEvent[];
    // 自动注入的 page_hidden 排在最后（track 在前）
    expect(batch.map((e) => e.type)).toEqual(["question_focus", "page_hidden"]);
    // 恢复可见：注入 page_visible，等下一轮批量走 fetch
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (send.mock.calls[0]?.[0] as LearningEvent[]).map((e) => e.type),
    ).toEqual(["page_visible"]);
  });

  it("beacon 返回 false（浏览器队列满）→ 事件写入 IndexedDB", async () => {
    const store = memoryStore();
    installEventStore(store);
    const beacon = vi.fn(() => false);
    const q = makeQueue({ beacon });
    q.track(ev("submit"));
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.runOnlyPendingTimersAsync();
    // 自动注入的 page_hidden 与 submit 一起落仓
    expect(store.dump()?.events.map((e) => e.type)).toEqual([
      "submit",
      "page_hidden",
    ]);
  });

  it("lecture scope 不注入 page_hidden/page_visible", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const q = createEventQueue({ scope: { kind: "lecture" }, send });
    queue = q;
    q.track(
      ev("lecture_expand", {
        lectureId: "lec-1",
        directive: "solution",
        index: 1,
      }),
    );
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.runOnlyPendingTimersAsync();
    const types = send.mock.calls
      .flatMap((call) => call[0] as LearningEvent[])
      .map((e) => e.type);
    expect(types).toEqual(["lecture_expand"]);
  });
});

describe("离线存 IndexedDB / 恢复补发", () => {
  it("断网时 track + 定时器 → 事件进 IndexedDB 不发送", async () => {
    const store = memoryStore();
    installEventStore(store);
    mockNavigator(false);
    const send = vi.fn().mockResolvedValue(undefined);
    const q = makeQueue({ send });
    q.track(ev("question_view", { questionId: "q1" }));
    q.track(ev("answer_change", { questionId: "q1" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).not.toHaveBeenCalled();
    expect(store.dump()?.events.length).toBe(2);
  });

  it("恢复 online：连同 IndexedDB 积压一起补发并清仓", async () => {
    const store = memoryStore();
    installEventStore(store);
    mockNavigator(false);
    const send = vi.fn().mockResolvedValue(undefined);
    const q = makeQueue({ send });
    q.track(ev("question_view", { questionId: "q1" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.dump()?.events.length).toBe(1);

    mockNavigator(true);
    window.dispatchEvent(new Event("online"));
    q.track(ev("question_view", { questionId: "q2" }));
    await vi.runOnlyPendingTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
    const batch = send.mock.calls[0]?.[0] as LearningEvent[];
    expect(batch.map((e) => (e as { questionId?: string }).questionId)).toEqual([
      "q1",
      "q2",
    ]);
    expect(store.dump()).toBeUndefined();
  });

  it("发送抛错（服务端 5xx 等）→ 批次写回 IndexedDB 等下一轮", async () => {
    const store = memoryStore();
    installEventStore(store);
    const send = vi.fn().mockRejectedValue(new Error("服务器异常"));
    const q = makeQueue({ send });
    q.track(ev("question_blur", { questionId: "q1" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.dump()?.events.map((e) => e.type)).toEqual(["question_blur"]);
    // 服务端恢复 → 重试成功并清仓
    send.mockResolvedValueOnce(undefined);
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.dump()).toBeUndefined();
  });
});

describe("dispose", () => {
  it("清掉定时器并尽力最后一轮发送；此后不再发包", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const q = makeQueue({ send });
    q.track(ev("attempt_start"));
    q.dispose();
    await vi.runOnlyPendingTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
    const calls = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls.length).toBe(calls);
  });
});
