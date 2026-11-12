import type { LearningEvent } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postAttemptEventsApi } from "./api";
import {
  createEventQueue,
  EVENT_BATCH_BYTES_MAX,
  type EventQueueApi,
  type EventStoreBackend,
  installEventStore,
} from "./event-queue";

/**
 * 事件队列单测（T2.10 §5.5 全部机制 + T4.0a 增强）：
 * - 5 秒定时批量触发（fake timers）；
 * - 攒够 200 条立即触发、按 200 与字节（≤32KiB）双限切批（T4.0a §5.0-A5）；
 * - 页面隐藏 → sendBeacon 兜底（mock navigator.sendBeacon）+ 自动注入
 *   page_hidden / page_visible（attempt scope）；
 * - 离线（navigator.onLine=false / 发送抛错）→ 写 IndexedDB（注入内存后端），
 *   online 恢复后连同积压一起补发；
 * - 访问权终态（T2A.6，D7）：send 抛 403/404 ApiError → 丢弃批次并停止
 *   （isDenied=true，后续 track/flush 不再发包）；
 * - dispose 尽力最后一轮发送；lecture scope 不注入 page_* 事件。
 * T4.0a 新增：
 * - 持久键实例隔离 + 前缀扫描合并发送（§5.0-A1：双实例离线互不覆盖、
 *   旧版无后缀键收编、attempt 只扫本 attempt 前缀）；
 * - lecture scope 注入 lecture_visible/hidden（viewId、双兜底允许双发）；
 * - 两 scope 注入 net_offline/net_online（含初始离线补发）与
 *   idle_start/idle_end（attempt 90s / lecture 300s、惰性判定、活动源）。
 * API 层（postAttemptEventsApi 等）已 mock——网络行为不在本文件范围。
 */

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  postAttemptEventsApi: vi.fn().mockRejectedValue(new Error("不应直接调用")),
  postLectureEventsApi: vi.fn().mockRejectedValue(new Error("不应直接调用")),
}));

/** 构造最小合法事件 */
function ev(type: string, extra: Record<string, unknown> = {}): LearningEvent {
  return { type, clientTs: 1_769_000_000_000, ...extra } as LearningEvent;
}

/**
 * 带检视的内存后端：dumpAll 合并全部键下的事件（T4.0a 起持久键带实例随机
 * 后缀，测试不感知具体键名）；setRaw 供直接植入旧版键构造遗留积压。
 */
function memoryStore(): EventStoreBackend & {
  dumpAll(): LearningEvent[];
  setRaw(key: string, value: unknown): void;
  keyCount(): number;
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
    keys: async (prefix) =>
      Array.from(map.keys()).filter((key) => key.startsWith(prefix)),
    dumpAll: () =>
      Array.from(map.values()).flatMap(
        (value) => (value as { events?: LearningEvent[] }).events ?? [],
      ),
    setRaw: (key, value) => {
      map.set(key, value);
    },
    keyCount: () => map.size,
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

/** 每个用例创建过的队列（afterEach 统一 dispose，防监听跨用例泄漏） */
const created: EventQueueApi[] = [];

function makeQueue(
  overrides: Partial<Parameters<typeof createEventQueue>[0]> = {},
): EventQueueApi {
  const q = createEventQueue({
    scope: { kind: "attempt", attemptId: "att-1" },
    ...overrides,
  });
  created.push(q);
  return q;
}

/** 创建讲义域队列（T4.0a scope 带 lectureId） */
function makeLectureQueue(
  overrides: Partial<Parameters<typeof createEventQueue>[0]> = {},
): EventQueueApi {
  const q = createEventQueue({
    scope: { kind: "lecture", lectureId: "lec-1" },
    ...overrides,
  });
  created.push(q);
  return q;
}

beforeEach(() => {
  vi.useFakeTimers();
  installEventStore(memoryStore());
  mockNavigator(true);
  setVisibility("visible");
});

it("讲义只补发同一账号同一讲义，beacon 入队后仍须收到服务端回执", async () => {
  const persisted = memoryStore();
  installEventStore(persisted);
  const owner = { origin: "https://tutor.example", studentId: "student-a" };
  const beacon = vi.fn(() => true);
  const send = vi.fn(async () => undefined);
  const a = makeLectureQueue({ owner, beacon, send });
  setVisibility("hidden");
  await a.flush();
  expect(beacon).toHaveBeenCalled();
  expect(persisted.keyCount()).toBeGreaterThan(0);
  setVisibility("visible");
  const other = makeLectureQueue({
    owner: { ...owner, studentId: "student-b" },
    send,
  });
  await other.flush();
  expect(persisted.keyCount()).toBeGreaterThan(0);
  const otherLecture = makeLectureQueue({
    owner,
    scope: { kind: "lecture", lectureId: "lec-2" },
    send,
  });
  await otherLecture.flush();
  expect(persisted.keyCount()).toBeGreaterThan(0);
  await a.flush();
  expect(persisted.keyCount()).toBe(0);
});

it("正式回执缺失或只确认部分事件时保留原批次与标识，全部确认后才清理", async () => {
  const persisted = memoryStore();
  installEventStore(persisted);
  const posted: string[][] = [];
  const fetchMock = vi.fn(
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        delivery: { eventIds: string[] };
      };
      const ids = body.delivery.eventIds;
      posted.push(ids);
      const acknowledgedIds = posted.length === 2 ? ids.slice(0, 1) : ids;
      return Response.json({
        ok: true,
        data: {
          accepted: ids.length,
          ...(posted.length !== 1 && { acknowledgedIds }),
        },
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  try {
    const queue = makeQueue({
      owner: {
        origin: "https://tutor.example",
        studentId: "f8300f08-2b02-4e26-9025-934cf83aed9e",
      },
    });
    queue.track(ev("attempt_start"));
    queue.track(ev("page_hidden"));
    await queue.flush();
    expect(persisted.keyCount()).toBe(1);
    await queue.flush();
    expect(persisted.keyCount()).toBe(1);
    await queue.flush();
    expect(persisted.keyCount()).toBe(0);
    expect(posted).toEqual([posted[0], posted[0], posted[0]]);
    expect(posted[0]).toHaveLength(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/events/deliver");
  } finally {
    vi.unstubAllGlobals();
  }
});

afterEach(() => {
  for (const q of created.splice(0)) q.dispose();
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

describe("作答页会话 viewId（题内活动用时按会话分组）", () => {
  it("attempt scope 默认发送 / beacon 都随批携带同一个 viewId；事件本体不变", async () => {
    const posted = vi
      .mocked(postAttemptEventsApi)
      .mockResolvedValue({ accepted: 1, rejected: 0 } as never);
    const sent: Blob[] = [];
    // jsdom 无 sendBeacon：临时装一个可检视的替身，用完即拆（其他用例依赖「无 beacon → 落仓」）
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: vi.fn((_url: string, body: Blob) => {
        sent.push(body);
        return true;
      }),
    });
    try {
      const q = makeQueue();
      q.track(ev("question_focus", { questionId: "q1" }));
      await vi.advanceTimersByTimeAsync(5000);
      expect(posted).toHaveBeenCalledTimes(1);
      const [attemptId, batch, viewId] = posted.mock.calls[0] ?? [];
      expect(attemptId).toBe("att-1");
      expect((batch ?? []).map((e) => e.type)).toEqual(["question_focus"]);
      expect(typeof viewId).toBe("string");
      expect((viewId ?? "").length).toBeGreaterThan(0);
      expect(batch?.[0]).not.toHaveProperty("viewId");
      // 页面隐藏 → beacon 路径：请求体顶层带同一 viewId
      setVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.runOnlyPendingTimersAsync();
      expect(sent).toHaveLength(1);
      const body = JSON.parse((await sent[0]?.text()) ?? "{}") as {
        events: LearningEvent[];
        viewId?: string;
      };
      expect(body.events.map((e) => e.type)).toEqual(["page_hidden"]);
      expect(body.viewId).toBe(viewId);
    } finally {
      Reflect.deleteProperty(navigator, "sendBeacon");
      posted.mockReset().mockRejectedValue(new Error("不应直接调用"));
    }
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
    const sentBatch = send.mock.calls[0]?.[0] as LearningEvent[] | undefined;
    expect((sentBatch ?? []).map((e) => e.type)).toEqual(["page_visible"]);
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
    expect(store.dumpAll().map((e) => e.type)).toEqual([
      "submit",
      "page_hidden",
    ]);
  });

  it("lecture scope 不注入 page_hidden/page_visible（改注入 lecture 版，T4.0a）", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const q = makeLectureQueue({ send });
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
    // 无 attempt 域 page_* 事件；讲义域可见性事件由独立用例细查
    expect(types).not.toContain("page_hidden");
    expect(types).not.toContain("page_visible");
    expect(types).toContain("lecture_expand");
    expect(types).toContain("lecture_hidden");
    expect(types).toContain("lecture_visible");
  });
});

describe("离线存 IndexedDB / 恢复补发", () => {
  it("断网时 track + 定时器 → 事件进 IndexedDB 不发送（含初始 net_offline 补发）", async () => {
    const store = memoryStore();
    installEventStore(store);
    mockNavigator(false);
    const send = vi.fn().mockResolvedValue(undefined);
    const q = makeQueue({ send });
    q.track(ev("question_view", { questionId: "q1" }));
    q.track(ev("answer_change", { questionId: "q1" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).not.toHaveBeenCalled();
    // 创建时已离线 → 主动补一条 net_offline（§5.0-A3），与两条业务事件一起落仓
    expect(store.dumpAll().map((e) => e.type)).toEqual([
      "net_offline",
      "question_view",
      "answer_change",
    ]);
  });

  it("恢复 online：连同 IndexedDB 积压一起补发并清仓，翻转各发一条 net 事件", async () => {
    const store = memoryStore();
    installEventStore(store);
    mockNavigator(false);
    const send = vi.fn().mockResolvedValue(undefined);
    const q = makeQueue({ send });
    q.track(ev("question_view", { questionId: "q1" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.dumpAll().length).toBe(2); // net_offline + q1

    mockNavigator(true);
    window.dispatchEvent(new Event("online"));
    q.track(ev("question_view", { questionId: "q2" }));
    await vi.runOnlyPendingTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
    const batch = send.mock.calls[0]?.[0] as LearningEvent[];
    expect(batch.map((e) => (e as { questionId?: string }).questionId)).toEqual(
      [undefined, "q1", undefined, "q2"],
    );
    expect(batch.map((e) => e.type)).toEqual([
      "net_offline", // 积压（创建时补发）
      "question_view",
      "net_online", // online 翻转注入（window 事件）
      "question_view",
    ]);
    expect(store.dumpAll()).toEqual([]);
  });

  it("window offline 事件 → 注入 net_offline 并立即落仓", async () => {
    const store = memoryStore();
    installEventStore(store);
    const send = vi.fn().mockResolvedValue(undefined);
    const q = makeQueue({ send });
    q.track(ev("question_blur", { questionId: "q1" }));
    mockNavigator(false);
    window.dispatchEvent(new Event("offline"));
    await vi.runOnlyPendingTimersAsync();
    expect(send).not.toHaveBeenCalled();
    expect(store.dumpAll().map((e) => e.type)).toEqual([
      "question_blur",
      "net_offline",
    ]);
  });

  it("发送抛错（服务端 5xx 等）→ 批次写回 IndexedDB 等下一轮", async () => {
    const store = memoryStore();
    installEventStore(store);
    const send = vi.fn().mockRejectedValue(new Error("服务器异常"));
    const q = makeQueue({ send });
    q.track(ev("question_blur", { questionId: "q1" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.dumpAll().map((e) => e.type)).toEqual(["question_blur"]);
    // 服务端恢复 → 重试成功并清仓
    send.mockResolvedValueOnce(undefined);
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.dumpAll()).toEqual([]);
    expect(store.keyCount()).toBe(0);
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

  it("dispose 移除全部监听：此后派发活动/网络/可见性事件不再产生新事件", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const q = makeQueue({ send });
    q.dispose();
    await vi.runOnlyPendingTimersAsync();
    const callsAfterDispose = send.mock.calls.length;
    window.dispatchEvent(new MouseEvent("pointerdown"));
    window.dispatchEvent(new KeyboardEvent("keydown"));
    window.dispatchEvent(new Event("online"));
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.runOnlyPendingTimersAsync();
    expect(send.mock.calls.length).toBe(callsAfterDispose);
  });
});

// ---------- T2A.6：访问权终态（403/404 停止上报） ----------

describe("访问权终态（D7）：send 收到 403/404 → 丢弃批次并停止", () => {
  it("403 ApiError → 不写离线仓、isDenied=true、后续 track/定时 flush 全 no-op", async () => {
    const { ApiError } = await import("./api");
    const store = memoryStore();
    installEventStore(store);
    const send = vi
      .fn()
      .mockRejectedValue(
        new ApiError("COURSE_ACCESS_DENIED", "无法访问该课程", 403),
      );
    const q = makeQueue({ send });
    q.track(ev("question_blur", { questionId: "q1" }));
    await vi.advanceTimersByTimeAsync(5000);
    // 终态：批次被丢弃（不进离线仓重试）
    expect(store.dumpAll()).toEqual([]);
    expect(q.isDenied()).toBe(true);

    // 后续 track 静默丢弃；定时器到点不再发包
    q.track(ev("question_view", { questionId: "q2" }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(1);
    await q.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("404 ApiError 同样终态；普通 5xx 仍走离线仓重试路径", async () => {
    const { ApiError } = await import("./api");
    const store = memoryStore();
    installEventStore(store);
    const send = vi.fn().mockRejectedValue(new ApiError("NOT_FOUND", "x", 404));
    const q = makeQueue({ send });
    q.track(ev("question_blur", { questionId: "q1" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(q.isDenied()).toBe(true);

    const store2 = memoryStore();
    installEventStore(store2);
    const send2 = vi.fn().mockRejectedValue(new Error("服务器异常"));
    const q2 = makeQueue({ send: send2 });
    q2.track(ev("question_blur", { questionId: "q1" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(q2.isDenied()).toBe(false);
    expect(store2.dumpAll().length).toBe(1);
  });
});

// ---------- T4.0a：持久键实例隔离与前缀扫描（§5.0-A1） ----------

describe("T4.0a 持久键实例隔离（IDB 键冲突修复，§5.0-A1）", () => {
  it("两实例（双标签页）离线互不覆盖；后实例 flush 合并前缀下全部键发送并逐键删除", async () => {
    const store = memoryStore();
    installEventStore(store);
    mockNavigator(false);
    // 实例一：讲义页 A，离线积压后页面被杀（不 dispose，模拟真被杀）
    const q1 = createEventQueue({
      scope: { kind: "lecture", lectureId: "lec-A" },
      send: vi.fn(),
    });
    created.push(q1);
    q1.track(
      ev("lecture_expand", { lectureId: "lec-A", directive: "fold", index: 1 }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.dumpAll().length).toBeGreaterThan(0);

    // 实例二：讲义页 B（同前缀、不同实例后缀），同样离线积压。
    // 各自 flush 落自己的键（或把先写键合并进自己的键）——任何时刻两实例
    // 的事件都完整保留（旧实现共用全局替换式键，并发交错会丢先写一方）
    const q2 = createEventQueue({
      scope: { kind: "lecture", lectureId: "lec-B" },
      send: vi.fn(),
    });
    created.push(q2);
    q2.track(
      ev("lecture_section_focus", { lectureId: "lec-B", headingIndex: 0 }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    const backlogTypes = store.dumpAll().map((e) => e.type);
    // 两实例各自创建时注入的 lecture_visible 都在 + 两条件事件都在（互不覆盖）
    expect(backlogTypes.filter((t) => t === "lecture_visible")).toHaveLength(2);
    expect(backlogTypes).toContain("lecture_expand");
    expect(backlogTypes).toContain("lecture_section_focus");
    const backlog = store.dumpAll().length;

    // 恢复在线：实例三 flush 把前缀下全部键（含遗留积压）合并发送
    mockNavigator(true);
    const send = vi.fn().mockResolvedValue(undefined);
    const q3 = makeLectureQueue({ send });
    await q3.flush();
    const merged = send.mock.calls.flatMap(
      (call) => call[0] as LearningEvent[],
    );
    expect(merged.length).toBe(backlog + 1); // +1 = 实例三创建时的 lecture_visible
    expect(merged.map((e) => e.type)).toContain("lecture_expand");
    expect(merged.map((e) => e.type)).toContain("lecture_section_focus");
    // 成功后逐键删除：仓清空
    expect(store.dumpAll()).toEqual([]);
  });

  it("审查 #100-01：离线积压按来源会话补发——上次页面的事件随它自己的 viewId 发，不冒用当前 viewId", async () => {
    const store = memoryStore();
    installEventStore(store);
    mockNavigator(false);
    // 上一次页面加载：离线积压后被杀
    const sendA = vi.fn();
    const qA = makeQueue({ send: sendA });
    qA.track(ev("question_focus", { questionId: "q1" }));
    qA.track(ev("answer_change", { questionId: "q1" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendA).not.toHaveBeenCalled();
    expect(store.keyCount()).toBe(1);

    // 新页面加载恢复在线：自己的事件带自己的 viewId，积压带积压时的 viewId
    mockNavigator(true);
    const sendB = vi.fn().mockResolvedValue(undefined);
    const qB = makeQueue({ send: sendB });
    qB.track(ev("question_focus", { questionId: "q2" }));
    await qB.flush();
    const byViewId = new Map<string | null, string[]>();
    for (const call of sendB.mock.calls) {
      const [events, viewId] = call as [LearningEvent[], string | null];
      byViewId.set(viewId, [
        ...(byViewId.get(viewId) ?? []),
        ...events.map((e) => e.type),
      ]);
    }
    expect(byViewId.size).toBe(2);
    const groups = [...byViewId.entries()];
    expect(groups.every(([viewId]) => typeof viewId === "string")).toBe(true);
    const backlog = groups.find(([, types]) => types.includes("answer_change"));
    expect(backlog?.[1]).toEqual(
      expect.arrayContaining(["question_focus", "answer_change"]),
    );
    const fresh = groups.find(([viewId]) => viewId !== backlog?.[0]);
    expect(fresh?.[1]).toContain("question_focus");
    expect(fresh?.[1]).not.toContain("answer_change");
    expect(store.dumpAll()).toEqual([]);

    // 旧版积压（没存 viewId）：不带 viewId 发（服务端并入缺省组），不冒用当前会话
    qA.dispose();
    qB.dispose();
    await vi.runOnlyPendingTimersAsync();
    store.setRaw("events:attempt:att-1:legacy", {
      events: [ev("question_blur", { questionId: "q1" })],
    });
    const sendC = vi.fn().mockResolvedValue(undefined);
    makeQueue({ send: sendC });
    await vi.advanceTimersByTimeAsync(5000);
    const legacyCall = sendC.mock.calls.find((call) =>
      (call[0] as LearningEvent[]).some((e) => e.type === "question_blur"),
    );
    expect(legacyCall?.[1]).toBeNull();
  });

  it("审查 #100-01：补发失败只把失败的那组写回它自己的键，viewId 保留", async () => {
    const store = memoryStore();
    installEventStore(store);
    mockNavigator(false);
    const qA = makeQueue({ send: vi.fn() });
    qA.track(ev("answer_change", { questionId: "q1" }));
    await vi.advanceTimersByTimeAsync(5000);
    const [backlogKey] = await store.keys("events:attempt:att-1:");
    const stored = (await store.get(backlogKey ?? "")) as {
      events: LearningEvent[];
      viewId?: string;
    };
    expect(typeof stored.viewId).toBe("string");

    mockNavigator(true);
    const send = vi.fn(
      async (events: readonly LearningEvent[], viewId: string | null) => {
        if (viewId === stored.viewId) throw new Error("5xx");
        void events;
      },
    );
    const qB = makeQueue({ send });
    qB.track(ev("question_focus", { questionId: "q2" }));
    await qB.flush();
    const again = (await store.get(backlogKey ?? "")) as {
      events: LearningEvent[];
      viewId?: string;
    };
    expect(again.viewId).toBe(stored.viewId);
    const againTypes = again.events.map((e) => e.type);
    expect(againTypes).toContain("answer_change");
    expect(againTypes).not.toContain("question_focus");
    // 自己那组发成功：不留键
    expect(store.keyCount()).toBe(1);
  });

  it("审查 #100-01：页面隐藏走 beacon 时同样按来源会话分组、各带各的 viewId", async () => {
    const store = memoryStore();
    installEventStore(store);
    store.setRaw("events:attempt:att-1:prev", {
      events: [ev("answer_change", { questionId: "q1" })],
      viewId: "view-prev",
    });
    const beacon = vi.fn(
      (_events: readonly LearningEvent[], _viewId: string | null) => true,
    );
    const q = makeQueue({ send: vi.fn(), beacon });
    q.track(ev("question_focus", { questionId: "q2" }));
    setVisibility("hidden");
    await q.flush();
    const byViewId = new Map(
      beacon.mock.calls.map((call) => [
        call[1] as string | null,
        (call[0] as LearningEvent[]).map((e) => e.type),
      ]),
    );
    expect(byViewId.get("view-prev")).toEqual(["answer_change"]);
    const ownEntry = [...byViewId.entries()].find(
      ([viewId]) => viewId !== "view-prev",
    );
    expect(typeof ownEntry?.[0]).toBe("string");
    expect(ownEntry?.[1]).toContain("question_focus");
    expect(ownEntry?.[1]).not.toContain("answer_change");
    expect(store.dumpAll()).toEqual([]);
  });

  it("审查 #100-01：别的会话那组写回失败时不进本实例内存队列——仓里原件仍在、下一轮按原 viewId 重发，不会双发或冒用", async () => {
    const store = memoryStore();
    installEventStore(store);
    store.setRaw("events:attempt:att-1:prev", {
      events: [ev("answer_change", { questionId: "q1" })],
      viewId: "view-prev",
    });
    let failPrev = true;
    const send = vi.fn(
      async (_events: readonly LearningEvent[], viewId: string | null) => {
        if (viewId === "view-prev" && failPrev) throw new Error("5xx");
      },
    );
    // 仓只读不可写：写回失败
    const originalSet = store.set;
    store.set = async () => {
      throw new Error("quota");
    };
    const q = makeQueue({ send });
    q.track(ev("question_focus", { questionId: "q2" }));
    await q.flush();
    // 别的会话的原件还在仓里，没有被搬进内存
    expect(store.keyCount()).toBe(1);
    expect(store.dumpAll().map((e) => e.type)).toEqual(["answer_change"]);
    // 下一轮恢复：只按原 viewId 再发一次，自己的 viewId 下没有它
    failPrev = false;
    store.set = originalSet;
    send.mockClear();
    await q.flush();
    const prevCalls = send.mock.calls.filter((call) => call[1] === "view-prev");
    expect(prevCalls.length).toBe(1);
    expect(
      send.mock.calls.some(
        (call) =>
          call[1] !== "view-prev" &&
          (call[0] as LearningEvent[]).some((e) => e.type === "answer_change"),
      ),
    ).toBe(false);
    expect(store.dumpAll()).toEqual([]);
  });

  it("审查 #100-01：离线时别的会话的键原样保留，既不并入自己的键也不删除", async () => {
    const store = memoryStore();
    installEventStore(store);
    mockNavigator(false);
    store.setRaw("events:attempt:att-1:prev", {
      events: [ev("answer_change", { questionId: "q1" })],
      viewId: "view-prev",
    });
    const q = makeQueue({ send: vi.fn() });
    q.track(ev("question_focus", { questionId: "q2" }));
    await q.flush();
    expect(store.keyCount()).toBe(2);
    const prev = (await store.get("events:attempt:att-1:prev")) as {
      events: LearningEvent[];
      viewId?: string;
    };
    expect(prev.viewId).toBe("view-prev");
    expect(prev.events.map((e) => e.type)).toEqual(["answer_change"]);
  });

  it("旧版无后缀键（events:lecture）的遗留积压被收编发送", async () => {
    const store = memoryStore();
    installEventStore(store);
    const legacy = ev("lecture_expand", {
      lectureId: "lec-old",
      directive: "solution",
      index: 2,
    });
    store.setRaw("events:lecture", { events: [legacy] });

    const send = vi.fn().mockResolvedValue(undefined);
    makeLectureQueue({ send });
    await vi.advanceTimersByTimeAsync(5000);
    const sent = send.mock.calls.flatMap((call) => call[0] as LearningEvent[]);
    expect(sent).toContainEqual(legacy);
    expect(store.dumpAll()).toEqual([]); // 旧键一并删除
  });

  it("attempt scope 只扫本 attempt 前缀（不误发其他 attempt 的积压）", async () => {
    const store = memoryStore();
    installEventStore(store);
    const other = ev("submit");
    store.setRaw("events:attempt:other-attempt:xyz", { events: [other] });
    store.setRaw("events:attempt:other-attempt", { events: [other] }); // 旧版键同样不收

    const send = vi.fn().mockResolvedValue(undefined);
    makeQueue({ send });
    await vi.advanceTimersByTimeAsync(5000);
    const sent = send.mock.calls.flatMap((call) => call[0] as LearningEvent[]);
    expect(sent).not.toContainEqual(other);
    expect(store.dumpAll().length).toBe(2); // 其他 attempt 的键原样保留
  });
});

// ---------- T4.0a：beacon 字节双限切批（§5.0-A5） ----------

describe("T4.0a 批次按条数与字节双限切（sendBeacon 64KiB 上限）", () => {
  it.each([
    { over: 0, batches: 1, hasTextEncoder: true },
    { over: 1, batches: 2, hasTextEncoder: true },
    { over: 1, batches: 2, hasTextEncoder: false },
  ])(
    "整批 JSON 超出 $over 字节时发送 $batches 批（TextEncoder=$hasTextEncoder）",
    async ({ over, batches, hasTextEncoder }) => {
      const encoder = new TextEncoder();
      const bytesOf = (events: readonly LearningEvent[]) =>
        encoder.encode(JSON.stringify({ events })).length;
      const answerChange = (finalAnswer: string) =>
        ev("answer_change", {
          questionId: "q1",
          to: { kind: "final", finalAnswer },
        });
      const first = answerChange("题");
      const padding =
        EVENT_BATCH_BYTES_MAX + over - bytesOf([first, answerChange("")]);
      const second = answerChange(
        "题".repeat(Math.floor(padding / 3)) + "x".repeat(padding % 3),
      );
      const send = vi.fn(async (_events: readonly LearningEvent[]) => {});
      const queue = makeQueue({ send });

      queue.track(first);
      queue.track(second);
      if (!hasTextEncoder) vi.stubGlobal("TextEncoder", undefined);
      try {
        await queue.flush();
      } finally {
        if (!hasTextEncoder) vi.unstubAllGlobals();
      }

      expect(send).toHaveBeenCalledTimes(batches);
      for (const [events] of send.mock.calls) {
        expect(bytesOf(events)).toBeLessThanOrEqual(EVENT_BATCH_BYTES_MAX);
      }
      expect(send.mock.calls.flatMap(([events]) => events)).toEqual([
        first,
        second,
      ]);
    },
  );

  it("单条事件超过字节上限时独占一批，不发送空批", async () => {
    const event = ev("answer_change", {
      questionId: "q1",
      to: { kind: "final", finalAnswer: "题".repeat(12_000) },
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const queue = makeQueue({ send });

    queue.track(event);
    await queue.flush();

    expect(send.mock.calls.map((call) => call[0])).toEqual([[event]]);
  });

  it("超 32KiB 的事件分多批 beacon，每批字节数不超限", async () => {
    const beacon = vi.fn((_events: readonly LearningEvent[]) => true);
    const q = makeQueue({ beacon });
    // 中文按 UTF-8 每字 3 字节：8000 字 ≈ 24KiB/条；两条合计 48KiB 必分批，
    // 但单条 24KiB + 相邻小事件仍在 32KiB 内可同批（双限切批的精确行为）
    const big = () =>
      ev("answer_change", {
        questionId: "q1",
        to: { kind: "final", finalAnswer: "题".repeat(8000) },
      });
    q.track(ev("question_focus", { questionId: "q1" })); // 小事件
    q.track(big());
    q.track(big());
    q.track(ev("question_blur", { questionId: "q1" })); // 小事件
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.runOnlyPendingTimersAsync();
    // [小, 大①]（~24.1KiB）与 [大②, 小, page_hidden]（~24.1KiB）各一批
    expect(beacon.mock.calls.length).toBe(2);
    for (const call of beacon.mock.calls) {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ events: call[0] }),
      ).length;
      expect(bytes).toBeLessThanOrEqual(EVENT_BATCH_BYTES_MAX);
    }
    // 全部事件都被送达（含注入的 page_hidden），顺序保真
    const delivered = beacon.mock.calls
      .flatMap((call) => call[0] as LearningEvent[])
      .map((e) => e.type);
    expect(delivered).toEqual([
      "question_focus",
      "answer_change",
      "answer_change",
      "question_blur",
      "page_hidden",
    ]);
  });

  it("fetch 路径同样按双限切批（条数上限不变）", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const q = makeQueue({ send });
    const big = () =>
      ev("answer_change", {
        questionId: "q1",
        to: { kind: "final", finalAnswer: "题".repeat(8000) },
      });
    for (let i = 0; i < 3; i++) q.track(big());
    await vi.advanceTimersByTimeAsync(5000);
    expect(send.mock.calls.length).toBe(3); // 每条独占一批
  });
});

// ---------- T4.0a：lecture scope 阅读会话注入 ----------

describe("T4.0a lecture_visible / lecture_hidden 注入（viewId 配对）", () => {
  it("创建即可见 → 注入 lecture_visible（lectureId + viewId）；隐藏/恢复成对", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    makeLectureQueue({ send });
    await vi.advanceTimersByTimeAsync(5000);
    const firstBatch = send.mock.calls[0]?.[0] as LearningEvent[] | undefined;
    const first = firstBatch?.[0] as
      | {
          type: string;
          lectureId: string;
          viewId: string;
        }
      | undefined;
    expect(first).toMatchObject({
      type: "lecture_visible",
      lectureId: "lec-1",
    });
    expect(typeof first?.viewId).toBe("string");

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5000);
    const types = send.mock.calls
      .flatMap((call) => call[0] as LearningEvent[])
      .map((e) => e.type);
    expect(types).toEqual([
      "lecture_visible",
      "lecture_hidden",
      "lecture_visible",
    ]);
    // 同一页面加载内 viewId 不变（配对键）
    const all = send.mock.calls
      .flatMap((call) => call[0] as LearningEvent[])
      .filter((e) => e.type.startsWith("lecture_"));
    expect(new Set(all.map((e) => (e as { viewId: string }).viewId)).size).toBe(
      1,
    );
  });

  it("pagehide 双兜底：visibilitychange→hidden 与 pagehide 各注入一条 lecture_hidden（允许双发）", async () => {
    const beacon = vi.fn((_events: readonly LearningEvent[]) => true);
    makeLectureQueue({ beacon });
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("pagehide"));
    await vi.runOnlyPendingTimersAsync();
    const hiddenCount = beacon.mock.calls
      .flatMap((call) => call[0] as LearningEvent[])
      .filter((e) => e.type === "lecture_hidden").length;
    expect(hiddenCount).toBe(2); // 双发是设计行为（服务端聚合容错）
  });

  it("dispose（SPA 离开讲义页）补发 lecture_hidden 结束会话", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const q = makeLectureQueue({ send });
    q.dispose();
    await vi.runOnlyPendingTimersAsync();
    const types = send.mock.calls
      .flatMap((call) => call[0] as LearningEvent[])
      .map((e) => e.type);
    expect(types).toEqual(["lecture_visible", "lecture_hidden"]);
  });

  it("每次页面加载（队列实例）的 viewId 不同（双标签页不串会话）", async () => {
    const send1 = vi.fn().mockResolvedValue(undefined);
    const send2 = vi.fn().mockResolvedValue(undefined);
    const q1 = makeLectureQueue({ send: send1 });
    q1.dispose();
    const q2 = makeLectureQueue({ send: send2 });
    q2.dispose();
    await vi.runOnlyPendingTimersAsync();
    const viewIdOfFirst = (event: LearningEvent[]) =>
      (event.find((e) => e.type === "lecture_visible") as { viewId: string })
        ?.viewId;
    const v1 = viewIdOfFirst(send1.mock.calls[0]?.[0] as LearningEvent[]);
    const v2 = viewIdOfFirst(send2.mock.calls[0]?.[0] as LearningEvent[]);
    expect(v1).not.toBe(v2);
  });
});

// ---------- T4.0a：idle 注入（惰性判定，§5.0-A2） ----------

describe("T4.0a idle_start / idle_end 注入（阈值分域：attempt 90s / lecture 300s）", () => {
  it("attempt scope：90 秒无输入 → 周期检查发 idle_start；活动（pointerdown）→ idle_end", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    makeQueue({ send });
    await vi.advanceTimersByTimeAsync(91_000);
    const idleStart = send.mock.calls
      .flatMap((call) => call[0] as LearningEvent[])
      .find((e) => e.type === "idle_start");
    expect(idleStart).toBeDefined();

    // 新输入 → idle_end（且每空闲期只一对：持续无输入不再重复发 start）
    window.dispatchEvent(new MouseEvent("pointerdown"));
    await vi.advanceTimersByTimeAsync(5000);
    const types = send.mock.calls
      .flatMap((call) => call[0] as LearningEvent[])
      .map((e) => e.type);
    expect(types.filter((t) => t === "idle_start")).toHaveLength(1);
    expect(types).toContain("idle_end");
  });

  it("lecture scope：200 秒无输入不发（阅读零交互是常态），310 秒才发", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    makeLectureQueue({ send });
    await vi.advanceTimersByTimeAsync(200_000);
    const types = send.mock.calls
      .flatMap((call) => call[0] as LearningEvent[])
      .map((e) => e.type);
    expect(types).not.toContain("idle_start");
    await vi.advanceTimersByTimeAsync(111_000); // 累计 311s
    const typesAfter = send.mock.calls
      .flatMap((call) => call[0] as LearningEvent[])
      .map((e) => e.type);
    expect(typesAfter).toContain("idle_start");
  });

  it("活动源：keydown/scroll 记活动；pointermove 低于位移阈值不记、超过记", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    makeQueue({ send });
    // 键盘活动把空闲起点推后
    await vi.advanceTimersByTimeAsync(80_000);
    window.dispatchEvent(new KeyboardEvent("keydown"));
    await vi.advanceTimersByTimeAsync(80_000); // 距上次活动 80s < 90s
    let types = send.mock.calls
      .flatMap((call) => call[0] as LearningEvent[])
      .map((e) => e.type);
    expect(types).not.toContain("idle_start");

    // 滚动记活动（capture 监听、任意元素）
    await vi.advanceTimersByTimeAsync(80_000); // 距 keydown 160s → 已 idle
    document.body.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(5000);
    types = send.mock.calls
      .flatMap((call) => call[0] as LearningEvent[])
      .map((e) => e.type);
    expect(types).toContain("idle_start");
    expect(types).toContain("idle_end");

    // pointermove 微移（<10px）不算活动：先进入空闲，再微移不应产生 idle_end
    await vi.advanceTimersByTimeAsync(91_000);
    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 100, clientY: 100 }),
    );
    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 103, clientY: 102 }),
    ); // 位移 ~3.6px
    await vi.advanceTimersByTimeAsync(5000);
    const endCount = send.mock.calls
      .flatMap((call) => call[0] as LearningEvent[])
      .filter((e) => e.type === "idle_end").length;
    expect(endCount).toBe(1); // 只有 scroll 那次

    // 大幅移动（>10px）→ idle_end
    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 200, clientY: 100 }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    const endCountAfter = send.mock.calls
      .flatMap((call) => call[0] as LearningEvent[])
      .filter((e) => e.type === "idle_end").length;
    expect(endCountAfter).toBe(2);
  });

  it("visible 恢复补检查：后台挂起错过检查点，恢复可见时补发 idle_start", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    makeQueue({ send });
    // 隐藏页面（模拟后台 timer 挂起）→ 时间越过阈值 → 恢复可见
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(95_000);
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5000);
    const types = send.mock.calls
      .flatMap((call) => call[0] as LearningEvent[])
      .map((e) => e.type);
    expect(types).toContain("idle_start");
  });
});

it("旁路订阅同时收到显式事件与原有空闲注入，不增加活动观察器", async () => {
  const seen: LearningEvent[] = [];
  const queue = makeQueue({
    send: async () => {},
    beacon: null,
    onEvent: (event) => seen.push(event),
  });
  queue.track(ev("question_focus", { questionId: "q1" }));
  await vi.advanceTimersByTimeAsync(90_000);
  window.dispatchEvent(new Event("pointerdown"));
  expect(
    seen
      .filter((event) =>
        ["question_focus", "idle_start", "idle_end"].includes(event.type),
      )
      .map((event) => event.type),
  ).toEqual(["question_focus", "idle_start", "idle_end"]);
});
