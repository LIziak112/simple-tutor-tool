import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerSubmitEventSettler,
  resumeFocusAfterFailedSubmit,
  SUBMIT_EVENT_SETTLE_TIMEOUT_MS,
  type SubmitEventSettler,
  settleEventsBeforeSubmit,
  withinSubmitSettle,
} from "./submit-event-settle";

/**
 * 提交前的事件收口（登记表 + 限时等待）：
 * - 按卷登记、后登记的覆盖先登记的、撤销只撤自己那一次；
 * - 题级提交等收口函数送完事件再往下走，最多等 SUBMIT_EVENT_SETTLE_TIMEOUT_MS；
 * - 没登记、超时、收口失败都不拦提交，也不抛错；
 * - 提交没成时把聚焦接回去。
 */

const cleanups: Array<() => void> = [];

function register(attemptId: string, settler: Partial<SubmitEventSettler>) {
  const full: SubmitEventSettler = {
    settle: settler.settle ?? (async () => undefined),
    resume: settler.resume ?? (() => undefined),
  };
  const unregister = registerSubmitEventSettler(attemptId, full);
  cleanups.push(unregister);
  return unregister;
}

/** 手动放行的 promise */
function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 观察一个 promise 是否已经落定（不等它） */
function watch(promise: Promise<unknown>) {
  const state = { settled: false };
  void promise.then(() => {
    state.settled = true;
  });
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe("settleEventsBeforeSubmit", () => {
  it("没有登记：立即放行", async () => {
    await expect(
      settleEventsBeforeSubmit("no-such-attempt", ["q1"]),
    ).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("把这批题号交给本卷登记的收口函数，等它送完才放行", async () => {
    const sending = deferred();
    const settle = vi.fn(() => sending.promise);
    register("att-1", { settle });
    register("att-other", {
      settle: () => {
        throw new Error("不该调到别的卷");
      },
    });

    const state = watch(settleEventsBeforeSubmit("att-1", ["q1", "q2"]));
    await vi.advanceTimersByTimeAsync(SUBMIT_EVENT_SETTLE_TIMEOUT_MS - 1);
    expect(settle).toHaveBeenCalledExactlyOnceWith(["q1", "q2"]);
    expect(state.settled).toBe(false);

    sending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.settled).toBe(true);
    // 提前送完：限时用的定时器已清掉
    expect(vi.getTimerCount()).toBe(0);
  });

  it("事件一直送不出去：等满上限后放行，不拦提交", async () => {
    register("att-1", { settle: () => new Promise<void>(() => undefined) });
    const state = watch(settleEventsBeforeSubmit("att-1", ["q1"]));
    await vi.advanceTimersByTimeAsync(SUBMIT_EVENT_SETTLE_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
  });

  it("收口函数失败（同步抛错或异步拒绝）：照样放行，不抛错", async () => {
    register("att-throw", {
      settle: () => {
        throw new Error("埋点坏了");
      },
    });
    await expect(
      settleEventsBeforeSubmit("att-throw", ["q1"]),
    ).resolves.toBeUndefined();

    register("att-reject", {
      settle: () => Promise.reject(new Error("网络断了")),
    });
    await expect(
      settleEventsBeforeSubmit("att-reject", ["q1"]),
    ).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("registerSubmitEventSettler", () => {
  it("同一份卷后登记的生效；先登记的撤销时不动后登记的", async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const unregisterFirst = register("att-1", { settle: first });
    const unregisterSecond = register("att-1", { settle: second });

    await settleEventsBeforeSubmit("att-1", ["q1"]);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    // 页面重挂载时旧实例的清理晚于新实例的登记
    unregisterFirst();
    await settleEventsBeforeSubmit("att-1", ["q1"]);
    expect(second).toHaveBeenCalledTimes(2);

    unregisterSecond();
    await settleEventsBeforeSubmit("att-1", ["q1"]);
    expect(second).toHaveBeenCalledTimes(2);
  });
});

describe("resumeFocusAfterFailedSubmit", () => {
  it("调到本卷登记的接回函数；没登记或接回函数抛错都不出错", () => {
    const resume = vi.fn();
    register("att-1", { resume });
    resumeFocusAfterFailedSubmit("att-1");
    expect(resume).toHaveBeenCalledTimes(1);

    expect(() => resumeFocusAfterFailedSubmit("no-such-attempt")).not.toThrow();

    register("att-throw", {
      resume: () => {
        throw new Error("埋点坏了");
      },
    });
    expect(() => resumeFocusAfterFailedSubmit("att-throw")).not.toThrow();
  });
});

describe("withinSubmitSettle", () => {
  it("可指定上限；在途的收口之后再失败也不产生未处理的拒绝", async () => {
    const sending = deferred();
    const state = watch(withinSubmitSettle(sending.promise, 100));
    await vi.advanceTimersByTimeAsync(100);
    expect(state.settled).toBe(true);
    sending.reject(new Error("超时之后才失败"));
    await vi.advanceTimersByTimeAsync(0);
  });
});
