import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LazyMountWindow } from "./lazy-mount-window";

/**
 * 窗口化虚拟列表控制器单测（性能第三步，2026-10-28）：
 * 挂载调度（滚动静默、就近优先、逐卡宏任务、一张不丢）、窗口化卸载
 * （实测高度回填、守卫命中不卸）、forceMount 直挂、无 IO 环境退化。
 * 时钟注入 Date.now——vitest 假计时器默认伪造 Date，随 advance 同步走。
 */

type Entry = { target: Element; isIntersecting: boolean };
type ObserverCallback = (entries: Entry[]) => void;

class FakeObserver {
  static instances: FakeObserver[] = [];
  callback: ObserverCallback;
  options: IntersectionObserverInit;
  observed = new Set<Element>();
  constructor(
    callback: ObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.callback = callback;
    this.options = options;
    FakeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.observed.add(target);
  }
  unobserve(target: Element) {
    this.observed.delete(target);
  }
  disconnect() {
    this.observed.clear();
  }
  /** 按记录的 rootMargin 找到对应观察器并触发回调。 */
  static byMargin(margin: string | undefined): FakeObserver {
    const found = FakeObserver.instances.find(
      (instance) => instance.options.rootMargin === margin,
    );
    if (found === undefined) throw new Error(`no observer for ${margin}`);
    return found;
  }
}

const MOUNT_MARGIN = "50% 0px 100% 0px";
const UNLOAD_MARGIN = "250% 0px 250% 0px";

function makeLi(
  id: string,
  rect: { top: number; height: number },
): HTMLLIElement {
  const element = document.createElement("li");
  element.dataset.id = id;
  element.getBoundingClientRect = () =>
    ({
      top: rect.top,
      bottom: rect.top + rect.height,
      height: rect.height,
      width: 390,
      left: 0,
      right: 390,
      x: 0,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
  return element;
}

function makeWindow(retain?: (id: string) => boolean): LazyMountWindow {
  FakeObserver.instances = [];
  return new LazyMountWindow({
    now: () => Date.now(),
    ...(retain ? { retain } : {}),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LazyMountWindow 挂载调度", () => {
  it("进视口请求按「离视口距离」就近优先逐卡挂载", async () => {
    const instance = makeWindow();
    const far = makeLi("far", { top: 2000, height: 500 });
    const near = makeLi("near", { top: 300, height: 500 });
    instance.attach("far", far);
    instance.attach("near", near);
    expect(instance.isMounted("far")).toBe(false);

    FakeObserver.byMargin(MOUNT_MARGIN).callback([
      { target: far, isIntersecting: true },
      { target: near, isIntersecting: true },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    // 近的先挂；远卡等下一个宏任务（逐卡挂载，卡片间留绘制机会）
    expect(instance.isMounted("near")).toBe(true);
    expect(instance.isMounted("far")).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(instance.isMounted("far")).toBe(true);
    instance.dispose();
  });

  it("滚动中不挂载：请求退回队列，静默后恢复且一张不丢", async () => {
    const instance = makeWindow();
    const first = makeLi("a", { top: 300, height: 500 });
    const second = makeLi("b", { top: 700, height: 500 });
    instance.attach("a", first);
    instance.attach("b", second);
    // 滚动进行中（150ms 内有 scroll 事件）触发进视口
    instance.noteScroll();
    FakeObserver.byMargin(MOUNT_MARGIN).callback([
      { target: first, isIntersecting: true },
      { target: second, isIntersecting: true },
    ]);
    await vi.advanceTimersByTimeAsync(10);
    expect(instance.isMounted("a")).toBe(false);
    expect(instance.isMounted("b")).toBe(false);
    // 静默 150ms 后全部挂载，一张不丢
    await vi.advanceTimersByTimeAsync(200);
    expect(instance.isMounted("a")).toBe(true);
    expect(instance.isMounted("b")).toBe(true);
    instance.dispose();
  });

  it("滚动恢复挂载后再滚动，新请求继续退避、老请求不丢", async () => {
    const instance = makeWindow();
    const first = makeLi("a", { top: 300, height: 500 });
    instance.attach("a", first);
    FakeObserver.byMargin(MOUNT_MARGIN).callback([
      { target: first, isIntersecting: true },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.isMounted("a")).toBe(true);
    // 新的一轮：滚动中进视口的请求退避
    const second = makeLi("b", { top: 900, height: 500 });
    instance.attach("b", second);
    instance.noteScroll();
    FakeObserver.byMargin(MOUNT_MARGIN).callback([
      { target: second, isIntersecting: true },
    ]);
    await vi.advanceTimersByTimeAsync(10);
    expect(instance.isMounted("b")).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(instance.isMounted("b")).toBe(true);
    instance.dispose();
  });

  it("forceMount 跳过队列立即挂载", () => {
    const instance = makeWindow();
    const li = makeLi("q", { top: 5000, height: 500 });
    instance.attach("q", li);
    instance.forceMount("q");
    expect(instance.isMounted("q")).toBe(true);
    instance.dispose();
  });
});

describe("LazyMountWindow 窗口化卸载", () => {
  it("完全离开卸载窗口后卸载，实测高度回填占位", async () => {
    const instance = makeWindow();
    const li = makeLi("q", { top: 300, height: 500 });
    const card = document.createElement("div");
    card.getBoundingClientRect = () => ({ height: 623 }) as DOMRect;
    li.appendChild(card);
    instance.attach("q", li);
    FakeObserver.byMargin(MOUNT_MARGIN).callback([
      { target: li, isIntersecting: true },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.isMounted("q")).toBe(true);

    li.getBoundingClientRect = () =>
      ({ top: -20000, bottom: -19500, height: 500 }) as DOMRect;
    FakeObserver.byMargin(UNLOAD_MARGIN).callback([
      { target: li, isIntersecting: false },
    ]);
    await vi.advanceTimersByTimeAsync(200);
    expect(instance.isMounted("q")).toBe(false);
    expect(instance.measuredHeight("q")).toBe(623);
    instance.dispose();
  });

  it("守卫命中不卸载，守卫解除后下一轮自动收口", async () => {
    let locked = true;
    const instance = makeWindow((id) => locked && id === "q");
    const li = makeLi("q", { top: 300, height: 500 });
    const card = document.createElement("div");
    card.getBoundingClientRect = () => ({ height: 400 }) as DOMRect;
    li.appendChild(card);
    instance.attach("q", li);
    FakeObserver.byMargin(MOUNT_MARGIN).callback([
      { target: li, isIntersecting: true },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    li.getBoundingClientRect = () =>
      ({ top: -20000, bottom: -19500, height: 500 }) as DOMRect;
    FakeObserver.byMargin(UNLOAD_MARGIN).callback([
      { target: li, isIntersecting: false },
    ]);
    await vi.advanceTimersByTimeAsync(500);
    expect(instance.isMounted("q")).toBe(true);
    locked = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(instance.isMounted("q")).toBe(false);
    expect(instance.measuredHeight("q")).toBe(400);
    instance.dispose();
  });
});

describe("LazyMountWindow 结算与退化", () => {
  it("挂载与卸载都触发 onSettle（挂载版本号驱动重捕）", async () => {
    const onSettle = vi.fn();
    FakeObserver.instances = [];
    const instance = new LazyMountWindow({
      now: () => Date.now(),
      onSettle,
    });
    const li = makeLi("q", { top: 300, height: 500 });
    const card = document.createElement("div");
    card.getBoundingClientRect = () => ({ height: 400 }) as DOMRect;
    li.appendChild(card);
    instance.attach("q", li);
    FakeObserver.byMargin(MOUNT_MARGIN).callback([
      { target: li, isIntersecting: true },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onSettle).toHaveBeenCalled();
    onSettle.mockClear();
    li.getBoundingClientRect = () =>
      ({ top: -20000, bottom: -19500, height: 500 }) as DOMRect;
    FakeObserver.byMargin(UNLOAD_MARGIN).callback([
      { target: li, isIntersecting: false },
    ]);
    await vi.advanceTimersByTimeAsync(200);
    expect(onSettle).toHaveBeenCalled();
    instance.dispose();
  });

  it("无 IntersectionObserver 环境退化为进页即挂载", () => {
    vi.unstubAllGlobals();
    FakeObserver.instances = [];
    const instance = makeWindow();
    instance.attach("q", makeLi("q", { top: 300, height: 500 }));
    expect(instance.isMounted("q")).toBe(true);
    instance.dispose();
  });

  it("subscribe 通知行重渲染；退订后不再通知；dispose 后不再挂载", async () => {
    const instance = makeWindow();
    const listener = vi.fn();
    const unsubscribe = instance.subscribe("q", listener);
    const li = makeLi("q", { top: 300, height: 500 });
    instance.attach("q", li);
    FakeObserver.byMargin(MOUNT_MARGIN).callback([
      { target: li, isIntersecting: true },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    const other = vi.fn();
    instance.subscribe("other", other);
    instance.forceMount("other");
    expect(other).toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
    instance.dispose();
    instance.forceMount("q3");
    expect(instance.isMounted("q3")).toBe(false);
  });
});
