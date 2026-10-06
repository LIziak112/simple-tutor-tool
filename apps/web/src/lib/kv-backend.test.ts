import { afterEach, describe, expect, it, vi } from "vitest";
import { idbKVBackend } from "./kv-backend";

/**
 * idbKVBackend（T6R.9 修复测试）：idb-keyval 的 customStore 只把**回调的
 * 返回值**作为 resolve 结果（其 get/keys 等均在回调内显式
 * promisifyRequest）——keys 的实现必须自行解包 getAllKeys 的 IDBRequest。
 * 回归背景：曾直接返回裸 Request（类型断言掩盖），真 IDB 下
 * listPendingNotes 扫描抛「all.filter is not a function」，bind 补传全挂
 * （jsdom 内存后端掩盖，真实浏览器由 note-layer E2E 的控制台守卫覆盖）。
 * 这里按 idb-keyval 真实语义桩掉 createStore 验证契约。
 */

/** 桩 IDBRequest：onsuccess 一经赋值即在微任务里触发（真请求的事件语义） */
function fakeRequest<T>(result: T): {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
} {
  const req = {
    result,
    error: null as unknown,
    onsuccess: null as (() => void) | null,
    onerror: null as (() => void) | null,
  };
  Object.defineProperty(req, "onsuccess", {
    set(fn: (() => void) | null) {
      if (typeof fn === "function") queueMicrotask(fn);
    },
    get() {
      return null;
    },
    configurable: true,
  });
  return req;
}

vi.mock("idb-keyval", () => {
  const ALL_KEYS = ["a:1", 42, "a:2", "b:9"];
  // 键值对存（getAll/getAllKeys 同序——真对象存储按键排序遍历）
  const VALUES: Record<string, string> = {
    "a:1": "v1",
    "a:2": "v2",
    "b:9": "v9",
  };
  const inRange = (k: string, range: { lower: string; upper: string }) =>
    k >= range.lower && k <= range.upper;
  return {
    // 按 idb-keyval 真实语义：customStore(mode, cb) = Promise<cb 的返回值>
    createStore: () => (_mode: string, cb: (os: unknown) => unknown) =>
      Promise.resolve().then(() =>
        cb({
          // 模拟真 IDB 的 range 语义：只回 [lower, upper] 内的键/值对
          getAllKeys: (range: { lower: string; upper: string }) =>
            fakeRequest(
              ALL_KEYS.filter(
                (k) => typeof k === "string" && inRange(k, range),
              ),
            ),
          getAll: (range: { lower: string; upper: string }) =>
            fakeRequest(
              ALL_KEYS.filter(
                (k) => typeof k === "string" && inRange(k, range),
              ).map((k) => VALUES[k] ?? null),
            ),
          get: (key: string) => fakeRequest(`value-of-${key}`),
          put: () => fakeRequest(undefined),
          delete: () => fakeRequest(undefined),
          transaction: { oncomplete: null },
        }),
      ),
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("idbKVBackend.keys（真 IDB 语义契约）", () => {
  it("返回键数组（解包 IDBRequest）并保留字符串过滤", async () => {
    // jsdom 无 IndexedDB 全局：IDBKeyRange.bound 桩为区间对象（keys 实现只透传给桩 getAllKeys）
    vi.stubGlobal("IDBKeyRange", {
      bound: (lower: unknown, upper: unknown) => ({ lower, upper }),
    });
    const backend = idbKVBackend("db", "store");
    const keys = await backend.keys("a:");
    expect(keys).toEqual(["a:1", "a:2"]); // 区间下推生效；非字符串键防御过滤；不再抛 filter 错
  });

  it("getAll：单事务取前缀键值对（bind/flush 扫描不逐键 get）", async () => {
    vi.stubGlobal("IDBKeyRange", {
      bound: (lower: unknown, upper: unknown) => ({ lower, upper }),
    });
    const backend = idbKVBackend("db", "store");
    const pairs = await backend.getAll("a:");
    expect(pairs).toEqual([
      ["a:1", "v1"],
      ["a:2", "v2"],
    ]);
  });
});
